# Trusted Server Extensions

Trusted server extensions are an optional administrative capability for adding MCP tools, prompts, or resources without giving remote callers arbitrary server-side import access.

## Disabled by default

The `terminal_reload_agent` tool is not registered unless `MCP_EXTENSION_ROOT` is configured. `MCP_EXTENSION_ROOT` must be an absolute path controlled by the server administrator. Do not place the root inside a terminal workspace or any directory writable by terminal users, CI jobs, uploaded content, or other untrusted workloads.

`MCP_EXTENSION_MAX_BYTES` bounds each extension module. The default is `262144` bytes (256 KiB) and the configured maximum is 4 MiB.

## Extension identity and files

Remote callers provide only an `extension_id`, never a path. Valid IDs contain lowercase ASCII letters, digits, hyphens, and underscores, are at most 64 characters, and cannot contain path separators or file extensions.

For an ID such as `diagnostics`, the server looks only for one of these administrator-installed files directly under the configured root:

```text
<MCP_EXTENSION_ROOT>/diagnostics.mjs
<MCP_EXTENSION_ROOT>/diagnostics.js
```

The server rejects:

- relative or absolute caller-supplied paths
- nested paths and traversal syntax
- symbolic-link extension roots or files
- non-regular files
- canonical paths outside the configured root
- files larger than `MCP_EXTENSION_MAX_BYTES`
- ambiguous IDs for which both `.js` and `.mjs` variants exist

## Authorization

Only an authenticated `owner-full` MCP identity may invoke `terminal_reload_agent`. `developer` and `read-only` identities are denied on the server before the extension is imported.

Example request:

```json
{
  "extension_id": "diagnostics"
}
```

## Extension contract

An extension must default-export a registration function. It receives a narrow registrar rather than the live `McpServer` object. The registrar exposes only:

- `registerTool`
- `registerPrompt`
- `registerResource`

Example:

```javascript
export default function register(registrar) {
  registrar.registerTool(
    'diagnostics_probe',
    { title: 'Diagnostics probe' },
    async () => ({
      content: [{ type: 'text', text: 'ok' }]
    })
  );
}
```

Registration authority is valid only while the default export is executing. The registrar is sealed after that callback finishes, so retaining it cannot be used to register capabilities later.

On reload, the server removes the previous registration handles for that extension before installing the replacement. If the replacement throws while registering, every partial new registration is removed and the reload fails closed.

## Trust boundary

This mechanism is **not a JavaScript sandbox**. An installed extension is trusted server code and executes with the MCP server process's operating-system privileges. The narrow registrar limits mutation of the MCP surface; it does not stop trusted extension code from importing Node.js modules or using other process capabilities.

Therefore:

- install extensions only through an administrator-controlled deployment process
- keep `MCP_EXTENSION_ROOT` outside all user/agent writable workspaces
- use normal filesystem ownership and permissions to protect the root
- review extension code like any other production server code
- never copy AI-generated, uploaded, or remotely supplied code into the trusted extension root without an independent administrative review step

The implementation relies on the extension root being administrator-controlled. File identity is checked with `lstat`/`realpath` immediately before import, but filesystem-level administrative ownership remains the trust anchor against concurrent replacement races.

## Audit

Every schema-valid reload attempt that reaches the handler records a `terminal_reload_agent` audit event. Denials include the normalized error code; successful reloads include the extension ID and registration count. Extension source and caller-supplied arbitrary paths are never accepted as reload input.
