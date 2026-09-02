# Serena-style semantic code intelligence

`chatgpt-terminal-plugin` includes a native semantic code-intelligence layer inspired by Serena's model-friendly language-server tools. It reuses the existing authenticated local-agent gateway and TypeScript LSP transport instead of embedding Serena's Python runtime.

## Lifecycle

1. Call `terminal_semantic_open` with an enrolled agent, an administrator-configured/discovered `server_id`, and an authorized workspace root.
2. The local agent starts the language server, performs `initialize`, captures server capabilities, then sends `initialized`.
3. Use the fixed semantic read tools with the returned `semantic_id`.
4. Preview refactors with `terminal_semantic_preview_edit`; inspect the diff and revision digests.
5. Apply an accepted preview with `terminal_semantic_apply_edit`. Apply fails with `STALE_EDIT` if any target changed after preview.
6. Optionally inspect onboarding data and maintain named project memories.
7. Call `terminal_semantic_close` when the semantic workspace is no longer needed.

Semantic workspaces are owned by the authenticated user. A semantic ID cannot be queried or closed by another user.

## Model-facing tools

| Tool | Purpose |
| --- | --- |
| `terminal_semantic_open` | Create an initialized semantic workspace. |
| `terminal_semantic_symbols` | Structured file symbols via `textDocument/documentSymbol`. |
| `terminal_semantic_find_symbols` | Workspace symbol search via `workspace/symbol`. |
| `terminal_semantic_references` | References via `textDocument/references`. |
| `terminal_semantic_definition` | Definition/declaration lookup via `textDocument/definition`. |
| `terminal_semantic_implementations` | Implementations via `textDocument/implementation`. |
| `terminal_semantic_diagnostics` | Latest cached `publishDiagnostics` for a synchronized file. |
| `terminal_semantic_preview_edit` | Preview rename, symbol-body replacement, insert-before/after, or safe-delete without writing files. |
| `terminal_semantic_apply_edit` | Apply one digest-guarded preview; fails closed on stale revisions. |
| `terminal_semantic_project_overview` | Bounded project onboarding: languages, manifests, package managers, scripts, memories. |
| `terminal_semantic_memory_read` | Read one named project memory. |
| `terminal_semantic_memory_write` | Persist one named project memory in local-agent state. |
| `terminal_semantic_close` | Stop and dispose the semantic workspace. |

The existing `terminal_lsp_start`, `terminal_lsp_request`, and `terminal_lsp_stop` tools remain available as the advanced raw JSON-RPC surface.

## Filesystem synchronization

A shell command, Git operation, formatter, build step, or another editor may change a file without going through the semantic API. Before a file-based semantic query, the local agent:

1. canonicalizes the requested file and verifies it is a regular file inside the authorized workspace root;
2. reads the current UTF-8 contents and computes a SHA-256 digest;
3. sends `textDocument/didOpen` with version `1` on the first query; or
4. sends a full-text `textDocument/didChange` with an incremented version when the digest changed.

This prevents semantic queries from silently relying on the stale file contents that existed when the language server first started.

## Output bounds

Semantic arrays are bounded by both:

- 200 top-level results; and
- 64 KiB of serialized result data.

When either limit shortens a response, `truncated` is `true`. Raw language-server frames are still subject to the lower-level LSP transport message and buffer limits.

## Diagnostics

The LSP transport exposes server notifications to the semantic manager. Only `textDocument/publishDiagnostics` notifications whose file URI resolves inside the semantic workspace are cached for semantic diagnostics queries. Notification-listener failures cannot terminate the LSP transport.

## Server-to-client requests

The LSP client answers a small safe allowlist used by real language servers:

- `workspace/configuration` -> one `null` result for each requested configuration item;
- `workspace/workspaceFolders` -> the single authorized semantic workspace root;
- `window/workDoneProgress/create` -> acknowledgement.

All other server-to-client requests, including server-driven edits such as `workspace/applyEdit`, receive JSON-RPC `-32601`. The language server cannot use the semantic channel to bypass the terminal plugin's mutation authorization.

## Authorization model

Semantic navigation, preview, project overview, and memory reads are available to `read-only` identities. `terminal_semantic_apply_edit` and `terminal_semantic_memory_write` require a non-read-only execution profile. The fixed semantic surface cannot choose arbitrary LSP methods. Raw `terminal_lsp_*` operations retain the existing stricter process/mutation authorization path.

The semantic layer does not broaden workspace roots, follow symlinks outside a root, or execute caller-selected language-server commands. Language-server executables remain administrator configured or locally discovered under the existing agent policy.


## Semantic mutations

Mutations use a two-phase contract. `terminal_semantic_preview_edit` never writes workspace files. It resolves the requested symbol/refactor, computes the proposed contents, returns a bounded diff, and records a SHA-256 digest for every affected file. Previews are short-lived and workspace-owned.

`terminal_semantic_apply_edit` re-reads every affected file before writing. If any SHA-256 digest differs from the preview, the operation fails with `STALE_EDIT` and writes nothing. Successful multi-file edits are staged to sibling temporary files before replacement, then synchronized back into the language server.

Supported preview operations are:

- `rename`: delegates to `textDocument/rename` and accepts only text edits targeting existing files inside the authorized root;
- `replace_symbol`: replaces the smallest enclosing semantic symbol range;
- `insert_before` / `insert_after`: inserts at the enclosing symbol boundary;
- `safe_delete`: refuses deletion while `textDocument/references` reports live references.

Language-server resource operations that create, rename, or delete files are rejected. The semantic refactor path never treats `workspace/applyEdit` as implicit authority.

## Project onboarding and memory

`terminal_semantic_project_overview` scans a bounded project tree while skipping generated/vendor directories and reports detected languages, common manifests, package managers, package scripts, and available memory names.

Project memories are named, bounded records associated with the canonical workspace root. In normal local-agent deployments they are persisted under the agent state directory, not written into the source repository. Memory names use a strict lowercase identifier grammar and contents are limited to 64 KiB.
