import {
  TerminalProtocolError,
  terminalListAgentsOutputSchema,
  terminalCancelCodeToolSchema,
  terminalExecuteCodeBlockToolSchema,
  terminalLspRequestSchema,
  terminalLspStartSchema,
  terminalLspStopSchema,
  terminalSemanticCloseSchema,
  terminalSemanticDefinitionSchema,
  terminalSemanticDiagnosticsSchema,
  terminalSemanticFindSymbolsSchema,
  terminalSemanticImplementationsSchema,
  terminalSemanticOpenSchema,
  terminalSemanticReferencesSchema,
  terminalSemanticSymbolsSchema,
  terminalMutationOutputSchema,
  terminalReadInputSchema,
  terminalSessionIdInputSchema,
  terminalStartInputSchema,
  terminalStartOutputSchema,
  terminalStatusOutputSchema,
  terminalWriteInputSchema,
  terminalResizeInputSchema,
  terminalWorkspaceRootsInputSchema,
  terminalWorkspaceRootMutationInputSchema,
  type CodeCancelOutput,
  type CodeExecuteOutput,
  type ExecutionProfile,
  type LspRequestOutput,
  type LspStartOutput,
  type LspStopOutput,
  type SemanticCloseOutput,
  type SemanticDiagnosticsOutput,
  type SemanticLocationsOutput,
  type SemanticOpenOutput,
  type SemanticSymbolsOutput,
  type SemanticWorkspaceSymbolsOutput,
  type TerminalCancelCodeToolArgs,
  type TerminalExecuteCodeBlockToolArgs,
  type TerminalLspRequestArgs,
  type TerminalLspStartArgs,
  type TerminalLspStopArgs,
  type TerminalSemanticCloseArgs,
  type TerminalSemanticDefinitionArgs,
  type TerminalSemanticDiagnosticsArgs,
  type TerminalSemanticFindSymbolsArgs,
  type TerminalSemanticImplementationsArgs,
  type TerminalSemanticOpenArgs,
  type TerminalSemanticReferencesArgs,
  type TerminalSemanticSymbolsArgs,
  type TerminalListAgentsOutput,
  type TerminalMutationOutput,
  type TerminalReadInput,
  type TerminalReadOutput,
  type TerminalStartInput,
  type TerminalStartOutput,
  type TerminalStatusOutput,
  type TerminalWorkspaceRootsOutput,
} from '@terminal/protocol';
import type { AuditLogger } from './audit.js';
import type { ServerConfig } from './config.js';
import type { AgentGateway } from './gateway.js';

export interface RequestIdentity {
  userId: string;
  clientId: string;
  executionProfile: ExecutionProfile;
  mcpSessionId?: string;
  chatgptSessionId?: string;
}

export class TerminalService {
  private readonly startingByUser = new Map<string, number>();
  private readonly startingByAgent = new Map<string, number>();

  constructor(
    private readonly gateway: AgentGateway,
    private readonly config: ServerConfig,
    private readonly audit: AuditLogger,
  ) {}

  async listAgents(identity: RequestIdentity): Promise<TerminalListAgentsOutput> {
    const output = terminalListAgentsOutputSchema.parse({ agents: this.gateway.listAgents(identity.userId) });
    await this.audit.record({
      action: 'terminal_list_agents',
      ...auditIdentity(identity),
      authorization: 'allow',
      output_metadata: { agent_count: output.agents.length },
    });
    return output;
  }

  async start(identity: RequestIdentity, rawInput: TerminalStartInput): Promise<TerminalStartOutput> {
    const input = terminalStartInputSchema.parse(rawInput);
    await this.assertMutationAllowed(identity, 'terminal_start', { agent_id: input.agent_id, cwd: input.cwd, shell: input.shell });
    const active = this.gateway.listSessions(identity.userId).filter((session) => isActive(session.status));
    const agentReservationKey = `${identity.userId}\0${input.agent_id}`;
    const reservedForUser = this.startingByUser.get(identity.userId) ?? 0;
    const reservedForAgent = this.startingByAgent.get(agentReservationKey) ?? 0;
    if (this.config.maxSessionsPerUser > 0 && active.length + reservedForUser >= this.config.maxSessionsPerUser) {
      await this.denied(identity, 'terminal_start', 'SESSION_LIMIT_REACHED', { agent_id: input.agent_id });
      throw new TerminalProtocolError('SESSION_LIMIT_REACHED', 'User terminal session quota has been reached.');
    }
    if (this.config.maxSessionsPerAgent > 0 && active.filter((session) => session.agent_id === input.agent_id).length + reservedForAgent >= this.config.maxSessionsPerAgent) {
      await this.denied(identity, 'terminal_start', 'SESSION_LIMIT_REACHED', { agent_id: input.agent_id });
      throw new TerminalProtocolError('SESSION_LIMIT_REACHED', 'Agent terminal session quota has been reached.');
    }

    const reserveUser = this.config.maxSessionsPerUser > 0;
    const reserveAgent = this.config.maxSessionsPerAgent > 0;
    if (reserveUser) incrementCount(this.startingByUser, identity.userId);
    if (reserveAgent) incrementCount(this.startingByAgent, agentReservationKey);
    let snapshot;
    try {
      snapshot = await this.gateway.start(identity.userId, input, identity.executionProfile);
    } finally {
      if (reserveUser) decrementCount(this.startingByUser, identity.userId);
      if (reserveAgent) decrementCount(this.startingByAgent, agentReservationKey);
    }
    // Do not long-poll during creation: terminal_start must return the stream capability immediately.
    const initial = await this.gateway.read(identity.userId, snapshot.session.session_id, 0, this.config.maxReadBytes, 0);
    const output = terminalStartOutputSchema.parse({
      session_id: snapshot.session.session_id,
      status: initial.status,
      cursor: initial.next_cursor,
      initial_output: initial.output,
    });
    await this.audit.record({
      action: 'terminal_start',
      ...auditIdentity(identity),
      agent_id: snapshot.session.agent_id,
      terminal_session_id: snapshot.session.session_id,
      authorization: 'allow',
      input: { cwd: input.cwd, shell: input.shell, command: input.command ? '[command recorded in transcript]' : undefined, cols: input.cols, rows: input.rows },
      output_metadata: { status: output.status, cursor: output.cursor },
    });
    return output;
  }

  async read(identity: RequestIdentity, rawInput: TerminalReadInput): Promise<TerminalReadOutput> {
    const input = terminalReadInputSchema.parse(rawInput);
    const maxBytes = Math.min(input.max_bytes ?? this.config.maxReadBytes, this.config.maxReadBytes);
    const output = await this.gateway.read(identity.userId, input.session_id, input.after, maxBytes, input.wait_ms ?? 0);
    await this.audit.record({
      action: 'terminal_read',
      ...auditIdentity(identity),
      terminal_session_id: input.session_id,
      sequence: output.next_cursor,
      authorization: 'allow',
      input: { after: input.after, max_bytes: maxBytes, wait_ms: input.wait_ms ?? 0 },
      output_metadata: { event_count: output.events.length, output_bytes: Buffer.byteLength(output.output), has_more: output.has_more, status: output.status },
    });
    return output;
  }

  async write(identity: RequestIdentity, rawInput: { session_id: string; text: string }): Promise<TerminalMutationOutput> {
    const input = terminalWriteInputSchema.parse(rawInput);
    await this.assertMutationAllowed(identity, 'terminal_write', { session_id: input.session_id });
    const snapshot = await this.gateway.write(identity.userId, input.session_id, input.text);
    await this.audit.record({
      action: 'terminal_write',
      ...auditIdentity(identity),
      agent_id: snapshot.session.agent_id,
      terminal_session_id: input.session_id,
      sequence: snapshot.cursor,
      authorization: 'allow',
      input: { bytes: Buffer.byteLength(input.text) },
      output_metadata: { status: snapshot.session.status },
    });
    return terminalMutationOutputSchema.parse({ session_id: input.session_id, status: snapshot.session.status, cursor: snapshot.cursor });
  }

  async resize(identity: RequestIdentity, rawInput: { session_id: string; cols: number; rows: number }): Promise<TerminalMutationOutput> {
    const input = terminalResizeInputSchema.parse(rawInput);
    await this.assertMutationAllowed(identity, 'terminal_resize', { session_id: input.session_id });
    const snapshot = await this.gateway.resize(identity.userId, input.session_id, input.cols, input.rows);
    await this.audit.record({
      action: 'terminal_resize',
      ...auditIdentity(identity),
      agent_id: snapshot.session.agent_id,
      terminal_session_id: input.session_id,
      sequence: snapshot.cursor,
      authorization: 'allow',
      input: { cols: input.cols, rows: input.rows },
    });
    return terminalMutationOutputSchema.parse({ session_id: input.session_id, status: snapshot.session.status, cursor: snapshot.cursor });
  }

  async interrupt(identity: RequestIdentity, sessionId: string): Promise<TerminalMutationOutput> {
    const input = terminalSessionIdInputSchema.parse({ session_id: sessionId });
    await this.assertMutationAllowed(identity, 'terminal_interrupt', { session_id: input.session_id });
    const snapshot = await this.gateway.interrupt(identity.userId, input.session_id);
    await this.audit.record({
      action: 'terminal_interrupt',
      ...auditIdentity(identity),
      agent_id: snapshot.session.agent_id,
      terminal_session_id: input.session_id,
      sequence: snapshot.cursor,
      authorization: 'allow',
    });
    return terminalMutationOutputSchema.parse({ session_id: input.session_id, status: snapshot.session.status, cursor: snapshot.cursor });
  }

  async status(identity: RequestIdentity, sessionId: string): Promise<TerminalStatusOutput> {
    const input = terminalSessionIdInputSchema.parse({ session_id: sessionId });
    const snapshot = await this.gateway.status(identity.userId, input.session_id);
    const agentOnline = this.gateway.listAgents(identity.userId).some((agent) => agent.agent_id === snapshot.session.agent_id && agent.online);
    const metrics = this.gateway.getSessionMetrics(identity.userId, input.session_id);
    const uptimeSeconds = (Date.now() - new Date(snapshot.session.created_at).getTime()) / 1000;
    const output = terminalStatusOutputSchema.parse({
      ...snapshot.session,
      agent_online: agentOnline,
      cursor: snapshot.cursor,
      uptime_seconds: Math.max(0, Math.round(uptimeSeconds)),
      total_events: metrics?.totalEvents ?? 0,
      total_output_bytes: metrics?.totalOutputBytes ?? 0,
      command_count: metrics?.commandCount ?? 0,
    });
    await this.audit.record({
      action: 'terminal_status',
      ...auditIdentity(identity),
      agent_id: snapshot.session.agent_id,
      terminal_session_id: input.session_id,
      sequence: snapshot.cursor,
      authorization: 'allow',
      output_metadata: { status: snapshot.session.status, agent_online: agentOnline },
    });
    return output;
  }

  async close(identity: RequestIdentity, sessionId: string): Promise<TerminalMutationOutput> {
    const input = terminalSessionIdInputSchema.parse({ session_id: sessionId });
    await this.assertMutationAllowed(identity, 'terminal_close', { session_id: input.session_id });
    const snapshot = await this.gateway.close(identity.userId, input.session_id);
    await this.audit.record({
      action: 'terminal_close',
      ...auditIdentity(identity),
      agent_id: snapshot.session.agent_id,
      terminal_session_id: input.session_id,
      sequence: snapshot.cursor,
      authorization: 'allow',
      output_metadata: { status: snapshot.session.status },
    });
    return terminalMutationOutputSchema.parse({ session_id: input.session_id, status: snapshot.session.status, cursor: snapshot.cursor });
  }

  async transcript(identity: RequestIdentity, input: { session_id: string; max_entries: number; after_sequence: number; include_output: boolean }): Promise<{ session_id: string; entries: Array<{ type: string; timestamp: string; text: string }>; next_sequence: number; has_more: boolean }> {
    const result = this.gateway.getTranscript(identity.userId, input.session_id, input.max_entries, input.after_sequence, input.include_output);
    await this.audit.record({
      action: 'terminal_transcript',
      ...auditIdentity(identity),
      terminal_session_id: input.session_id,
      authorization: 'allow',
      output_metadata: { entries: result.entries.length, next_sequence: result.next_sequence },
    });
    return { session_id: input.session_id, ...result };
  }

  // --- File operations ---

  async readFile(identity: RequestIdentity, input: { session_id: string; path: string; max_bytes: number }): Promise<unknown> {
    await this.audit.record({
      action: 'file_read',
      ...auditIdentity(identity),
      terminal_session_id: input.session_id,
      authorization: 'allow',
      input: { path: input.path },
    });
    return this.gateway.readFile(identity.userId, input.session_id, input.path, input.max_bytes);
  }

  async listFiles(identity: RequestIdentity, input: { session_id: string; path: string; max_entries: number }): Promise<unknown> {
    await this.audit.record({
      action: 'file_list',
      ...auditIdentity(identity),
      terminal_session_id: input.session_id,
      authorization: 'allow',
      input: { path: input.path },
    });
    return this.gateway.listFiles(identity.userId, input.session_id, input.path, input.max_entries);
  }

  async searchFiles(identity: RequestIdentity, input: { session_id: string; pattern: string; path: string; include?: string | undefined; max_results: number; context_lines: number }): Promise<unknown> {
    await this.audit.record({
      action: 'file_search',
      ...auditIdentity(identity),
      terminal_session_id: input.session_id,
      authorization: 'allow',
      input: { pattern: input.pattern, path: input.path },
    });
    return this.gateway.searchFiles(identity.userId, input.session_id, input.pattern, input.path, input.include, input.max_results, input.context_lines);
  }

  async writeFile(identity: RequestIdentity, input: { session_id: string; path: string; content: string; create_directories: boolean }): Promise<unknown> {
    await this.assertMutationAllowed(identity, 'file_write', { path: input.path });
    await this.audit.record({
      action: 'file_write',
      ...auditIdentity(identity),
      terminal_session_id: input.session_id,
      authorization: 'allow',
      input: { path: input.path, bytes: Buffer.byteLength(input.content) },
    });
    return this.gateway.writeFile(identity.userId, input.session_id, input.path, input.content, input.create_directories);
  }

  async deleteFile(identity: RequestIdentity, input: { session_id: string; path: string }): Promise<unknown> {
    await this.assertMutationAllowed(identity, 'file_delete', { path: input.path });
    await this.audit.record({
      action: 'file_delete',
      ...auditIdentity(identity),
      terminal_session_id: input.session_id,
      authorization: 'allow',
      input: { path: input.path },
    });
    return this.gateway.deleteFile(identity.userId, input.session_id, input.path);
  }

  async renameFile(identity: RequestIdentity, input: { session_id: string; from_path: string; to_path: string }): Promise<unknown> {
    await this.assertMutationAllowed(identity, 'file_rename', { from_path: input.from_path, to_path: input.to_path });
    await this.audit.record({
      action: 'file_rename',
      ...auditIdentity(identity),
      terminal_session_id: input.session_id,
      authorization: 'allow',
      input: { from_path: input.from_path, to_path: input.to_path },
    });
    return this.gateway.renameFile(identity.userId, input.session_id, input.from_path, input.to_path);
  }

  async getWorkspaceRoots(identity: RequestIdentity, rawInput: { agent_id: string }): Promise<TerminalWorkspaceRootsOutput> {
    const input = terminalWorkspaceRootsInputSchema.parse(rawInput);
    const output = await this.gateway.getWorkspaceRoots(identity.userId, input.agent_id);
    await this.audit.record({
      action: 'workspace_roots_list', ...auditIdentity(identity), agent_id: input.agent_id,
      authorization: 'allow', output_metadata: { root_count: output.roots.length },
    });
    return output;
  }

  async addWorkspaceRoot(identity: RequestIdentity, rawInput: { agent_id: string; root: string }): Promise<TerminalWorkspaceRootsOutput> {
    const input = terminalWorkspaceRootMutationInputSchema.parse(rawInput);
    await this.assertMutationAllowed(identity, 'workspace_root_add', { agent_id: input.agent_id, root: input.root });
    const output = await this.gateway.addWorkspaceRoot(identity.userId, input.agent_id, input.root);
    await this.audit.record({
      action: 'workspace_root_add', ...auditIdentity(identity), agent_id: input.agent_id, authorization: 'allow',
      input: { root: input.root }, output_metadata: { root_count: output.roots.length },
    });
    return output;
  }

  async removeWorkspaceRoot(identity: RequestIdentity, rawInput: { agent_id: string; root: string }): Promise<TerminalWorkspaceRootsOutput> {
    const input = terminalWorkspaceRootMutationInputSchema.parse(rawInput);
    await this.assertMutationAllowed(identity, 'workspace_root_remove', { agent_id: input.agent_id, root: input.root });
    const output = await this.gateway.removeWorkspaceRoot(identity.userId, input.agent_id, input.root);
    await this.audit.record({
      action: 'workspace_root_remove', ...auditIdentity(identity), agent_id: input.agent_id, authorization: 'allow',
      input: { root: input.root }, output_metadata: { root_count: output.roots.length },
    });
    return output;
  }

  async executeCode(
    identity: RequestIdentity,
    rawInput: TerminalExecuteCodeBlockToolArgs,
    onChunk?: (stream: 'stdout' | 'stderr', chunk: string) => void,
  ): Promise<CodeExecuteOutput> {
    const input = terminalExecuteCodeBlockToolSchema.parse(rawInput);
    await this.assertMutationAllowed(identity, 'terminal_execute_code_block', {
      agent_id: input.agent_id,
      runtime: input.runtime,
      cwd: input.cwd,
      timeout_ms: input.timeout_ms,
      code_bytes: Buffer.byteLength(input.code),
    });
    const output = await this.gateway.executeCode(identity.userId, input, identity.executionProfile, onChunk);
    await this.audit.record({
      action: 'terminal_execute_code_block', ...auditIdentity(identity), agent_id: input.agent_id,
      authorization: 'allow', input: { runtime: input.runtime, cwd: input.cwd, timeout_ms: input.timeout_ms, code_bytes: Buffer.byteLength(input.code) },
      output_metadata: { execution_id: output.execution_id, exit_code: output.exit_code, timed_out: output.timed_out, stdout_bytes: Buffer.byteLength(output.stdout), stderr_bytes: Buffer.byteLength(output.stderr) },
    });
    return output;
  }

  async cancelCode(identity: RequestIdentity, rawInput: TerminalCancelCodeToolArgs): Promise<CodeCancelOutput> {
    const input = terminalCancelCodeToolSchema.parse(rawInput);
    await this.assertMutationAllowed(identity, 'terminal_cancel_code', { agent_id: input.agent_id, execution_id: input.execution_id });
    const output = await this.gateway.cancelCode(identity.userId, input.agent_id, input.execution_id, identity.executionProfile);
    await this.audit.record({
      action: 'terminal_cancel_code', ...auditIdentity(identity), agent_id: input.agent_id,
      authorization: 'allow', input: { execution_id: input.execution_id }, output_metadata: { cancelled: output.cancelled },
    });
    return output;
  }

  async openSemantic(identity: RequestIdentity, rawInput: TerminalSemanticOpenArgs): Promise<SemanticOpenOutput> {
    const input = terminalSemanticOpenSchema.parse(rawInput);
    const output = await this.gateway.openSemantic(identity.userId, input, identity.executionProfile);
    await this.audit.record({
      action: 'terminal_semantic_open', ...auditIdentity(identity), agent_id: input.agent_id,
      authorization: 'allow', input: { server_id: input.server_id, root: input.root },
      output_metadata: { semantic_id: output.semantic_id, lsp_id: output.lsp_id },
    });
    return output;
  }

  async semanticSymbols(identity: RequestIdentity, rawInput: TerminalSemanticSymbolsArgs): Promise<SemanticSymbolsOutput> {
    const input = terminalSemanticSymbolsSchema.parse(rawInput);
    const output = await this.gateway.querySemantic(identity.userId, input.agent_id, {
      semantic_id: input.semantic_id, operation: 'document_symbols', path: input.path,
    }, identity.executionProfile) as SemanticSymbolsOutput;
    await this.auditSemanticQuery(identity, input.agent_id, 'terminal_semantic_symbols',
      { semantic_id: input.semantic_id, path: input.path }, output.symbols.length, output.truncated);
    return output;
  }

  async semanticFindSymbols(identity: RequestIdentity, rawInput: TerminalSemanticFindSymbolsArgs): Promise<SemanticWorkspaceSymbolsOutput> {
    const input = terminalSemanticFindSymbolsSchema.parse(rawInput);
    const output = await this.gateway.querySemantic(identity.userId, input.agent_id, {
      semantic_id: input.semantic_id, operation: 'workspace_symbols', query: input.query,
    }, identity.executionProfile) as SemanticWorkspaceSymbolsOutput;
    await this.auditSemanticQuery(identity, input.agent_id, 'terminal_semantic_find_symbols',
      { semantic_id: input.semantic_id, query: input.query }, output.symbols.length, output.truncated);
    return output;
  }

  async semanticReferences(identity: RequestIdentity, rawInput: TerminalSemanticReferencesArgs): Promise<SemanticLocationsOutput> {
    const input = terminalSemanticReferencesSchema.parse(rawInput);
    const output = await this.gateway.querySemantic(identity.userId, input.agent_id, {
      semantic_id: input.semantic_id, operation: 'references', path: input.path,
      line: input.line, character: input.character, include_declaration: input.include_declaration,
    }, identity.executionProfile) as SemanticLocationsOutput;
    await this.auditSemanticQuery(identity, input.agent_id, 'terminal_semantic_references',
      { semantic_id: input.semantic_id, path: input.path, line: input.line, character: input.character },
      output.locations.length, output.truncated);
    return output;
  }

  async semanticDefinition(identity: RequestIdentity, rawInput: TerminalSemanticDefinitionArgs): Promise<SemanticLocationsOutput> {
    const input = terminalSemanticDefinitionSchema.parse(rawInput);
    const output = await this.gateway.querySemantic(identity.userId, input.agent_id, {
      semantic_id: input.semantic_id, operation: 'definition', path: input.path,
      line: input.line, character: input.character,
    }, identity.executionProfile) as SemanticLocationsOutput;
    await this.auditSemanticQuery(identity, input.agent_id, 'terminal_semantic_definition',
      { semantic_id: input.semantic_id, path: input.path, line: input.line, character: input.character },
      output.locations.length, output.truncated);
    return output;
  }

  async semanticImplementations(identity: RequestIdentity, rawInput: TerminalSemanticImplementationsArgs): Promise<SemanticLocationsOutput> {
    const input = terminalSemanticImplementationsSchema.parse(rawInput);
    const output = await this.gateway.querySemantic(identity.userId, input.agent_id, {
      semantic_id: input.semantic_id, operation: 'implementations', path: input.path,
      line: input.line, character: input.character,
    }, identity.executionProfile) as SemanticLocationsOutput;
    await this.auditSemanticQuery(identity, input.agent_id, 'terminal_semantic_implementations',
      { semantic_id: input.semantic_id, path: input.path, line: input.line, character: input.character },
      output.locations.length, output.truncated);
    return output;
  }

  async semanticDiagnostics(identity: RequestIdentity, rawInput: TerminalSemanticDiagnosticsArgs): Promise<SemanticDiagnosticsOutput> {
    const input = terminalSemanticDiagnosticsSchema.parse(rawInput);
    const output = await this.gateway.querySemantic(identity.userId, input.agent_id, {
      semantic_id: input.semantic_id, operation: 'diagnostics', path: input.path,
    }, identity.executionProfile) as SemanticDiagnosticsOutput;
    await this.auditSemanticQuery(identity, input.agent_id, 'terminal_semantic_diagnostics',
      { semantic_id: input.semantic_id, path: input.path }, output.diagnostics.length, output.truncated);
    return output;
  }

  async closeSemantic(identity: RequestIdentity, rawInput: TerminalSemanticCloseArgs): Promise<SemanticCloseOutput> {
    const input = terminalSemanticCloseSchema.parse(rawInput);
    const output = await this.gateway.closeSemantic(identity.userId, input, identity.executionProfile);
    await this.audit.record({
      action: 'terminal_semantic_close', ...auditIdentity(identity), agent_id: input.agent_id,
      authorization: 'allow', input: { semantic_id: input.semantic_id }, output_metadata: { stopped: output.stopped },
    });
    return output;
  }

  private async auditSemanticQuery(
    identity: RequestIdentity,
    agentId: string,
    action: string,
    input: unknown,
    resultCount: number,
    truncated: boolean,
  ): Promise<void> {
    await this.audit.record({
      action, ...auditIdentity(identity), agent_id: agentId, authorization: 'allow', input,
      output_metadata: { result_count: resultCount, truncated },
    });
  }

  async startLsp(identity: RequestIdentity, rawInput: TerminalLspStartArgs): Promise<LspStartOutput> {
    const input = terminalLspStartSchema.parse(rawInput);
    await this.assertMutationAllowed(identity, 'terminal_lsp_start', { agent_id: input.agent_id, server_id: input.server_id, root: input.root });
    const output = await this.gateway.startLsp(identity.userId, input, identity.executionProfile);
    await this.audit.record({
      action: 'terminal_lsp_start', ...auditIdentity(identity), agent_id: input.agent_id,
      authorization: 'allow', input: { server_id: input.server_id, root: input.root }, output_metadata: { lsp_id: output.lsp_id },
    });
    return output;
  }

  async requestLsp(identity: RequestIdentity, rawInput: TerminalLspRequestArgs): Promise<LspRequestOutput> {
    const input = terminalLspRequestSchema.parse(rawInput);
    await this.assertMutationAllowed(identity, 'terminal_lsp_request', { agent_id: input.agent_id, lsp_id: input.lsp_id, method: input.method, notification: input.notification ?? false });
    const output = await this.gateway.requestLsp(identity.userId, input, identity.executionProfile);
    await this.audit.record({
      action: 'terminal_lsp_request', ...auditIdentity(identity), agent_id: input.agent_id,
      authorization: 'allow', input: { lsp_id: input.lsp_id, method: input.method, notification: input.notification ?? false },
    });
    return output;
  }

  async stopLsp(identity: RequestIdentity, rawInput: TerminalLspStopArgs): Promise<LspStopOutput> {
    const input = terminalLspStopSchema.parse(rawInput);
    await this.assertMutationAllowed(identity, 'terminal_lsp_stop', { agent_id: input.agent_id, lsp_id: input.lsp_id });
    const output = await this.gateway.stopLsp(identity.userId, input, identity.executionProfile);
    await this.audit.record({
      action: 'terminal_lsp_stop', ...auditIdentity(identity), agent_id: input.agent_id,
      authorization: 'allow', input: { lsp_id: input.lsp_id }, output_metadata: { stopped: output.stopped },
    });
    return output;
  }

  private async assertMutationAllowed(identity: RequestIdentity, action: string, input?: unknown): Promise<void> {
    if (identity.executionProfile !== 'read-only') return;
    await this.denied(identity, action, 'PERMISSION_DENIED', input);
    throw new TerminalProtocolError('PERMISSION_DENIED', 'The active execution profile is read-only.');
  }

  private async denied(identity: RequestIdentity, action: string, errorCode: string, input?: unknown): Promise<void> {
    await this.audit.record({
      action,
      ...auditIdentity(identity),
      authorization: 'deny',
      error_code: errorCode,
      ...(input === undefined ? {} : { input }),
    });
  }
}

function auditIdentity(identity: RequestIdentity) {
  return {
    user_id: identity.userId,
    client_id: identity.clientId,
    execution_profile: identity.executionProfile,
    ...(identity.mcpSessionId ? { mcp_session_id: identity.mcpSessionId } : {}),
    ...(identity.chatgptSessionId ? { chatgpt_session_id: identity.chatgptSessionId } : {}),
  };
}

function isActive(status: string): boolean {
  return status === 'creating' || status === 'running' || status === 'waiting' || status === 'closing' || status === 'disconnected';
}

function incrementCount(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function decrementCount(counts: Map<string, number>, key: string): void {
  const next = (counts.get(key) ?? 1) - 1;
  if (next <= 0) counts.delete(key);
  else counts.set(key, next);
}
