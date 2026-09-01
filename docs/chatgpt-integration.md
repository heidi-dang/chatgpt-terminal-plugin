# ChatGPT Integration

Checked against OpenAI's current developer-mode documentation on 2026-09-01. ChatGPT app availability, menus, and beta restrictions can change; verify the linked OpenAI sources before a production rollout.

## Current availability

This project exposes write-capable terminal tools and an interactive MCP App UI. OpenAI currently documents full MCP, including write/modify actions, for ChatGPT Business, Enterprise, and Edu on ChatGPT web. Pro can use custom MCPs with read/fetch permissions, but not the full write-capable MCP surface this terminal app requires. MCP apps are currently web-only.

ChatGPT does not directly connect to a localhost MCP endpoint. Use either:

1. a trusted remote HTTPS MCP endpoint, or
2. OpenAI Secure MCP Tunnel for a private/on-premises/developer-machine MCP server when that product fits the deployment.

This repository's normal production topology uses a remote HTTPS `/mcp` endpoint and an outbound WSS local-agent connection.

## Prepare the server

Before creating the ChatGPT draft app:

1. Build and run the MCP server behind HTTPS.
2. Confirm `MCP_PUBLIC_URL` is the exact public `/mcp` URL.
3. Confirm the selected authentication flow is discoverable. For Cloudflare Access Managed OAuth, unauthenticated `/mcp` must return `401` with `resource_metadata` pointing to Cloudflare's RFC 9728 metadata; a browser-only `302` is not sufficient for an MCP client.
4. Confirm issuer, JWKS, audience, and the configured owner identity claim map correctly. In Cloudflare mode, the origin must validate `Cf-Access-Jwt-Assertion` rather than attempting to decode the opaque Managed OAuth bearer token.
5. Enroll at least one local agent for the same owner ID that will authenticate from ChatGPT.
6. Verify `/health` and the repository release gates.

The browser terminal stream is not the MCP endpoint. ChatGPT connects to `/mcp`; the watch-only MCP App receives a separate short-lived, read-only SSE capability through tool-result metadata. The current bootstrap resource is `ui://terminal/v12.html`. v12 is static-first: the returned HTML contains a visible terminal shell before JavaScript executes, then uses the standard MCP Apps bridge or ChatGPT's `window.openai` compatibility bridge to hydrate the turn surface and current PTY. Direct SSE remains the preferred live transport, with bounded `terminal_read` long-polling as a compatibility fallback when a host WebView cannot establish `EventSource` or does not expose the refreshed SSE capability; SSE recovery continues in the background. `/terminal-ui/reload` is CSS-only and never replaces the mounted document. Bump the resource URI again when the MCP/UI contract changes in a way that requires hosts to discard the v12 bootstrap contract.

## OAuth and refresh tokens

For durable ChatGPT connectivity, the client-facing OAuth provider must support refresh tokens.

With origin-managed `jwt` mode, configure the external OAuth/OIDC provider normally. OpenAI currently recommends a provider setup that can issue refresh access; advertise `offline_access` only when the provider truly supports it.

With `cloudflare-access`, enable Access **Managed OAuth** on the application protecting `/mcp`. Access becomes the client-facing OAuth server, supports authorization-code + PKCE and refresh tokens, and resolves the opaque client token into a signed `Cf-Access-Jwt-Assertion` for the origin. Enable dynamic client registration and restrict redirects to ChatGPT callbacks, such as:

```text
https://chatgpt.com/connector_platform_oauth_redirect
https://chatgpt.com/connector/oauth/*
```

Keep arbitrary redirect domains, localhost, and loopback registration disabled unless they are independently required and reviewed. The production smoke should confirm an allowed ChatGPT registration succeeds and an unapproved redirect URI is rejected.

## Create a draft app in ChatGPT

Use ChatGPT web and an account/workspace role permitted to use developer mode.

Current OpenAI flow:

1. Enable developer mode for your account/workspace according to the plan's admin controls.
2. Open **Workspace settings → Apps → Create** as an admin/owner, or **Settings → Apps → Create** when your role is authorized.
3. Enter the public MCP endpoint, for example `https://terminal.example.com/mcp`.
4. Select/configure OAuth authentication.
5. Choose **Scan Tools**.
6. Complete the OAuth authorization prompt.
7. Review all discovered tools and their write/modify risk.
8. Choose **Create**.
9. Confirm the app appears as a draft and is labelled as a development app in user settings.

Do not use the agent WebSocket URL or `/agent/enroll` as the ChatGPT MCP endpoint.

## Host acceptance test

Start a new ChatGPT web conversation with the draft app selected, then verify:

1. `terminal_list_agents` returns only the authenticated user's enrolled machine.
2. `terminal_start` creates a PTY and renders the live terminal MCP App.
3. The UI shows the expected computer name, cwd, shell, and host light/dark theme.
4. `terminal_write` executes a harmless command and `terminal_read` returns the same terminal output with a monotonic cursor.
5. A second command observes persistent shell state (for example `cd` followed by `pwd`).
6. A long-running command can be interrupted with `terminal_interrupt` / the UI Ctrl+C control.
7. Live output continues across a stream-token refresh/reconnect without duplicate output or cursor loss. Confirm duplicate SSE sequence IDs are ignored and an injected/observed forward sequence gap forces a fresh capability/recovery rather than rendering out of order.
8. Confirm an SSE connection actually receives new `terminal.stdout` bytes after it is established; metadata-only success is insufficient.
9. `terminal_close` terminates the PTY, the UI reflects the closed state, controls stop mutating the session, and the final session disappears after the configured post-mortem retention window.
10. Audit/transcript data is produced according to the configured retention policy.
11. A different user/token cannot see the first user's agent, MCP session, terminal session, or stream.

Write/modify actions may trigger ChatGPT confirmation based on workspace permissions and action context. Treat those confirmations as a host-level safety layer, not as a replacement for the server and agent authorization implemented in this repository.

## Tool-definition updates

OpenAI currently documents a frozen tool/action snapshot after workspace approval. Changes to server tool definitions are not automatically enabled in an approved workspace app.

After changing a tool name, schema, metadata, or action semantics:

- refresh/rescan the app actions in workspace settings;
- review the reported changes;
- re-enable/publish the updated action set as required by the plan;
- open a new chat for acceptance testing.

For Business, OpenAI currently notes that published custom apps may need to be recreated and republished rather than updated in place. Enterprise/Edu provides additional RBAC and action-control workflows.

## Production publication

Only publish after the public-host acceptance test passes. Review the terminal tools as high-impact write actions. Restrict workspace access and action availability to the smallest appropriate group, and use the least-privileged execution profile that satisfies the use case.

The local `developer` profile constrains the PTY's **launch working directory** to configured roots, including symlink-safe canonicalization. It is not a kernel/filesystem sandbox: once a general-purpose shell is running, commands execute with that OS user's normal permissions. Use a dedicated OS account, container/VM, mandatory access controls, or another OS sandbox when stronger containment is required.

## Official OpenAI references

- Developer mode and MCP apps in ChatGPT: https://help.openai.com/en/articles/12584461
- Build with the Apps SDK: https://help.openai.com/en/articles/12515353-build-with-the-apps-sdk
- Apps in ChatGPT: https://help.openai.com/en/articles/11487775

The first reference is the authoritative source used for the availability, developer-mode, OAuth refresh, local-MCP, write-action, and frozen-tool-snapshot notes above as of 2026-09-01.
