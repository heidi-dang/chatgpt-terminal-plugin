# Architecture

## Components

### MCP server

The public server is the only MCP endpoint a remote MCP client needs. It provides stateful MCP Streamable HTTP at `/mcp`, validates bearer tokens, derives the user and execution profile from validated authentication context, routes terminal operations to enrolled agents, holds bounded terminal event buffers, serves the MCP App resource, and exposes short-lived terminal SSE streams.

### Local agent

The local agent initiates an outbound WebSocket connection. No inbound SSH or shell port is required. The agent owns the PTY and enforces launch-directory workspace policy. A stable local device/agent identity has a replaceable Ed25519 key pair. Enrollment binds the device ID to that agent ID and owner. The agent signs server-issued challenges before the gateway accepts any registration or terminal traffic.

### Terminal UI

The UI is a single-file, static-first vanilla MCP App resource at `ui://terminal/v11.html`. Its HTML contains a visible watch-only terminal shell before JavaScript executes, so a host/WebView runtime failure cannot degrade into an empty card. A minimal JSON-RPC MCP Apps bridge progressively attaches the initial `terminal_start` result and the short-lived ordered terminal SSE capability. Direct SSE is the preferred transport; if the host WebView cannot establish `EventSource`, the widget falls back to bounded `terminal_read` long-polling through the MCP Apps bridge while continuing background SSE recovery. Stdout/stderr chunks from either transport are sequence-validated immediately and coalesced into at most one DOM append per animation frame. The widget accepts no keyboard input and exposes no terminal-control toolbar; ChatGPT remains the actor that writes, interrupts and closes sessions. The bridge handles app-only stream refresh/status recovery, host context, graceful teardown, and size notifications. A separate `/terminal-ui/reload` SSE channel performs CSS-only hot reload; the application document is never replaced.

### Shared protocol

The protocol package defines the runtime schemas exchanged by server, gateway and agent. Every terminal event has a positive monotonic sequence number. Cursor semantics use the last acknowledged/consumed sequence.

## Terminal data flow

```text
MCP terminal_write
  -> server authorization
  -> server gateway request
  -> authenticated agent WebSocket
  -> PTY write
  -> PTY output
  -> local retained event buffer
  -> sequence-window pump
  -> gateway event
  -> server retained event buffer
  -> ACK to agent
  -> terminal_read for model
  -> SSE for UI
```

The server ACK is not permission to discard arbitrary history immediately. The agent keeps events in a bounded retained buffer so unacknowledged output can be replayed after a temporary disconnection. If a caller asks for an event cursor older than the retained range, the protocol returns `INVALID_CURSOR` rather than fabricating continuity.

## Reconnection

### Agent

1. Establish outbound WebSocket.
2. Receive an expiring challenge.
3. Sign the challenge with the machine's Ed25519 private key.
4. Receive `auth.accepted`.
5. Register agent metadata and advertise active PTY snapshots including current and earliest retained cursors.
6. The server reconciles its retained cursor boundary with each snapshot and returns `agent.resume.ack`.
7. Replay terminal events after those authoritative server cursors, within the configured in-flight window. If older agent history was evicted during a disconnect, the server advances its earliest retained boundary so stale MCP/UI cursors fail explicitly with `INVALID_CURSOR`.

### UI

The widget tracks the most recent accepted event sequence and accepts only the next contiguous sequence. Duplicate/stale events are ignored. A forward gap, malformed frame, EventSource failure, explicit reconnect, or approaching capability expiry closes the old source and obtains a fresh capability through `terminal_stream_refresh(session_id, after)` via the MCP Apps bridge. Native EventSource retry is therefore never allowed to keep reusing an expired capability URL. If the requested cursor has already fallen behind retained history, the widget obtains `terminal_status`, advances to the authoritative server cursor, visibly marks the lost-output gap, and resumes from there.

## State ownership

- PTY process and shell state: local agent.
- Device private key: local machine only.
- Device public identity and immutable device→agent→owner binding: server device registry.
- Live agent connections and terminal routing: server process memory.
- Bounded terminal event history: agent and server process memory. Final session metadata/history remains available only for `TERMINAL_CLOSED_SESSION_RETENTION_MS`, then both sides release it.
- Audit metadata/transcript: optional append-only local files with redaction and transcript retention pruning.
- Authenticated user identity: either origin-validated OAuth JWT, or a Cloudflare Access assertion produced after Managed OAuth; both are signature/issuer/audience validated at the MCP origin.

No distributed live-state backend is implemented or configured in this version. Multi-replica gateway HA therefore requires future shared-state/event-bus work or explicit sticky/single-owner routing.

## Session lifecycle

Terminal states are:

- `creating`
- `running`
- `waiting`
- `disconnected`
- `exited`
- `closed`
- `failed`

The local agent enforces idle timeout and maximum session lifetime. Explicit closure, idle expiry, lifetime expiry, or agent shutdown terminate the PTY and produce a `session.closed` event. A process that exits naturally produces `process.exit` with its exit code.

## Trust boundaries

1. MCP client → authentication boundary → MCP server: either direct OAuth bearer validation (`jwt`) or Cloudflare Managed OAuth followed by origin validation of `Cf-Access-Jwt-Assertion` (`cloudflare-access`); then user/profile extraction and ownership checks.
2. MCP server → user terminal session: server ownership checks and execution-profile authorization.
3. Server gateway → local machine: enrolled-device Ed25519 challenge-response.
4. Local agent → filesystem/processes: the more restrictive server/local execution profile, canonical launch-directory roots, stripped control-plane secrets, and the host OS user's normal permissions. Workspace roots do not constitute a general shell sandbox.
5. Browser widget → stream: short-lived terminal stream capability only; no MCP OAuth bearer token.
