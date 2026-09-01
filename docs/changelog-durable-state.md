# Durable state & multi-instance live HA

This document describes the durability and high-availability features added to the ChatGPT Terminal Plugin MCP server.

## Summary

| Concern | Previous | Now |
| --- | --- | --- |
| Device registry | JSON file + in-memory map | **SQLite** (WAL), with automatic JSON migration |
| Live sessions / agent presence | Process-local only | **Optional Redis** shared store (`REDIS_URL`) |
| Cross-replica terminal commands | Not supported | **Redis pub/sub** command routing to the instance that owns the agent WebSocket |

## 1. SQLite device registry

### Motivation

The enrollment registry is a durability boundary: device public keys, owner binding, key version, and revocation must survive process restarts and be safe under concurrent updates.

### Implementation

- Module: `packages/mcp-server/src/db.ts`
- Storage backend: Node.js built-in `node:sqlite` (`DatabaseSync`)
- Path resolution via `AGENT_DEVICE_REGISTRY_PATH`:
  - `…/devices.sqlite` or `…/devices.db` → used as-is
  - `…/devices.json` → durable file is `…/devices.sqlite` (JSON is migrated once)
- Schema: `devices` table + `meta.schema_version`, indexes on `owner_id`, `status`, `agent_id`
- PRAGMAs: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`
- File mode: best-effort `0600` on the database (and WAL/SHM sidecars when present)

### Migration

On first open of an empty SQLite DB, if a legacy JSON registry exists at the configured path (or sibling JSON path), records are imported in a transaction. Version-1 JSON records receive a derived immutable `agent_id`. The JSON file is rewritten as version 2 for operators who still inspect it; **SQLite is the source of truth** thereafter.

### API surface (unchanged for callers)

`DeviceRegistry.load`, `enroll`, `enrollLocalAdmin`, `revoke`, `markSeen`, `verifyProof`, `requireActive` behave as before. New helpers:

- `databasePath` — absolute SQLite path when durable
- `listByOwner(ownerId)` — query enrolled devices for an owner
- `close()` — close the SQLite handle (called from HTTP runtime shutdown)

### Configuration

```bash
AGENT_DEVICE_REGISTRY_PATH=/var/lib/chatgpt-terminal/devices.sqlite
# Legacy still accepted and auto-migrated:
# AGENT_DEVICE_REGISTRY_PATH=/var/lib/chatgpt-terminal/devices.json
```

See also `deploy/server-environment.example` and `docs/deployment.md` (rollback notes for `.sqlite` + `-wal`/`-shm`).

## 2. Live store (sessions, presence, HA routing)

### Motivation

Agent WebSockets and terminal event buffers historically lived only in one MCP process. Load-balancing HTTP `/mcp` across replicas broke `terminal_*` tools whenever the agent socket was on another instance.

### Abstraction

`packages/mcp-server/src/live-store.ts` defines `LiveStore`:

- Session get/put/delete and owner session listing
- Agent presence (online, owner, device, **instanceId**)
- Session event publish / subscribe (fan-out for waiters/SSE)
- Cross-instance agent command request + local command handler registration

### Backends

1. **`MemoryLiveStore`** (default)  
   Single-process behavior equivalent to the previous in-memory maps. No external dependency.

2. **`RedisLiveStore`** (when `REDIS_URL` is set)  
   Uses the `redis` package. Keys are namespaced under `term:`. Session and presence records use TTL (default 24h, refreshed on write). Pub/sub channels carry:
   - session event notifications
   - commands addressed to a specific gateway `instanceId`
   - per-request response channels

### Gateway integration

`AgentGateway` dual-writes session records to the live store, publishes presence on agent register/disconnect, and routes commands through `dispatchAgentCommand`:

1. If the agent WebSocket is local → send on the socket (unchanged hot path).
2. Else if presence shows another online instance → Redis command forward + await response.
3. Else → `AGENT_OFFLINE` (retryable).

Agent **WebSockets remain process-local**. Redis does not move sockets; it records which instance owns them and forwards MCP commands accordingly. Sticky WebSocket routing at the load balancer is still recommended.

### Configuration

```bash
# Optional — omit for single-process memory backend
REDIS_URL=redis://127.0.0.1:6379
```

Dependency: `redis` on `@terminal/mcp-server` (`pnpm install` after upgrade).

## 3. Testing

- `tests/unit/device-auth.test.ts` — SQLite path modes, JSON→SQLite migration reload, persistence across `close()`/`load()`
- `tests/unit/live-store.test.ts` — memory presence, session index, event fan-out, local command routing

## 4. Operational guidance

- **Single replica:** leave `REDIS_URL` unset; rely on SQLite for enrollment durability.
- **Multiple MCP replicas:** set the same `REDIS_URL` on every process; ensure agents can reconnect after instance failure; prefer sticky routing for `/agent` WebSockets.
- **Backups:** back up `devices.sqlite` after a clean shutdown (include WAL/SHM if the process is still running).
- **Secrets:** registry and Redis should not be exposed on the public internet; bind Redis to private network/TLS as appropriate for your environment.

## 5. Non-goals (this change)

- Kernel-level shell sandboxing for PTY commands
- Moving active WebSocket connections between processes without reconnect
- Distributed MCP Streamable HTTP session affinity beyond Redis-backed terminal state
- Automatic Redis Cluster topology management
