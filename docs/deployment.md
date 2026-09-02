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

## Build and verify

The supported release bootstrap is the repository installer:

```bash
./install.sh
```

It verifies Node.js, resolves the pnpm version declared by `package.json`, installs the frozen lockfile, runs typecheck/lint/unit tests, builds every package including the Terminal UI, enforces the UI bundle budget, and runs the real-PTY E2E suite. Re-run the gate without reinstalling dependencies with:

```bash
./install.sh --verify
```

The manual equivalent is:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

The UI must be built because the MCP server loads `packages/terminal-ui/dist/index.html` when serving the versioned `ui://terminal/v13.html` MCP App resource. The terminal UI build also enforces a 30,000-byte single-file mobile bundle budget; override `TERMINAL_UI_MAX_BUNDLE_BYTES` only for an intentional, reviewed budget change.

### Source release artifact

Do not keep generated source archives under `deploy/`: they silently become stale as security and lifecycle fixes land. After the complete verification gate passes, create a source artifact from the exact Git commit you intend to deploy:

```bash
mkdir -p artifacts
RELEASE_COMMIT="$(git rev-parse --verify HEAD)"
git diff --quiet && git diff --cached --quiet
git archive --format=tar.gz --output="artifacts/chatgpt-terminal-plugin-${RELEASE_COMMIT:0:12}.tgz" "$RELEASE_COMMIT"
```

The `artifacts/` directory is ignored by Git. Record the full commit ID alongside the artifact and deploy only a commit that has passed the repository quality gate. `git archive` packages the tracked tree for that commit, including the current installer, CI workflow, protocol, server, agent, Terminal UI, deployment templates, and documentation, without accidentally snapshotting `node_modules`, local secrets, or uncommitted edits.

### Terminal UI release model

The v13 terminal widget is static-first and watch-only. Real PTY output prefers the terminal SSE stream and falls back to bounded `terminal_read` calls through the MCP Apps bridge when a host cannot establish `EventSource`. Production widgets do not open a second stylesheet hot-reload stream; this keeps the single-file mobile bundle smaller and removes an always-on EventSource. CSS, HTML, and JavaScript changes are released through the versioned MCP App resource and the normal connector rescan/refresh process. The legacy `/terminal-ui/reload` endpoint may remain available for development tooling, but production UI correctness must never depend on it.

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
- finite positive `TERMINAL_MAX_SESSIONS_PER_USER` and `TERMINAL_MAX_SESSIONS_PER_AGENT` values sized for the host
- appropriate audit/transcript paths and retention

Set `MCP_DEFAULT_EXECUTION_PROFILE` to the least privilege appropriate for tokens that do not carry an explicit profile claim. `TERMINAL_CLOSED_SESSION_RETENTION_MS` controls how long final session metadata/events remain available for status, UI reconnect, and post-mortem reads before agent/server memory is released. Use `deploy/server-environment.example` as the complete non-secret template; the runtime rejects malformed public URLs, insecure production OAuth endpoints, empty required scopes, and route collisions at startup.

Trusted server extensions are disabled unless `MCP_EXTENSION_ROOT` is set to an absolute administrator-controlled directory. Never point it at a terminal workspace or another user/agent-writable location. `MCP_EXTENSION_MAX_BYTES` defaults to 262144 bytes. See `docs/trusted-extensions.md` for the authorization, containment, reload, and trust model.

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

Use `deploy/systemd/chatgpt-terminal-mcp.service.example` and `deploy/server-environment.example` as starting points. The service runs the already-built Node entrypoint directly, so `pnpm` is not required on the production service `PATH` after `./install.sh` completes; Node.js 22+ still must be resolvable by the service. Recommended properties:

- run as a dedicated unprivileged OS account
- working directory is the checked-out release
- secrets live in an owner/root-readable environment file outside Git
- restart on failure
- bind the Node service to loopback when a local reverse proxy is used
- persist the device registry and logs on protected local paths; the provided systemd unit uses `StateDirectory=chatgpt-terminal` and `LogsDirectory=chatgpt-terminal` with `0700` modes so `/var/lib/chatgpt-terminal` and `/var/log/chatgpt-terminal` are created and owned for the service automatically

## Local-agent installation

The local computer requires the same built repository or a packaged agent distribution. `deploy/local-agent-environment.example` and `deploy/systemd/chatgpt-terminal-agent.service.example` provide a user-service baseline. The user service runs the built Node entrypoint directly; `pnpm` is needed to install/build the release but is not a runtime service dependency. Ensure Node.js 22+ is on the systemd user service `PATH`. Run the agent as the OS user whose tools/workspaces it is intentionally allowed to access; do not run it as root.

Configure:

```text
AGENT_GATEWAY_URL=wss://terminal.example.com/agent
AGENT_IDENTITY_PATH=<owner-only local path>
ALLOWED_WORKSPACE_ROOTS=<comma-separated roots>
EXECUTION_PROFILE=developer
TERMINAL_LSP_SERVERS_JSON={}
TERMINAL_TYPESCRIPT_NODE=<optional TypeScript-capable Node executable>
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
sudo -u chatgpt-terminal node packages/mcp-server/dist/admin.js \
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

The application creates its device identity and registry with owner-only modes and serializes audit/transcript writes with retention pruning. Deployment ownership should still be validated after installation. When using the provided server systemd unit, systemd creates the default `/var/lib/chatgpt-terminal` and `/var/log/chatgpt-terminal` directories with owner-only modes; custom paths must be provisioned and permissioned separately.

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


## Automated immutable production deployment

`.github/workflows/deploy-production.yml` gates every production deployment on typechecking, linting, unit tests, a full build, E2E coverage, the concurrency/reconnect soak test, and `git diff --check`. It then creates a self-contained MCP release archive for the exact Git commit, records its SHA-256 digest, and uploads both as a short-lived GitHub Actions artifact. The deployment job runs only after the verification job succeeds and targets the protected GitHub `production` environment.

Configure these **GitHub Environment variables** for `production`:

- `TERMINAL_DEPLOY_HOST` — SSH host for the MCP server.
- `TERMINAL_DEPLOY_USER` — restricted deployment account.
- `TERMINAL_DEPLOY_PORT` — optional SSH port; leave unset for the SSH default.
- `TERMINAL_DEPLOY_ROOT` — release root containing `releases/` and the atomic `current` symlink.
- `TERMINAL_SERVICE_NAME` — the systemd unit for this MCP service only.
- `TERMINAL_HEALTH_URL` — externally reachable health endpoint used as the post-cutover acceptance gate.

Configure these **GitHub Environment secrets**:

- `TERMINAL_DEPLOY_SSH_KEY` — private key for the restricted deployment account.
- `TERMINAL_DEPLOY_KNOWN_HOSTS` — pinned SSH host-key entry. Do not replace this with disabled host-key verification or a runtime `ssh-keyscan` trust-on-first-use step.

The remote deployment account must be able to write `TERMINAL_DEPLOY_ROOT`, run Node.js to validate the staged MCP module, and invoke passwordless `sudo systemctl restart/is-active` for the configured MCP service. Restrict sudo policy to that service where practical. The health URL must be reachable from the deployment runner.

`scripts/package-mcp-release.sh` uses `pnpm deploy --prod --legacy` after the repository build to produce a self-contained MCP dependency tree, then adds the built single-file Terminal UI, the UI source files used by runtime freshness/legacy stylesheet endpoints, and a `REVISION` marker. Packaging executes the MCP module import plus the packaged UI document and stylesheet readers before creating the archive, so missing runtime assets fail before deployment. `deploy/immutable-deploy.sh` verifies the archive digest, extracts into a same-filesystem staging directory, validates the revision and module import, marks the completed release read-only, and atomically switches `current` to `releases/<git-sha>`. If service activation or the health gate fails, the script restores the previous `current` target and restarts that previous release. On a first-ever deployment with no previous release, a failed cutover removes the new `current` link rather than leaving it pointed at an unhealthy release.

The workflow deploys the **MCP server only**. Local-agent rollout remains a separate operation so a server deployment cannot unexpectedly restart user computers. Other systemd services are not touched because the target unit is supplied explicitly through `TERMINAL_SERVICE_NAME`.
