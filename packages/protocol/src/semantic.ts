import { z } from 'zod';
import { lspServerIdSchema } from './lsp.js';

export const semanticIdSchema = z.string().uuid();
export const semanticPreviewIdSchema = z.string().uuid();
const agentIdSchema = z.string().min(1).max(256);
const semanticPathSchema = z.string().min(1).max(4096);
const semanticMemoryNameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const semanticPositionSchema = z.object({
  line: z.number().int().nonnegative().max(10_000_000),
  character: z.number().int().nonnegative().max(10_000_000),
});
const semanticPositionedPathSchema = z.object({
  path: semanticPathSchema,
  ...semanticPositionSchema.shape,
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
const semanticSessionInputSchema = z.object({ semantic_id: semanticIdSchema });

export const terminalSemanticSymbolsSchema = terminalSemanticSessionSchema.extend({ path: semanticPathSchema });
export type TerminalSemanticSymbolsArgs = z.infer<typeof terminalSemanticSymbolsSchema>;

export const terminalSemanticFindSymbolsSchema = terminalSemanticSessionSchema.extend({ query: z.string().min(1).max(512) });
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

export const terminalSemanticDiagnosticsSchema = terminalSemanticSessionSchema.extend({ path: semanticPathSchema });
export type TerminalSemanticDiagnosticsArgs = z.infer<typeof terminalSemanticDiagnosticsSchema>;

export const terminalSemanticCloseSchema = terminalSemanticSessionSchema;
export type TerminalSemanticCloseArgs = z.infer<typeof terminalSemanticCloseSchema>;

export const semanticEditSchema = z.discriminatedUnion('operation', [
  semanticPositionedPathSchema.extend({
    operation: z.literal('rename'),
    new_name: z.string().min(1).max(256),
  }),
  semanticPositionedPathSchema.extend({
    operation: z.literal('replace_symbol'),
    content: z.string().max(262_144),
  }),
  semanticPositionedPathSchema.extend({
    operation: z.literal('insert_before'),
    content: z.string().max(262_144),
  }),
  semanticPositionedPathSchema.extend({
    operation: z.literal('insert_after'),
    content: z.string().max(262_144),
  }),
  semanticPositionedPathSchema.extend({ operation: z.literal('safe_delete') }),
]);
export type SemanticEdit = z.infer<typeof semanticEditSchema>;

export const terminalSemanticPreviewEditSchema = terminalSemanticSessionSchema.extend({ edit: semanticEditSchema });
export type TerminalSemanticPreviewEditArgs = z.infer<typeof terminalSemanticPreviewEditSchema>;
export const semanticPreviewEditInputSchema = semanticSessionInputSchema.extend({ edit: semanticEditSchema });
export type SemanticPreviewEditInput = z.infer<typeof semanticPreviewEditInputSchema>;

export const terminalSemanticApplyEditSchema = terminalSemanticSessionSchema.extend({ preview_id: semanticPreviewIdSchema });
export type TerminalSemanticApplyEditArgs = z.infer<typeof terminalSemanticApplyEditSchema>;
export const semanticApplyEditInputSchema = semanticSessionInputSchema.extend({ preview_id: semanticPreviewIdSchema });
export type SemanticApplyEditInput = z.infer<typeof semanticApplyEditInputSchema>;

export const terminalSemanticProjectOverviewSchema = terminalSemanticSessionSchema;
export type TerminalSemanticProjectOverviewArgs = z.infer<typeof terminalSemanticProjectOverviewSchema>;
export const semanticProjectOverviewInputSchema = semanticSessionInputSchema;
export type SemanticProjectOverviewInput = z.infer<typeof semanticProjectOverviewInputSchema>;

export const terminalSemanticMemoryReadSchema = terminalSemanticSessionSchema.extend({ name: semanticMemoryNameSchema });
export type TerminalSemanticMemoryReadArgs = z.infer<typeof terminalSemanticMemoryReadSchema>;
export const semanticMemoryReadInputSchema = semanticSessionInputSchema.extend({ name: semanticMemoryNameSchema });
export type SemanticMemoryReadInput = z.infer<typeof semanticMemoryReadInputSchema>;

export const terminalSemanticMemoryWriteSchema = terminalSemanticSessionSchema.extend({
  name: semanticMemoryNameSchema,
  content: z.string().max(65_536),
});
export type TerminalSemanticMemoryWriteArgs = z.infer<typeof terminalSemanticMemoryWriteSchema>;
export const semanticMemoryWriteInputSchema = semanticSessionInputSchema.extend({
  name: semanticMemoryNameSchema,
  content: z.string().max(65_536),
});
export type SemanticMemoryWriteInput = z.infer<typeof semanticMemoryWriteInputSchema>;

const semanticQueryBaseSchema = z.object({ semantic_id: semanticIdSchema });
export const semanticQueryInputSchema = z.discriminatedUnion('operation', [
  semanticQueryBaseSchema.extend({ operation: z.literal('document_symbols'), path: semanticPathSchema }),
  semanticQueryBaseSchema.extend({ operation: z.literal('workspace_symbols'), query: z.string().min(1).max(512) }),
  semanticQueryBaseSchema.extend({
    operation: z.literal('references'), path: semanticPathSchema, ...semanticPositionSchema.shape,
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

export const semanticCloseOutputSchema = z.object({ semantic_id: semanticIdSchema, stopped: z.boolean() });
export type SemanticCloseOutput = z.infer<typeof semanticCloseOutputSchema>;

export const semanticPreviewFileSchema = z.object({
  path: z.string().min(1).max(4096),
  expected_digest: z.string().regex(/^[a-f0-9]{64}$/),
  next_digest: z.string().regex(/^[a-f0-9]{64}$/),
  edit_count: z.number().int().positive().max(10_000),
});
export type SemanticPreviewFile = z.infer<typeof semanticPreviewFileSchema>;

export const semanticPreviewEditOutputSchema = z.object({
  semantic_id: semanticIdSchema,
  preview_id: semanticPreviewIdSchema,
  operation: z.enum(['rename', 'replace_symbol', 'insert_before', 'insert_after', 'safe_delete']),
  workspace_digest: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(semanticPreviewFileSchema).min(1).max(64),
  diff: z.string().max(65_536),
  truncated: z.boolean(),
});
export type SemanticPreviewEditOutput = z.infer<typeof semanticPreviewEditOutputSchema>;

export const semanticApplyEditOutputSchema = z.object({
  semantic_id: semanticIdSchema,
  preview_id: semanticPreviewIdSchema,
  applied_files: z.array(z.string().min(1).max(4096)).min(1).max(64),
  revision_digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SemanticApplyEditOutput = z.infer<typeof semanticApplyEditOutputSchema>;

export const semanticProjectOverviewOutputSchema = z.object({
  semantic_id: semanticIdSchema,
  root: z.string().min(1).max(4096),
  server_id: lspServerIdSchema,
  languages: z.array(z.object({ language: z.string().min(1).max(64), files: z.number().int().nonnegative() })).max(64),
  package_managers: z.array(z.string().min(1).max(64)).max(32),
  manifests: z.array(z.string().min(1).max(4096)).max(64),
  commands: z.record(z.string().max(256), z.string().max(4096)),
  memories: z.array(semanticMemoryNameSchema).max(256),
  truncated: z.boolean(),
});
export type SemanticProjectOverviewOutput = z.infer<typeof semanticProjectOverviewOutputSchema>;

export const semanticMemoryOutputSchema = z.object({
  semantic_id: semanticIdSchema,
  name: semanticMemoryNameSchema,
  content: z.string().max(65_536),
  updated_at: z.string().datetime(),
});
export type SemanticMemoryOutput = z.infer<typeof semanticMemoryOutputSchema>;

export const semanticQueryOutputSchema = z.union([
  semanticSymbolsOutputSchema,
  semanticWorkspaceSymbolsOutputSchema,
  semanticLocationsOutputSchema,
  semanticDiagnosticsOutputSchema,
]);
export type SemanticQueryOutput = z.infer<typeof semanticQueryOutputSchema>;
