# ChatGPT Terminal Plugin

Production-oriented MCP terminal bridge that lets an authenticated MCP client select an enrolled local computer, open a persistent PTY, execute multiple commands while preserving shell state, read bounded output through MCP cursors, and render a live xterm.js terminal through an MCP App resource.

## Architecture

```text
ChatGPT / MCP client
        |
        | OAuth bearer + MCP Streamable HTTP
        v
Public MCP server  <---->  MCP App terminal UI
        |                    ^
        |                    | short-lived read-only SSE capability
        |                    |
        +---- terminal event store / audit / transcript
        |
        | authenticated WebSocket, Ed25519 challenge-response
        v
Local terminal agent
        |
        v
     node-pty
        |
        v
bash / zsh / PowerShell / configured WSL shell
```

The model-visible and UI-visible output paths are deliberately separate:

- `terminal_read` is authoritative for model context. It is bounded by `max_bytes` and monotonic cursors.
- The MCP App uses a short-lived, session-bound stream capability and SSE for live display. It enforces contiguous sequence delivery, ignores duplicate events, and refreshes the capability on expiry/error/gap. The user's MCP OAuth bearer token is never sent to the browser widget.

## Packages

- `packages/protocol` — shared Zod schemas, events, errors, cursors, gateway messages.
- `packages/local-agent` — device identity, outbound gateway connection, PTY lifecycle, workspace enforcement.
- `packages/mcp-server` — OAuth/JWT verification, MCP tools, device registry, gateway, SSE, audit and transcript handling.
- `packages/terminal-ui` — static-first vanilla MCP App, lightweight responsive watch-only terminal UI.
- `tests/unit` — PTY, device security, authorization, lifecycle, redaction and UI tests.
- `tests/e2e` — actual MCP v2 client → server → signed agent → real PTY acceptance test.

## Requirements

- Node.js 22 or newer.
- pnpm 10.15.0 through Corepack.
- A supported local shell. Linux/macOS commonly use `bash`/`zsh`; Windows agents may configure PowerShell or WSL.
- For production: HTTPS/WSS termination and an OAuth 2.1-compatible authorization server whose access tokens can be validated using JWKS.

`node-pty` is a native dependency. pnpm is configured to permit only the required native build scripts for `node-pty` and `esbuild`.

## Install and verify

```bash
corepack enable
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

## Local development

Use `deploy/server-environment.example` and `deploy/local-agent-environment.example` as environment-specific templates, store real secrets outside Git with owner-only permissions, and replace every example value.

Start the development processes with:

```bash
pnpm dev
```

For the server, configure at minimum a public MCP URL and development bearer token. For the agent, configure the gateway URL, an allowed workspace root, and enrollment values for the first device enrollment.

The local agent creates a persistent Ed25519 identity on first run. Its private key is stored owner-only. Device enrollment sends only the public key to the server registry. Subsequent gateway connections use an expiring one-time challenge signed by that private key.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `terminal_list_agents` | List enrolled online computers visible to the authenticated user. |
| `terminal_start` | Start a persistent PTY and return the initial cursor/output. |
| `terminal_read` | Read bounded terminal events after a cursor. |
| `terminal_write` | Write terminal input/commands. |
| `terminal_resize` | Resize the PTY. |
| `terminal_interrupt` | Send Ctrl+C/SIGINT. |
| `terminal_status` | Return session and agent connection state. |
| `terminal_stream_refresh` | Issue a new short-lived UI stream capability. |
| `terminal_close` | Terminate and dispose the PTY. |

## Execution profiles

The server and agent enforce profiles independently.

- `read-only` — MCP discovery/read/status operations only; PTY creation and mutations are rejected server-side. The agent also rejects terminal creation under this profile.
- `developer` — PTY creation is allowed only when the requested launch directory canonically resolves under a configured workspace root. This is a launch-path boundary, not a kernel/filesystem sandbox; commands subsequently run with the agent OS user's normal permissions.
- `owner-full` — terminal execution is allowed without the launch-root restriction on the agent. OS-level elevation remains subject to the local operating system and shell configuration.

JWT access tokens may carry an `execution_profile` claim. If absent, the server uses `MCP_DEFAULT_EXECUTION_PROFILE`. The effective session profile is the more restrictive of the authenticated server profile and local agent profile.

## Device enrollment and rotation

Each computer has its own stable `device_id`, stable `agent_id`, and Ed25519 key pair. Enrollment binds the device ID, agent ID, owner, and public key; key rotation cannot silently rebind the device to a different owner or agent. Do not share one permanent agent secret across machines.

Initial enrollment and administrative rotation use the configured enrollment endpoint and bootstrap enrollment token. The public key is persisted server-side; the private key never leaves the machine.

Set `AGENT_ROTATE_KEY=1` for one agent launch while also supplying enrollment settings. The stable device ID is retained while the key pair changes and the server increments its key version. Revoke a device through the administrative revocation endpoint described in `docs/security.md`.

## Production deployment

Read `docs/deployment.md` before production use. Important constraints:

- `MCP_PUBLIC_URL` must be HTTPS in production.
- Production MCP authentication must use JWT/JWKS mode.
- The current gateway/session/event state is process-local. File-backed device registry and transcript/audit storage are durable, but no distributed live-state backend is implemented.
- Therefore run one active MCP/gateway process per deployment unless you add shared routing/state semantics. Multi-replica HA is not claimed by this version.

Reverse-proxy and systemd examples are under `deploy/`.

## Documentation

- `docs/architecture.md`
- `docs/protocol.md`
- `docs/security.md`
- `docs/deployment.md`
- `docs/chatgpt-integration.md`

## Acceptance test

`tests/e2e/terminal.e2e.test.ts` uses the actual MCP v2 client transport, real HTTP authentication, device enrollment, Ed25519 gateway authentication, a real `node-pty` shell, bounded MCP reads, shell-state preservation, interrupt, stream-token refresh, an actual HTTP SSE connection receiving live `terminal.stdout` bytes, cleanup and transcript verification.

The repository can validate the MCP App bundle and bridge behavior locally. Rendering inside the official ChatGPT host still requires connection from ChatGPT web to a remote HTTPS endpoint (or a supported Secure MCP Tunnel deployment); that host-level check cannot be simulated by the local test suite. See `docs/chatgpt-integration.md`.
