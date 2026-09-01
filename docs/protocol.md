# Terminal Protocol

## Event model

Terminal output and control changes are represented as `TerminalEvent` records:

```text
event_id
session_id
sequence
timestamp
actor
event_type
data
```

`sequence` is monotonically increasing within one terminal session. Consumers resume from the last sequence they have processed. Event IDs identify individual records; cursors are sequence numbers.

Supported event types:

- `session.started`
- `session.closed`
- `command.input`
- `terminal.stdout`
- `terminal.stderr`
- `terminal.resize`
- `terminal.signal`
- `cwd.changed`
- `process.exit`
- `agent.connected`
- `agent.disconnected`
- `error`

The current PTY implementation records terminal byte-stream data as stdout events because PTYs generally expose the combined terminal stream rather than independent child stdout/stderr pipes.

## MCP read cursors

`terminal_read` accepts:

```text
session_id
next event cursor in `after`
optional max_bytes
optional wait_ms
```

The effective byte limit is capped by server configuration regardless of the caller value. The result includes:

```text
output
events
next_cursor
has_more
status
exit_code
```

The server rejects:

- cursors older than retained history: `INVALID_CURSOR`
- cursors ahead of the current stream: `INVALID_CURSOR`
- an individual event too large for the requested read: `OUTPUT_LIMIT_REACHED`

Long-running commands stay attached to the PTY. The model repeatedly calls `terminal_read`; the server does not wait for the process to finish before returning control.

## Agent gateway authentication

An agent WebSocket starts unauthenticated.

Server:

```json
{
  "type": "auth.challenge",
  "nonce": "uuid",
  "issued_at": "RFC3339",
  "expires_at": "RFC3339"
}
```

Agent signs the canonical payload:

```text
terminal-gateway-v1
<device_id>
<nonce>
<issued_at>
```

Agent:

```json
{
  "type": "auth.proof",
  "device_id": "device-...",
  "nonce": "...",
  "issued_at": "...",
  "signature": "base64url-ed25519-signature"
}
```

The server validates device enrollment, expiry, exact challenge fields, Ed25519 signature and one-time nonce use. It then emits `auth.accepted`. Registration and terminal traffic before successful authentication are rejected.

## Gateway replay and flow control

After authentication the agent sends:

- `agent.register`
- `agent.resume` with current local PTY snapshots (`session`, current `cursor`, and `earliestCursor`)

The server validates resumed owner/agent/profile identity and reconciles its retained boundary with the agent snapshot. If the agent has already evicted history the server does not invent continuity: it advances the earliest retained cursor so older MCP/UI cursors fail with `INVALID_CURSOR`. The server then returns `agent.resume.ack` with its authoritative sequence per session, and the agent pumps events after that sequence.

Events must arrive contiguously after the server's retained cursor. Exact duplicate events are idempotently acknowledged; a repeated sequence with different content, an in-range historical inconsistency, or a forward sequence gap is rejected as an invalid gateway stream.

Each accepted terminal event receives:

```json
{
  "type": "ack",
  "session_id": "...",
  "sequence": 123
}
```

The agent limits the number of sent-but-unacknowledged events with `AGENT_MAX_INFLIGHT_EVENTS`. Local output history is bounded by `TERMINAL_BUFFER_HIGH_WATER_BYTES`. Control messages also use a bounded queue.

If the gateway is temporarily unavailable, PTY output continues to accumulate only up to the configured local retention limit. On reconnect the server cursor and agent `earliestCursor` determine the replay boundary. This prevents indefinite buffering while preserving resumability within retained history and explicitly invalidating cursors that reference evicted output.

## MCP terminal operations

### `terminal_list_agents`

No input. Returns only devices owned by the authenticated user and their current connection state.

### `terminal_start`

Inputs:

```text
agent_id
optional cwd
optional shell
optional command
cols
rows
```

Returns the session identifier, state, initial server-authoritative cursor and initial bounded output. The authenticated execution profile is propagated to the agent; the session records the more restrictive of that profile and the local agent profile. The ChatGPT/UI-facing tool result additionally includes terminal metadata and a short-lived stream capability only in result `_meta`.

### `terminal_write`

Writes terminal text exactly as supplied after schema/authorization checks. The persistent PTY maintains shell state between calls.

### `terminal_resize`

Changes PTY columns/rows and records a resize event.

### `terminal_interrupt`

Writes terminal Ctrl+C, producing a terminal signal event. On POSIX interactive shells this corresponds to the terminal's SIGINT behavior.

### `terminal_status`

Returns session metadata, cursor and whether the agent is currently connected.

### `terminal_stream_refresh`

Accepts `session_id` and `after`. The caller must own the session and the cursor must be in the retained range. A new session-specific capability URL is returned only through MCP result metadata. The corresponding SSE response is terminated server-side when the capability expires. The UI closes a failed/expired EventSource instead of allowing native retry against the same stale URL, then requests a new capability from its last contiguous accepted sequence. Duplicate/stale events are ignored; a sequence gap forces resynchronization.

### `terminal_close`

Kills and disposes the PTY and records `session.closed`. Final session metadata and retained events remain readable for the configured `TERMINAL_CLOSED_SESSION_RETENTION_MS` post-mortem window. After that window, both local-agent and server in-memory records are removed and later operations return `SESSION_NOT_FOUND`.

## Structured errors

The protocol exposes stable codes including:

- `AGENT_OFFLINE`
- `SESSION_NOT_FOUND`
- `SESSION_CLOSED`
- `INVALID_CURSOR`
- `PATH_NOT_ALLOWED`
- `PERMISSION_DENIED`
- `PTY_CREATE_FAILED`
- `AGENT_TIMEOUT`
- `OUTPUT_LIMIT_REACHED`
- `STREAM_TOKEN_EXPIRED`
- `SESSION_LIMIT_REACHED` (only when a non-zero session quota is explicitly configured)
- `INVALID_ARGUMENT`

MCP tool errors return concise model-visible text and a structured terminal error in result metadata without exposing internal stack traces.
