# Implementation Plan: LSP & Code Block Support for ChatGPT Terminal Plugin

## 1. Overview

The goal is to extend the `chatgpt-terminal-plugin` (an MCP terminal bridge) with **Language Server Protocol (LSP) capabilities** and **Code Block execution capabilities**. This will allow AI models (like Claude/ChatGPT) to request precise code context (definitions, diagnostics, hover) from a local LSP server, and reliably execute or write large blocks of code without terminal escaping/mangling issues.

## 2. LSP Implementation

Currently, the MCP Server and Local Agent communicate over an authenticated WebSocket Gateway. We will add an LSP tunneling capability to this Gateway.

### A. Protocol Changes (`packages/protocol/src/index.ts`)
- **New MCP Tools:**
  - `terminal_lsp_start`: Spawn a language server on the local machine (e.g. `typescript-language-server --stdio`).
  - `terminal_lsp_request`: Send a JSON-RPC request (e.g., `textDocument/hover`, `textDocument/definition`).
  - `terminal_lsp_stop`: Terminate the LSP server.
- **New Gateway Messages:**
  - Add Gateway RPC structures for LSP: `GatewayLspStartRequest`, `GatewayLspStartResponse`, `GatewayLspRpcRequest`, `GatewayLspRpcResponse`, `GatewayLspEvent` (for server-to-client notifications like `textDocument/publishDiagnostics`).

### B. Local Agent Changes (`packages/local-agent/src/`)
- Create an `LspManager` class alongside `LocalTerminalAgent`.
- `LspManager` will use Node's `child_process.spawn` to start the LSP process.
- Implement a JSON-RPC stream chunker to read `Content-Length` headers from the LSP's `stdout` and emit complete JSON objects.
- Bridge these JSON objects back to the MCP Server over the Gateway WebSocket.

### C. MCP Server Changes (`packages/mcp-server/src/`)
- Register the new `terminal_lsp_*` tools in `mcp.ts`.
- Route the tool calls via the `AgentGateway` to the specific connected local agent.
- Optionally, provide higher-level MCP tools for common LSP operations (e.g., `terminal_lsp_hover`, `terminal_lsp_definition`) that automatically construct the correct JSON-RPC payload, masking the complexity from the LLM.

## 3. Code Block Implementation

Large code generation often fails in standard interactive PTYs due to bracketed paste issues, terminal echoing, or escaping errors. A native Code Block tool resolves this.

### A. Protocol Changes (`packages/protocol/src/index.ts`)
- **New MCP Tool:** `terminal_execute_code_block`
  - Inputs: `code` (string), `language` (string: e.g., `bash`, `python`, `node`, `typescript`), and `session_id` (optional) or `cwd`.
- **New Gateway Messages:** `GatewayExecuteCodeBlockRequest`, `GatewayExecuteCodeBlockResponse`.

### B. Local Agent Changes (`packages/local-agent/src/`)
- When a `GatewayExecuteCodeBlockRequest` is received:
  1. Write the `code` string to a secure temporary file (e.g., `/tmp/script_xxx.py`).
  2. If a `session_id` is provided, use the existing PTY to execute the script (e.g. `python /tmp/script_xxx.py\n`).
  3. Alternatively, spawn a one-off child process for the script and return the complete stdout/stderr back as a tool result without modifying the active terminal state. 
- Implement proper cleanup to delete the temporary file after execution or after a timeout.

### C. MCP Server Changes (`packages/mcp-server/src/`)
- Register the `terminal_execute_code_block` tool in `mcp.ts`.
- Ensure it respects the same `executionProfile` (e.g., `developer` launch-root restrictions) as the normal `terminal_start` tool.

## 4. Testing & Verification Plan

1. **Unit Tests:** Add mocks in `tests/unit` to simulate LSP JSON-RPC framing (Content-Length parsing) and verify the Code Block temp file creation.
2. **E2E Tests:** In `tests/e2e/terminal.e2e.test.ts`, add a flow that starts a `node-pty`, sends a multi-line python code block via `terminal_execute_code_block`, and asserts the correct output is received. Add another flow simulating a basic LSP server (like a mock bash script) to verify bidirectional JSON-RPC.
3. **Security:** Ensure the Code Block temporary file is created with restricted permissions (`0600`) and resides in a safe temporary directory.

## 5. Summary of Affected Files

- `packages/protocol/src/index.ts` (Schema & type additions)
- `packages/mcp-server/src/mcp.ts` (Tool registration)
- `packages/mcp-server/src/service.ts` (Service routing)
- `packages/mcp-server/src/gateway.ts` (Gateway message handling)
- `packages/local-agent/src/index.ts` (Agent logic and execution)
- `packages/local-agent/src/gateway-client.ts` (Gateway forwarding)
- (New) `packages/local-agent/src/lsp-manager.ts`
- (New) `packages/local-agent/src/code-block.ts`
