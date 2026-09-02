import { z } from 'zod';
import { lspServerIdSchema } from './lsp.js';

export const semanticIdSchema = z.string().uuid();
const agentIdSchema = z.string().min(1).max(256);
const semanticPathSchema = z.string().min(1).max(4096);
const semanticPositionSchema = z.object({
  line: z.number().int().nonnegative().max(10_000_000),
  character: z.number().int().nonnegative().max(10_000_000),
});

export const terminalSemanticOpenSchema = z.object({
  agent_id: agentIdSchema,
  server_id: lspServerIdSchema,
  root: z.string().min(1).max(4096),
});
export type TerminalSemanticOpenArgs = z.infer<typeof terminalSemanticOpenSchema>;
export const semanticOpenInputSchema = terminalSemanticOpenSchema.omit({ agent_id: true });
export type SemanticOpenInput = z.infer<typeof semanticOpenInputSchema>;

const terminalSemanticSessionSchema = z.object({
  agent_id: agentIdSchema,
  semantic_id: semanticIdSchema,
});

export const terminalSemanticSymbolsSchema = terminalSemanticSessionSchema.extend({
  path: semanticPathSchema,
});
export type TerminalSemanticSymbolsArgs = z.infer<typeof terminalSemanticSymbolsSchema>;

export const terminalSemanticFindSymbolsSchema = terminalSemanticSessionSchema.extend({
  query: z.string().min(1).max(512),
});
export type TerminalSemanticFindSymbolsArgs = z.infer<typeof terminalSemanticFindSymbolsSchema>;

export const terminalSemanticReferencesSchema = terminalSemanticSessionSchema.extend({
  path: semanticPathSchema,
  ...semanticPositionSchema.shape,
  include_declaration: z.boolean().default(false),
});
export type TerminalSemanticReferencesArgs = z.infer<typeof terminalSemanticReferencesSchema>;

export const terminalSemanticDefinitionSchema = terminalSemanticSessionSchema.extend({
  path: semanticPathSchema,
  ...semanticPositionSchema.shape,
});
export type TerminalSemanticDefinitionArgs = z.infer<typeof terminalSemanticDefinitionSchema>;

export const terminalSemanticImplementationsSchema = terminalSemanticDefinitionSchema;
export type TerminalSemanticImplementationsArgs = z.infer<typeof terminalSemanticImplementationsSchema>;

export const terminalSemanticDiagnosticsSchema = terminalSemanticSessionSchema.extend({
  path: semanticPathSchema,
});
export type TerminalSemanticDiagnosticsArgs = z.infer<typeof terminalSemanticDiagnosticsSchema>;

export const terminalSemanticCloseSchema = terminalSemanticSessionSchema;
export type TerminalSemanticCloseArgs = z.infer<typeof terminalSemanticCloseSchema>;

const semanticQueryBaseSchema = z.object({ semantic_id: semanticIdSchema });
export const semanticQueryInputSchema = z.discriminatedUnion('operation', [
  semanticQueryBaseSchema.extend({ operation: z.literal('document_symbols'), path: semanticPathSchema }),
  semanticQueryBaseSchema.extend({ operation: z.literal('workspace_symbols'), query: z.string().min(1).max(512) }),
  semanticQueryBaseSchema.extend({
    operation: z.literal('references'),
    path: semanticPathSchema,
    ...semanticPositionSchema.shape,
    include_declaration: z.boolean().default(false),
  }),
  semanticQueryBaseSchema.extend({ operation: z.literal('definition'), path: semanticPathSchema, ...semanticPositionSchema.shape }),
  semanticQueryBaseSchema.extend({ operation: z.literal('implementations'), path: semanticPathSchema, ...semanticPositionSchema.shape }),
  semanticQueryBaseSchema.extend({ operation: z.literal('diagnostics'), path: semanticPathSchema }),
]);
export type SemanticQueryInput = z.infer<typeof semanticQueryInputSchema>;

export const semanticCloseInputSchema = z.object({ semantic_id: semanticIdSchema });
export type SemanticCloseInput = z.infer<typeof semanticCloseInputSchema>;

export const semanticOpenOutputSchema = z.object({
  semantic_id: semanticIdSchema,
  lsp_id: z.string().uuid(),
  server_id: lspServerIdSchema,
  root: z.string().min(1).max(4096),
  capabilities: z.record(z.string(), z.unknown()),
});
export type SemanticOpenOutput = z.infer<typeof semanticOpenOutputSchema>;

export const semanticSymbolsOutputSchema = z.object({
  semantic_id: semanticIdSchema,
  path: z.string().min(1).max(4096),
  symbols: z.array(z.unknown()).max(200),
  truncated: z.boolean().default(false),
});
export type SemanticSymbolsOutput = z.infer<typeof semanticSymbolsOutputSchema>;

export const semanticWorkspaceSymbolsOutputSchema = z.object({
  semantic_id: semanticIdSchema,
  query: z.string().max(512),
  symbols: z.array(z.unknown()).max(200),
  truncated: z.boolean().default(false),
});
export type SemanticWorkspaceSymbolsOutput = z.infer<typeof semanticWorkspaceSymbolsOutputSchema>;

export const semanticLocationsOutputSchema = z.object({
  semantic_id: semanticIdSchema,
  path: z.string().min(1).max(4096),
  locations: z.array(z.unknown()).max(200),
  truncated: z.boolean().default(false),
});
export type SemanticLocationsOutput = z.infer<typeof semanticLocationsOutputSchema>;

export const semanticDiagnosticsOutputSchema = z.object({
  semantic_id: semanticIdSchema,
  path: z.string().min(1).max(4096),
  diagnostics: z.array(z.unknown()).max(200),
  version: z.number().int().nonnegative().optional(),
  truncated: z.boolean().default(false),
});
export type SemanticDiagnosticsOutput = z.infer<typeof semanticDiagnosticsOutputSchema>;

export const semanticCloseOutputSchema = z.object({
  semantic_id: semanticIdSchema,
  stopped: z.boolean(),
});
export type SemanticCloseOutput = z.infer<typeof semanticCloseOutputSchema>;

export const semanticQueryOutputSchema = z.union([
  semanticSymbolsOutputSchema,
  semanticWorkspaceSymbolsOutputSchema,
  semanticLocationsOutputSchema,
  semanticDiagnosticsOutputSchema,
]);
export type SemanticQueryOutput = z.infer<typeof semanticQueryOutputSchema>;
