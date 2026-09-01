import {
  TerminalProtocolError,
  terminalListAgentsOutputSchema,
  terminalMutationOutputSchema,
  terminalReadInputSchema,
  terminalSessionIdInputSchema,
  terminalStartInputSchema,
  terminalStartOutputSchema,
  terminalStatusOutputSchema,
  terminalWriteInputSchema,
  terminalResizeInputSchema,
  type ExecutionProfile,
  type TerminalListAgentsOutput,
  type TerminalMutationOutput,
  type TerminalReadInput,
  type TerminalReadOutput,
  type TerminalStartInput,
  type TerminalStartOutput,
  type TerminalStatusOutput,
} from '@terminal/protocol';
import type { AuditLogger } from './audit.js';
import type { ServerConfig } from './config.js';
import type { AgentGateway } from './gateway.js';

export interface RequestIdentity {
  userId: string;
  clientId: string;
  executionProfile: ExecutionProfile;
  chatgptSessionId?: string;
}

export class TerminalService {
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
    if (active.length >= this.config.maxSessionsPerUser) {
      await this.denied(identity, 'terminal_start', 'SESSION_LIMIT_REACHED', { agent_id: input.agent_id });
      throw new TerminalProtocolError('SESSION_LIMIT_REACHED', 'User terminal session quota has been reached.');
    }
    if (active.filter((session) => session.agent_id === input.agent_id).length >= this.config.maxSessionsPerAgent) {
      await this.denied(identity, 'terminal_start', 'SESSION_LIMIT_REACHED', { agent_id: input.agent_id });
      throw new TerminalProtocolError('SESSION_LIMIT_REACHED', 'Agent terminal session quota has been reached.');
    }

    const snapshot = await this.gateway.start(identity.userId, input, identity.executionProfile);
    const initial = await this.gateway.read(identity.userId, snapshot.session.session_id, 0, this.config.maxReadBytes, 200);
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
    const output = terminalStatusOutputSchema.parse({ ...snapshot.session, agent_online: agentOnline, cursor: snapshot.cursor });
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
    ...(identity.chatgptSessionId ? { chatgpt_session_id: identity.chatgptSessionId } : {}),
  };
}

function isActive(status: string): boolean {
  return status === 'creating' || status === 'running' || status === 'waiting' || status === 'closing' || status === 'disconnected';
}
