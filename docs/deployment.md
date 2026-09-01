# Production Deployment

## Deployment topology

Use one active MCP/gateway server process behind a TLS reverse proxy:

```text
Internet
   |
 HTTPS / WSS
   v
Caddy / reverse proxy
   |
   +--> 127.0.0.1:<MCP_PORT>  chatgpt-terminal MCP server
                                  ^
                                  |
                       outbound authenticated WebSocket
                                  |
                           enrolled local agents
```

The current gateway connection map, MCP sessions and terminal event buffers are process-local. Do not run multiple active replicas behind round-robin load balancing without adding shared session/routing semantics.

## Build

```bash
corepack enable
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

The UI must be built because the MCP server loads `packages/terminal-ui/dist/index.html` when serving the versioned `ui://terminal/v7.html` MCP App resource. The terminal UI build also enforces a 30,000-byte single-file mobile bundle budget; override `TERMINAL_UI_MAX_BUNDLE_BYTES` only for an intentional, reviewed budget change.

### Live UI hot reload

The v7 terminal widget is static-first and watch-only. Real PTY output prefers the terminal SSE stream and falls back to bounded `terminal_read` calls through the MCP Apps bridge when a host cannot establish `EventSource`; a separate `/terminal-ui/reload` SSE channel is used only for stylesheet updates. The mounted document is never replaced and there is no `/terminal-ui/runtime.html` route. CSS-only changes can refresh without disturbing the active session, stream capability, fallback transport, or last accepted terminal cursor. HTML/JavaScript changes require a new MCP App resource version and the normal connector rescan/refresh process.

## Server environment

Production requires at minimum:

- `NODE_ENV=production`
- `MCP_HOST` and `MCP_PORT`
- HTTPS `MCP_PUBLIC_URL`, including `/mcp`
- `MCP_AUTH_MODE=jwt` when the origin owns OAuth, or `MCP_AUTH_MODE=cloudflare-access` when Cloudflare Access Managed OAuth protects `/mcp`
- issuer/JWKS/audience in both production modes; authorization/token endpoints additionally when `MCP_AUTH_MODE=jwt`
- `STREAM_TOKEN_SECRET` with at least 32 bytes
- `AGENT_DEVICE_REGISTRY_PATH`
- `AGENT_ENROLLMENT_TOKEN`
- appropriate audit/transcript paths and retention

Set `MCP_DEFAULT_EXECUTION_PROFILE` to the least privilege appropriate for tokens that do not carry an explicit profile claim. `TERMINAL_CLOSED_SESSION_RETENTION_MS` controls how long final session metadata/events remain available for status, UI reconnect, and post-mortem reads before agent/server memory is released. Use `deploy/server-environment.example` as the complete non-secret template; the runtime rejects malformed public URLs, insecure production OAuth endpoints, empty required scopes, and route collisions at startup.

## Authentication modes

### Origin-managed JWT OAuth

With `MCP_AUTH_MODE=jwt`, the MCP server is the OAuth protected resource. Configure issuer, JWKS, audience, authorization/token endpoints, and required/advertised scopes. The external authorization server should support authorization-code + PKCE and refresh tokens for durable ChatGPT connectivity.

### Cloudflare Access Managed OAuth

With `MCP_AUTH_MODE=cloudflare-access`, protect the public `/mcp` path with a Cloudflare Access self-hosted/MCP application and enable **Managed OAuth**. Cloudflare owns OAuth discovery, dynamic client registration, authorization-code/PKCE, refresh-token issuance, and the client-facing `401 WWW-Authenticate` challenge. The origin does **not** accept the opaque OAuth bearer token. Instead, it validates the signed JWT injected by Access in `Cf-Access-Jwt-Assertion` against `OAUTH_ISSUER`, `OAUTH_JWKS_URL`, and `OAUTH_AUDIENCE`.

For ChatGPT, enable dynamic client registration and restrict allowed redirect URIs to the ChatGPT callback patterns actually required by the workspace, for example `https://chatgpt.com/connector_platform_oauth_redirect` and `https://chatgpt.com/connector/oauth/*`. Keep localhost/loopback registration disabled unless a separate trusted client requires it. Short Access-token lifetimes with a longer Managed OAuth grant session are preferred.

Cloudflare Access application tokens commonly use `email` as the stable human owner mapping in this deployment; configure `OAUTH_USER_ID_CLAIM=email` when the enrolled device owner IDs use email. `OAUTH_ALLOW_SCOPELESS_TOKENS=true` is an explicit provider compatibility switch for Access assertions that do not carry OAuth scopes. Do not enable it for ordinary JWT OAuth unless that behavior is intentionally reviewed.

In either mode, supported execution-profile claims are `read-only`, `developer`, and `owner-full`; when absent, `MCP_DEFAULT_EXECUTION_PROFILE` applies. The local agent always applies the more restrictive of the authenticated server profile and its own configured profile.

## Reverse proxy

`deploy/Caddyfile.example` demonstrates a single-domain reverse proxy. Caddy automatically proxies WebSocket upgrades. Disabling response buffering for the upstream helps SSE terminal events appear promptly.

The public MCP URL and gateway URL normally share the same origin:

```text
https://terminal.example.com/mcp
wss://terminal.example.com/agent
https://terminal.example.com/agent/enroll
```

Only the SSE terminal stream is intentionally CORS-readable by the sandboxed MCP App. Do not add permissive CORS to `/mcp` or administrative enrollment endpoints. Stream capability tokens are short-lived and the server closes an SSE response when its token expires.

The stream capability is carried in a URL query parameter because browser `EventSource` does not provide a general custom Authorization header. Do not enable proxy/access logs that retain raw query strings unless the token parameter is redacted.

## Server service

Use `deploy/systemd/chatgpt-terminal-mcp.service.example` and `deploy/server-environment.example` as starting points. Recommended properties:

- run as a dedicated unprivileged OS account
- working directory is the checked-out release
- secrets live in an owner/root-readable environment file outside Git
- restart on failure
- bind the Node service to loopback when a local reverse proxy is used
- persist the device registry and logs on a protected local path

## Local-agent installation

The local computer requires the same built repository or a packaged agent distribution. `deploy/local-agent-environment.example` and `deploy/systemd/chatgpt-terminal-agent.service.example` provide a user-service baseline. Run the agent as the OS user whose tools/workspaces it is intentionally allowed to access; do not run it as root.

Configure:

```text
AGENT_GATEWAY_URL=wss://terminal.example.com/agent
AGENT_IDENTITY_PATH=<owner-only local path>
ALLOWED_WORKSPACE_ROOTS=<comma-separated roots>
EXECUTION_PROFILE=developer
TERMINAL_LSP_SERVERS_JSON={}
```

For the first enrollment, additionally configure:

```text
AGENT_ENROLLMENT_URL=https://terminal.example.com/agent/enroll
AGENT_OWNER_ID=<JWT sub / server user ID>
AGENT_ENROLLMENT_TOKEN=<bootstrap administrator token>
```

After successful enrollment, remove the enrollment token from the persistent service environment. The CLI also deletes `AGENT_ENROLLMENT_TOKEN` from its own process environment immediately after successful enrollment so spawned PTYs cannot inherit it. Ongoing gateway authentication uses the machine's Ed25519 private key, not the bootstrap token.

A trusted server administrator with local filesystem access can enroll a public device record without reading the bootstrap token by using the server-only admin CLI. This is not an HTTP endpoint and should be run as the OS account that owns the registry so ownership remains correct:

```bash
sudo -u terminal-mcp node packages/mcp-server/dist/admin.js \
  enroll /var/lib/chatgpt-terminal/devices.json /path/to/device-enrollment.json
```

The JSON input uses the normal enrollment schema (`device_id`, immutable `agent_id`, `owner_id`, Ed25519 `public_key`, and optional `display_name`). The command reuses the same key parsing, owner/agent immutability checks, versioning, atomic persistence, and `0600` registry mode as HTTP enrollment. Treat access to this CLI as equivalent to administrative access to the registry; never expose it through the public reverse proxy.

For key rotation, perform a controlled agent launch with `AGENT_ROTATE_KEY=1` and enrollment values present. The device ID remains stable and the server records a new key version. Return `AGENT_ROTATE_KEY` to `0` afterward.

## Revocation

Administrative device revocation requires the enrollment token:

```bash
curl --fail-with-body \
  -H 'Content-Type: application/json' \
  -H "X-Terminal-Enrollment-Token: $AGENT_ENROLLMENT_TOKEN" \
  --data "{\"device_id\":\"$DEVICE_ID\"}" \
  https://terminal.example.com/agent/enroll/revoke
```

A connected device is disconnected immediately and future challenge authentication fails while it remains revoked.

## File permissions

Protect at minimum:

- server environment/secrets: `0600` or equivalent
- device registry: `0600`
- local agent identity: `0600`
- containing secret/identity directories: owner-only
- transcript/audit files according to your data-retention policy

The application creates its device identity and registry with owner-only modes and serializes audit/transcript writes with retention pruning. Deployment ownership should still be validated after installation.

`developer` mode canonicalizes the requested launch directory and rejects symlink/path escapes outside configured roots. It does **not** sandbox arbitrary commands after the shell starts. Use a dedicated OS account, container/VM, or OS mandatory-access controls if filesystem/process containment beyond normal user permissions is required.

## Health and smoke checks

The server exposes `/health`. A deployment smoke should verify:

1. `/health` returns healthy. Production health responses intentionally omit live agent/MCP-session counts.
2. authentication discovery is correct for the selected mode: origin OAuth metadata for `jwt`, or Cloudflare Managed OAuth `401` + RFC 9728 resource metadata for `cloudflare-access`.
3. an enrolled agent completes challenge authentication and appears online.
4. MCP initialize succeeds over the public URL.
5. `terminal_list_agents` sees only the expected owner's device.
6. start → write → read → interrupt → close succeeds.
7. SSE streams through the public reverse proxy without buffering and receives newly generated `terminal.stdout` after the connection is established.
8. stream reconnect/refresh resumes from the last contiguous sequence without duplicate rendering; stale capability URLs are not reused after an error.
9. closed/exited session records disappear after `TERMINAL_CLOSED_SESSION_RETENTION_MS`.
10. audit/transcript files are writable and protected.

The repository's `pnpm test:e2e` performs the same core terminal sequence locally with a real MCP v2 client and PTY.

## Rollback

Keep release artifacts/versioned checkouts so the systemd service can be repointed to a previously verified build. The file-backed device registry format is versioned. This release writes version 2 with an explicit immutable `agent_id` binding and migrates version-1 records on load. Back it up before deploying a release that changes its schema.

Do not roll back by replacing the current registry with an older copy unless you understand that doing so can resurrect revoked keys/devices.
