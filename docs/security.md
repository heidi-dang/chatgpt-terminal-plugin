# Security Model

This project deliberately treats terminal execution as a high-impact capability. Tool annotations describe that risk to MCP hosts, but security enforcement occurs independently on the MCP server and local agent.

## Authentication layers

### MCP client authentication

Production supports two validated JWT trust paths:

- `jwt`: the MCP origin validates the OAuth bearer JWT against configured issuer/JWKS/audience and exposes protected-resource/authorization metadata for the external authorization server.
- `cloudflare-access`: Cloudflare Access Managed OAuth terminates the client-facing OAuth flow and forwards a signed Access JWT in `Cf-Access-Jwt-Assertion`; the origin validates that assertion against the configured issuer/JWKS/audience and does not trust the client's opaque Managed OAuth bearer token directly.

The validated identity derives the configured owner claim (`sub` by default, or `email` for deployments that explicitly select it), client context when available, scopes, and the optional `execution_profile`. In Cloudflare Managed OAuth mode the resolved Access assertion may not identify the dynamically registered OAuth client, so the server uses a provider-scoped client context while retaining strict user/session ownership checks.

If `execution_profile` is absent, `MCP_DEFAULT_EXECUTION_PROFILE` is used. Invalid issuer, audience, signature, expiry, or required owner identity is rejected before terminal operations. Cloudflare mode also rejects requests that reach the origin without `Cf-Access-Jwt-Assertion`, preventing a direct-to-origin request from bypassing Access by supplying an arbitrary Bearer header.

### Device authentication

Enrollment is a bootstrap administrative operation. Each machine creates a local Ed25519 key pair, stable device ID, and stable agent ID. Enrollment binds the device ID, agent ID, owner association, and public key on the server in a durable SQLite registry (WAL mode). Legacy JSON registry paths are accepted and migrated once into SQLite. The private key remains in an owner-only local identity file.

Every gateway connection requires a new expiring challenge. The signed challenge includes the device ID, random nonce and issue time. Nonces are one-time and replay is rejected. The test suite verifies that replaying an accepted proof causes a policy close.

## Enrollment administration

Default endpoints are:

```text
POST /agent/enroll
POST /agent/enroll/revoke
```

Enrollment and revocation require `X-Terminal-Enrollment-Token`. Treat that bootstrap token as an administrator secret, not as the ongoing device credential.

Enrollment payload:

```json
{
  "device_id": "device-...",
  "agent_id": "agent-...",
  "owner_id": "authenticated-user-id",
  "public_key": "-----BEGIN PUBLIC KEY-----...",
  "display_name": "optional label"
}
```

The server rejects attempts to move an existing device to a different owner or rebind it to a different agent ID. Re-enrolling the same device/agent ID for the same owner rotates its public key and increments `key_version`. Registry version 1 is migrated to version 2 with the historical device→agent mapping.

Revocation payload:

```json
{
  "device_id": "device-..."
}
```

Revocation persists the revoked state and disconnects a currently connected device.

## Execution profiles

### `read-only`

The MCP server permits discovery/read/status functions but rejects PTY creation and all terminal mutations before they reach the gateway. The agent also refuses PTY creation under a read-only local profile.

### `developer`

Terminal mutations are allowed, but the local agent canonicalizes the requested launch directory (including symlink resolution) and requires it to remain within configured allowed workspace roots. Relative traversal and symlink escapes are rejected.

This is a PTY **launch-directory** policy, not a general filesystem sandbox. After the shell starts, commands execute with the agent OS user's normal permissions and can navigate/access anything that user can access. Use a dedicated OS user, container/VM, or OS mandatory-access controls when stronger containment is required.

### `owner-full`

The local workspace-root restriction is disabled. This does not bypass operating-system permissions. `sudo`, UAC/elevation and similar facilities remain governed by the host OS and shell configuration.

The authenticated server profile is sent in the signed-agent command path. The local agent computes the effective session profile as the more restrictive of the server-requested profile and its local profile; a locally configured `owner-full` agent therefore cannot elevate a `developer` or `read-only` MCP principal.

## Browser stream capabilities

The MCP App never receives the user's OAuth bearer token. `terminal_start` and `terminal_stream_refresh` issue a separate HMAC-protected stream token with:

- authenticated user subject
- one terminal session ID
- read-only stream scope
- short expiry
- unique token identifier used for revocation

The stream token is carried in the terminal SSE URL returned through MCP result `_meta`, not in model-visible structured output.

The SSE endpoint is cross-origin readable because MCP Apps run in a sandboxed origin. The capability itself supplies authorization, and the server terminates the SSE response when that token expires. The widget closes failed sources and obtains a newly scoped capability rather than allowing EventSource to retry an expired URL. CORS is not opened on `/mcp`, enrollment or OAuth endpoints. Because the capability appears in the SSE query string, reverse-proxy/access logs must redact query parameters if request logging is enabled.

## MCP App CSP

The terminal resource declares MCP Apps CSP metadata with only the configured MCP server origin in `connectDomains`. The app requests clipboard-write permission because the terminal exposes a Copy action. It does not request camera, microphone or geolocation permissions.

## Workspace policy

Workspace roots are configured on the local agent, not trusted from the MCP client. The agent resolves configured roots and requested `cwd` values to canonical real paths and verifies that developer-mode launch paths remain at or below an allowed root.

An empty developer root list means terminal creation is denied rather than unrestricted.

## Rate, size and lifecycle limits

Configured controls include:

- MCP HTTP requests per minute
- maximum sessions per user
- maximum sessions per agent
- model-visible read byte cap
- terminal input/event size limits
- retained terminal-buffer high-water mark
- WebSocket in-flight event window
- idle timeout
- maximum PTY lifetime
- gateway request timeout
- short stream-token lifetime with expiry-pruned revocation tombstones
- final-session post-mortem retention (`TERMINAL_CLOSED_SESSION_RETENTION_MS`)
- per-minute rate-limit bucket pruning

These controls are intended to prevent accidental or adversarial output floods, abandoned terminals and unbounded memory growth. Final terminal records remain available only for the configured post-mortem window and are then removed from both agent and server process memory.

## Audit and transcript separation

Audit records contain action metadata, user/client/session/agent identifiers, execution profile, authorization outcome, sequence/output metadata and errors. Successful terminal writes record byte counts rather than duplicating raw command text in the audit channel.

Terminal transcripts contain terminal events and command input. Transcript retention is configurable and expired lines are pruned periodically. Append/prune operations are serialized so retention rewriting cannot race a fresh append.

Both paths apply credential-pattern redaction. Redaction covers common bearer tokens, access tokens, passwords, API keys and similar key/value patterns. Redaction is defense in depth and cannot guarantee recognition of every possible secret format; avoid intentionally printing secrets in terminals.

## TLS and reverse proxies

Production configuration refuses HTTP public/OAuth URLs. Terminate TLS at a trusted reverse proxy and expose only HTTPS/WSS publicly. The local agent needs only outbound network connectivity to that endpoint. The WebSocket upgrade path independently enforces the configured host allowlist before device authentication.

Do not expose an unauthenticated shell endpoint, SSH daemon, anonymous WebSocket or long-lived browser credential as a substitute for the gateway design.

## Current scaling boundary

Live agents, MCP sessions and bounded terminal event buffers are owned by one server process. The file-backed device registry and transcript/audit files are durable on that host, but the current implementation does not coordinate live state between multiple MCP server replicas.

For this version, deploy one active gateway/server process. Before horizontal scaling, implement a shared connection-routing/event architecture and shared persistent session state; no distributed live-state backend is configured or implied by this release.
