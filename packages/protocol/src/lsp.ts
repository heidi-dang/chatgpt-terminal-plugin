import { z } from 'zod';

export const lspServerIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i);

export const lspServerDefinitionSchema = z.object({
  command: z.string().min(1).max(4096),
  args: z.array(z.string().max(4096)).max(64).default([]),
});
export const lspServerDefinitionsSchema = z.record(lspServerIdSchema, lspServerDefinitionSchema)
  .refine((definitions) => Object.keys(definitions).length <= 16, 'At most 16 LSP server definitions may be configured.');
export type LspServerDefinitions = z.infer<typeof lspServerDefinitionsSchema>;

export const terminalLspStartSchema = z.object({
  agent_id: z.string().min(1),
  server_id: lspServerIdSchema,
  root: z.string().min(1).max(4096),
});
export type TerminalLspStartArgs = z.infer<typeof terminalLspStartSchema>;

export const terminalLspRequestSchema = z.object({
  agent_id: z.string().min(1),
  lsp_id: z.string().uuid(),
  method: z.string().min(1).max(256),
  notification: z.boolean().optional(),
  params: z.unknown().optional(),
});
export type TerminalLspRequestArgs = z.infer<typeof terminalLspRequestSchema>;

export const terminalLspStopSchema = z.object({
  agent_id: z.string().min(1),
  lsp_id: z.string().uuid(),
});
export type TerminalLspStopArgs = z.infer<typeof terminalLspStopSchema>;

export const lspStartInputSchema = terminalLspStartSchema.omit({ agent_id: true });
export type LspStartInput = z.infer<typeof lspStartInputSchema>;

export const lspRequestInputSchema = terminalLspRequestSchema.omit({ agent_id: true });
export type LspRequestInput = z.infer<typeof lspRequestInputSchema>;

export const lspStopInputSchema = terminalLspStopSchema.omit({ agent_id: true });
export type LspStopInput = z.infer<typeof lspStopInputSchema>;

export const lspStartOutputSchema = z.object({
  lsp_id: z.string().uuid(),
  server_id: lspServerIdSchema,
  root: z.string(),
});
export type LspStartOutput = z.infer<typeof lspStartOutputSchema>;

export const lspRequestOutputSchema = z.object({
  lsp_id: z.string().uuid(),
  result: z.unknown().optional(),
});
export type LspRequestOutput = z.infer<typeof lspRequestOutputSchema>;

export const lspStopOutputSchema = z.object({
  lsp_id: z.string().uuid(),
  stopped: z.boolean(),
});
export type LspStopOutput = z.infer<typeof lspStopOutputSchema>;
