import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  agentCommandSchema,
  terminalSemanticCloseSchema,
  terminalSemanticDefinitionSchema,
  terminalSemanticDiagnosticsSchema,
  terminalSemanticFindSymbolsSchema,
  terminalSemanticImplementationsSchema,
  terminalSemanticOpenSchema,
  terminalSemanticPreviewEditSchema,
  terminalSemanticApplyEditSchema,
  terminalSemanticProjectOverviewSchema,
  terminalSemanticMemoryReadSchema,
  terminalSemanticMemoryWriteSchema,
  terminalSemanticReferencesSchema,
  terminalSemanticSymbolsSchema,
} from '../../packages/protocol/src/index.js';

describe('Serena-style semantic protocol', () => {
  it('validates model-facing semantic tool inputs with bounded paths and positions', () => {
    const semanticId = randomUUID();
    expect(terminalSemanticOpenSchema.parse({ agent_id: 'agent-a', server_id: 'typescript', root: '/workspace' }))
      .toMatchObject({ server_id: 'typescript', root: '/workspace' });
    expect(terminalSemanticSymbolsSchema.parse({ agent_id: 'agent-a', semantic_id: semanticId, path: 'src/a.ts' }))
      .toMatchObject({ semantic_id: semanticId, path: 'src/a.ts' });
    expect(terminalSemanticFindSymbolsSchema.parse({ agent_id: 'agent-a', semantic_id: semanticId, query: 'TerminalService' }))
      .toMatchObject({ query: 'TerminalService' });
    expect(terminalSemanticReferencesSchema.parse({
      agent_id: 'agent-a', semantic_id: semanticId, path: 'src/a.ts', line: 4, character: 7, include_declaration: true,
    })).toMatchObject({ line: 4, character: 7, include_declaration: true });
    expect(terminalSemanticDefinitionSchema.safeParse({
      agent_id: 'agent-a', semantic_id: semanticId, path: 'src/a.ts', line: -1, character: 0,
    }).success).toBe(false);
    expect(terminalSemanticImplementationsSchema.parse({
      agent_id: 'agent-a', semantic_id: semanticId, path: 'src/a.ts', line: 1, character: 2,
    })).toMatchObject({ line: 1, character: 2 });
    expect(terminalSemanticDiagnosticsSchema.parse({ agent_id: 'agent-a', semantic_id: semanticId, path: 'src/a.ts' }))
      .toMatchObject({ path: 'src/a.ts' });
    expect(terminalSemanticCloseSchema.parse({ agent_id: 'agent-a', semantic_id: semanticId }))
      .toMatchObject({ semantic_id: semanticId });
  });

  it('validates preview/apply and project-memory inputs', () => {
    const semanticId = randomUUID();
    const preview = terminalSemanticPreviewEditSchema.parse({
      agent_id: 'agent-a', semantic_id: semanticId,
      edit: { operation: 'rename', path: 'src/a.ts', line: 1, character: 2, new_name: 'Renamed' },
    });
    expect(preview.edit).toMatchObject({ operation: 'rename', new_name: 'Renamed' });
    expect(terminalSemanticApplyEditSchema.parse({ agent_id: 'agent-a', semantic_id: semanticId, preview_id: randomUUID() }))
      .toHaveProperty('preview_id');
    expect(terminalSemanticProjectOverviewSchema.parse({ agent_id: 'agent-a', semantic_id: semanticId }))
      .toMatchObject({ semantic_id: semanticId });
    expect(terminalSemanticMemoryReadSchema.parse({ agent_id: 'agent-a', semantic_id: semanticId, name: 'architecture' }))
      .toMatchObject({ name: 'architecture' });
    expect(terminalSemanticMemoryWriteSchema.safeParse({
      agent_id: 'agent-a', semantic_id: semanticId, name: '../escape', content: 'nope',
    }).success).toBe(false);
  });

  it('accepts only the fixed semantic gateway operations', () => {
    const semanticId = randomUUID();
    const base = { type: 'request' as const, request_id: randomUUID(), user_id: 'user-a', execution_profile: 'read-only' as const };
    expect(agentCommandSchema.safeParse({
      ...base, action: 'semantic.open', input: { server_id: 'typescript', root: '/workspace' },
    }).success).toBe(true);
    expect(agentCommandSchema.safeParse({
      ...base, action: 'semantic.query', input: { semantic_id: semanticId, operation: 'document_symbols', path: 'src/a.ts' },
    }).success).toBe(true);
    expect(agentCommandSchema.safeParse({
      ...base, action: 'semantic.query', input: { semantic_id: semanticId, operation: 'arbitrary/lsp', path: 'src/a.ts' },
    }).success).toBe(false);
    expect(agentCommandSchema.safeParse({
      ...base, action: 'semantic.preview_edit', input: { semantic_id: semanticId, edit: { operation: 'safe_delete', path: 'src/a.ts', line: 1, character: 2 } },
    }).success).toBe(true);
    expect(agentCommandSchema.safeParse({
      ...base, action: 'semantic.apply_edit', input: { semantic_id: semanticId, preview_id: randomUUID() },
    }).success).toBe(true);
    expect(agentCommandSchema.safeParse({
      ...base, action: 'semantic.project_overview', input: { semantic_id: semanticId },
    }).success).toBe(true);
    expect(agentCommandSchema.safeParse({
      ...base, action: 'semantic.memory.read', input: { semantic_id: semanticId, name: 'architecture' },
    }).success).toBe(true);
    expect(agentCommandSchema.safeParse({
      ...base, action: 'semantic.memory.write', input: { semantic_id: semanticId, name: 'architecture', content: 'notes' },
    }).success).toBe(true);
    expect(agentCommandSchema.safeParse({
      ...base, action: 'semantic.close', input: { semantic_id: semanticId },
    }).success).toBe(true);
  });
});
