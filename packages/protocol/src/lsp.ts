import { z } from 'zod';

// MCP Tool Schemas
export const TerminalLspStartSchema = z.object({
  command: z.string().describe('The LSP server command to run (e.g., "typescript-language-server").'),
  args: z.array(z.string()).default([]).describe('Arguments to pass to the LSP server.'),
  rootUri: z.string().optional().describe('Optional root URI for the workspace.'),
});
export type TerminalLspStartArgs = z.infer<typeof TerminalLspStartSchema>;

export const TerminalLspRequestSchema = z.object({
  id: z.string().describe('The ID of the running LSP server.'),
  method: z.string().describe('The JSON-RPC method to call.'),
  params: z.any().optional().describe('Optional parameters for the method.'),
});
export type TerminalLspRequestArgs = z.infer<typeof TerminalLspRequestSchema>;

export const TerminalLspStopSchema = z.object({
  id: z.string().describe('The ID of the LSP server to stop.'),
});
export type TerminalLspStopArgs = z.infer<typeof TerminalLspStopSchema>;

// Gateway Messages
export const GatewayLspStartRequestSchema = z.object({
  type: z.literal('lsp_start_request'),
  requestId: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  rootUri: z.string().optional(),
});
export type GatewayLspStartRequest = z.infer<typeof GatewayLspStartRequestSchema>;

export const GatewayLspStartResponseSchema = z.object({
  type: z.literal('lsp_start_response'),
  requestId: z.string(),
  lspId: z.string().optional(),
  error: z.string().optional(),
});
export type GatewayLspStartResponse = z.infer<typeof GatewayLspStartResponseSchema>;

export const GatewayLspRpcRequestSchema = z.object({
  type: z.literal('lsp_rpc_request'),
  requestId: z.string(),
  lspId: z.string(),
  method: z.string(),
  params: z.any().optional(),
});
export type GatewayLspRpcRequest = z.infer<typeof GatewayLspRpcRequestSchema>;

export const GatewayLspRpcResponseSchema = z.object({
  type: z.literal('lsp_rpc_response'),
  requestId: z.string(),
  result: z.any().optional(),
  error: z.any().optional(),
});
export type GatewayLspRpcResponse = z.infer<typeof GatewayLspRpcResponseSchema>;

export const GatewayLspStopRequestSchema = z.object({
  type: z.literal('lsp_stop_request'),
  requestId: z.string(),
  lspId: z.string(),
});
export type GatewayLspStopRequest = z.infer<typeof GatewayLspStopRequestSchema>;

export const GatewayLspStopResponseSchema = z.object({
  type: z.literal('lsp_stop_response'),
  requestId: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
});
export type GatewayLspStopResponse = z.infer<typeof GatewayLspStopResponseSchema>;

export const GatewayLspEventSchema = z.object({
  type: z.literal('lsp_event'),
  lspId: z.string(),
  method: z.string(),
  params: z.any().optional(),
});
export type GatewayLspEvent = z.infer<typeof GatewayLspEventSchema>;
