import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { readlinkSync, realpathSync } from 'node:fs';
import os from 'node:os';
import * as pty from 'node-pty';
import {
  TerminalProtocolError,
  type Agent,
  type ExecutionProfile,
  type TerminalEvent,
  type TerminalEventActor,
  type TerminalEventType,
  type TerminalSession,
  type TerminalStartInput,
} from '@terminal/protocol';

export interface LocalTerminalAgentOptions {
  agentId?: string;
  displayName?: string;
  allowedWorkspaceRoots: string[];
  executionProfile: ExecutionProfile;
  shells?: string[];
  bufferHighWaterBytes?: number;
  maxEventBytes?: number;
  idleTimeoutMs?: number;
  maxLifetimeMs?: number;
  closedSessionRetentionMs?: number;
  sweepIntervalMs?: number;
}

export interface AgentSessionSnapshot {
  session: TerminalSession;
  cursor: number;
  earliestCursor: number;
}

interface ManagedSession {
  pty: pty.IPty;
  metadata: TerminalSession;
  events: TerminalEvent[];
  eventSizes: number[];
  eventHead: number;
  sequence: number;
  retainedBytes: number;
  earliestSequence: number;
  closeRequest?: { actor: TerminalEventActor; reason: string; finalized: boolean };
  cwdRefreshTimer?: NodeJS.Timeout;
}

export interface TerminalAgentApi {
  describe(): Agent;
  listSessions(): TerminalSession[];
  listSessionSnapshots(): AgentSessionSnapshot[];
  start(userId: string, input: TerminalStartInput, requestedProfile: ExecutionProfile): AgentSessionSnapshot;
  write(sessionId: string, text: string, actor?: TerminalEventActor): AgentSessionSnapshot;
  resize(sessionId: string, cols: number, rows: number): AgentSessionSnapshot;
  interrupt(sessionId: string): AgentSessionSnapshot;
  close(sessionId: string): AgentSessionSnapshot;
  status(sessionId: string): AgentSessionSnapshot;
  readEvents(sessionId: string, after: number, maxBytes: number): { events: TerminalEvent[]; nextCursor: number; hasMore: boolean };
  onEvent(listener: (event: TerminalEvent) => void): () => void;
  shutdown(): void;
}

const CONTROL_PLANE_SECRET_ENV = new Set([
  'AGENT_ENROLLMENT_TOKEN',
  'MCP_DEVELOPMENT_TOKEN',
  'STREAM_TOKEN_SECRET',
  'OAUTH_CLIENT_SECRET',
]);

function cleanEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && !CONTROL_PLANE_SECRET_ENV.has(entry[0]),
    ),
  );
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function restrictiveExecutionProfile(localProfile: ExecutionProfile, requestedProfile: ExecutionProfile): ExecutionProfile {
  const rank: Record<ExecutionProfile, number> = { 'read-only': 0, developer: 1, 'owner-full': 2 };
  return rank[localProfile] <= rank[requestedProfile] ? localProfile : requestedProfile;
}

function defaultShells(): string[] {
  if (process.platform === 'win32') {
    return ['pwsh.exe', 'powershell.exe', 'cmd.exe', 'wsl.exe'];
  }

  const configured = process.env.SHELL ? basename(process.env.SHELL) : undefined;
  return unique([configured, 'bash', 'zsh'].filter((value): value is string => Boolean(value)));
}

export class WorkspacePolicy {
  private readonly roots: string[];

  constructor(
    roots: string[],
    private readonly profile: ExecutionProfile,
  ) {
    this.roots = unique(roots.map((root) => canonicalWorkspacePath(root)));
  }

  resolveCwd(requested?: string): string {
    const candidate = canonicalWorkspacePath(requested ?? process.cwd());
    if (this.profile === 'owner-full') return candidate;

    if (this.roots.length === 0) {
      throw new TerminalProtocolError('PATH_NOT_ALLOWED', 'No allowed workspace roots are configured.');
    }

    const allowed = this.roots.some((root) => {
      const delta = relative(root, candidate);
      return delta === '' || (!delta.startsWith('..') && !isAbsolute(delta));
    });

    if (!allowed) {
      throw new TerminalProtocolError('PATH_NOT_ALLOWED', 'Requested working directory is outside the allowed workspace roots.');
    }

    return candidate;
  }
}

function canonicalWorkspacePath(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    throw new TerminalProtocolError('PATH_NOT_ALLOWED', 'Working directory does not exist or cannot be resolved safely.');
  }
}

function isTerminalFinal(status: TerminalSession['status']): boolean {
  return status === 'closed' || status === 'exited' || status === 'failed';
}

export class LocalTerminalAgent implements TerminalAgentApi {
  private readonly eventEmitter = new EventEmitter();
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly shells: string[];
  private readonly bufferHighWaterBytes: number;
  private readonly maxEventBytes: number;
  private readonly idleTimeoutMs: number;
  private readonly maxLifetimeMs: number;
  private readonly closedSessionRetentionMs: number;
  private readonly sweepTimer: NodeJS.Timeout;
  private readonly agent: Agent;

  constructor(private readonly options: LocalTerminalAgentOptions) {
    this.shells = unique(options.shells ?? defaultShells());
    this.bufferHighWaterBytes = options.bufferHighWaterBytes ?? 1024 * 1024;
    this.maxEventBytes = options.maxEventBytes ?? 64 * 1024;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60_000;
    this.maxLifetimeMs = options.maxLifetimeMs ?? 8 * 60 * 60_000;
    this.closedSessionRetentionMs = options.closedSessionRetentionMs ?? 15 * 60_000;
    const now = new Date().toISOString();
    this.agent = {
      agent_id: options.agentId ?? randomUUID(),
      execution_profile: options.executionProfile,
      hostname: os.hostname(),
      display_name: options.displayName ?? os.hostname(),
      platform: process.platform,
      architecture: process.arch,
      online: true,
      capabilities: {
        pty: true,
        resize: true,
        signals: ['SIGINT'],
        shells: this.shells,
        resume: true,
      },
      connected_at: now,
      last_seen: now,
    };
    this.sweepTimer = setInterval(() => this.sweepExpiredSessions(), options.sweepIntervalMs ?? 30_000);
    this.sweepTimer.unref();
  }

  describe(): Agent {
    return { ...this.agent, capabilities: { ...this.agent.capabilities, shells: [...this.agent.capabilities.shells] } };
  }

  listSessions(): TerminalSession[] {
    return [...this.sessions.values()].map(({ metadata }) => ({ ...metadata }));
  }

  listSessionSnapshots(): AgentSessionSnapshot[] {
    return [...this.sessions.values()].map((managed) => this.snapshot(managed));
  }

  start(userId: string, input: TerminalStartInput, requestedProfile: ExecutionProfile): AgentSessionSnapshot {
    const effectiveProfile = restrictiveExecutionProfile(this.options.executionProfile, requestedProfile);
    if (effectiveProfile === 'read-only') {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'The effective execution profile does not allow terminal creation.');
    }

    const cwd = new WorkspacePolicy(this.options.allowedWorkspaceRoots, effectiveProfile).resolveCwd(input.cwd);
    const shell = input.shell ?? this.shells[0];
    if (!shell || !this.shells.includes(shell)) {
      throw new TerminalProtocolError('INVALID_ARGUMENT', 'Requested shell is not enabled for this agent.');
    }

    const sessionId = randomUUID();
    const now = new Date().toISOString();
    const metadata: TerminalSession = {
      session_id: sessionId,
      agent_id: this.agent.agent_id,
      user_id: userId,
      execution_profile: effectiveProfile,
      cwd,
      shell,
      cols: input.cols,
      rows: input.rows,
      status: 'creating',
      created_at: now,
      last_activity_at: now,
      exit_code: null,
    };

    let terminal: pty.IPty;
    try {
      terminal = pty.spawn(shell, [], {
        name: process.env.TERM ?? 'xterm-256color',
        cols: input.cols,
        rows: input.rows,
        cwd,
        env: cleanEnvironment(),
      });
    } catch (error) {
      throw new TerminalProtocolError(
        'PTY_CREATE_FAILED',
        `Failed to create PTY: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    metadata.status = 'running';
    const managed: ManagedSession = {
      pty: terminal,
      metadata,
      events: [],
      eventSizes: [],
      eventHead: 0,
      sequence: 0,
      retainedBytes: 0,
      earliestSequence: 1,
    };
    this.sessions.set(sessionId, managed);

    terminal.onData((text) => {
      if (managed.closeRequest?.finalized) return;
      this.recordEvent(managed, 'agent', 'terminal.stdout', { text });
      this.scheduleCwdRefresh(managed);
    });
    terminal.onExit(({ exitCode, signal }) => {
      managed.metadata.exit_code = exitCode;
      managed.metadata.last_activity_at = new Date().toISOString();
      const closeRequest = managed.closeRequest;
      if (closeRequest) {
        managed.metadata.status = 'closed';
        setImmediate(() => {
          if (closeRequest.finalized) return;
          closeRequest.finalized = true;
          this.recordEvent(managed, closeRequest.actor, 'session.closed', {
            reason: closeRequest.reason,
            exit_code: exitCode,
            signal,
          });
        });
        return;
      }
      managed.metadata.status = 'exited';
      this.recordEvent(managed, 'agent', 'process.exit', { exit_code: exitCode, signal });
    });

    this.recordEvent(managed, 'agent', 'session.started', { cwd, shell, cols: input.cols, rows: input.rows, execution_profile: effectiveProfile });
    if (input.command) {
      this.write(sessionId, `${input.command}\r`, 'chatgpt');
    }

    return this.snapshot(managed);
  }

  write(sessionId: string, text: string, actor: TerminalEventActor = 'chatgpt'): AgentSessionSnapshot {
    const managed = this.requireWritableSession(sessionId);
    const byteLength = Buffer.byteLength(text);
    if (byteLength > this.maxEventBytes) {
      throw new TerminalProtocolError('OUTPUT_LIMIT_REACHED', 'Terminal input exceeds the configured event size limit.');
    }
    managed.pty.write(text);
    this.recordEvent(managed, actor, 'command.input', { text });
    return this.snapshot(managed);
  }

  resize(sessionId: string, cols: number, rows: number): AgentSessionSnapshot {
    const managed = this.requireWritableSession(sessionId);
    managed.pty.resize(cols, rows);
    managed.metadata.cols = cols;
    managed.metadata.rows = rows;
    this.recordEvent(managed, 'chatgpt', 'terminal.resize', { cols, rows });
    return this.snapshot(managed);
  }

  interrupt(sessionId: string): AgentSessionSnapshot {
    const managed = this.requireWritableSession(sessionId);
    managed.pty.write('\u0003');
    this.recordEvent(managed, 'chatgpt', 'terminal.signal', { signal: 'SIGINT' });
    return this.snapshot(managed);
  }

  close(sessionId: string): AgentSessionSnapshot {
    const managed = this.requireSession(sessionId);
    this.closeManaged(managed, 'chatgpt', 'explicit_close');
    return this.snapshot(managed);
  }

  status(sessionId: string): AgentSessionSnapshot {
    return this.snapshot(this.requireSession(sessionId));
  }

  readEvents(sessionId: string, after: number, maxBytes: number): { events: TerminalEvent[]; nextCursor: number; hasMore: boolean } {
    const managed = this.requireSession(sessionId);
    if (after < managed.earliestSequence - 1) {
      throw new TerminalProtocolError('INVALID_CURSOR', 'Requested cursor is older than the retained terminal buffer.');
    }
    if (after > managed.sequence) {
      throw new TerminalProtocolError('INVALID_CURSOR', 'Requested cursor is ahead of the terminal event stream.');
    }

    const events: TerminalEvent[] = [];
    let bytes = 0;
    const startIndex = managed.eventHead + Math.max(0, after - managed.earliestSequence + 1);
    for (let index = startIndex; index < managed.events.length; index += 1) {
      const event = managed.events[index];
      const eventBytes = managed.eventSizes[index];
      if (!event || eventBytes === undefined) break;
      if (events.length > 0 && bytes + eventBytes > maxBytes) break;
      if (eventBytes > maxBytes && events.length === 0) {
        throw new TerminalProtocolError(
          'OUTPUT_LIMIT_REACHED',
          `The next terminal event requires ${eventBytes} bytes, which exceeds max_bytes=${maxBytes}.`,
        );
      }
      events.push(event);
      bytes += eventBytes;
    }

    const nextCursor = events.at(-1)?.sequence ?? after;
    return {
      events,
      nextCursor,
      hasMore: nextCursor < managed.sequence,
    };
  }

  onEvent(listener: (event: TerminalEvent) => void): () => void {
    this.eventEmitter.on('terminal-event', listener);
    return () => this.eventEmitter.off('terminal-event', listener);
  }

  shutdown(): void {
    clearInterval(this.sweepTimer);
    for (const managed of this.sessions.values()) {
      if (managed.metadata.status === 'closed' || managed.metadata.status === 'exited' || managed.metadata.status === 'closing') continue;
      this.closeManaged(managed, 'system', 'agent_shutdown');
    }
    this.eventEmitter.removeAllListeners();
  }

  private sweepExpiredSessions(): void {
    const now = Date.now();
    for (const [sessionId, managed] of this.sessions) {
      const activityMs = Date.parse(managed.metadata.last_activity_at);
      if (isTerminalFinal(managed.metadata.status)) {
        if (Number.isFinite(activityMs) && now - activityMs >= this.closedSessionRetentionMs) {
          this.sessions.delete(sessionId);
        }
        continue;
      }
      const createdMs = Date.parse(managed.metadata.created_at);
      if (now - createdMs >= this.maxLifetimeMs) {
        this.closeManaged(managed, 'system', 'max_lifetime');
      } else if (now - activityMs >= this.idleTimeoutMs) {
        this.closeManaged(managed, 'system', 'idle_timeout');
      }
    }
  }

  private closeManaged(managed: ManagedSession, actor: TerminalEventActor, reason: string): void {
    if (managed.metadata.status === 'closed' || managed.closeRequest) return;
    if (managed.metadata.status === 'exited' || managed.metadata.status === 'failed') {
      managed.metadata.status = 'closed';
      this.recordEvent(managed, actor, 'session.closed', { reason, exit_code: managed.metadata.exit_code });
      return;
    }

    const closeRequest = { actor, reason, finalized: false };
    managed.closeRequest = closeRequest;
    managed.metadata.status = 'closing';
    managed.metadata.last_activity_at = new Date().toISOString();
    try {
      managed.pty.kill();
    } catch (error) {
      closeRequest.finalized = true;
      managed.metadata.status = 'closed';
      this.recordEvent(managed, actor, 'session.closed', {
        reason,
        termination_error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private requireSession(sessionId: string): ManagedSession {
    const managed = this.sessions.get(sessionId);
    if (!managed) throw new TerminalProtocolError('SESSION_NOT_FOUND', 'Terminal session was not found.');
    return managed;
  }

  private requireWritableSession(sessionId: string): ManagedSession {
    const managed = this.requireSession(sessionId);
    if (managed.closeRequest || managed.metadata.status === 'closing' || managed.metadata.status === 'closed' || managed.metadata.status === 'exited' || managed.metadata.status === 'failed') {
      throw new TerminalProtocolError('SESSION_CLOSED', 'Terminal session is not writable.');
    }
    return managed;
  }

  private scheduleCwdRefresh(managed: ManagedSession): void {
    if (process.platform !== 'linux' || managed.cwdRefreshTimer || managed.closeRequest?.finalized) return;
    managed.cwdRefreshTimer = setTimeout(() => {
      delete managed.cwdRefreshTimer;
      if (isTerminalFinal(managed.metadata.status) || managed.closeRequest?.finalized) return;
      try {
        const cwd = readlinkSync(`/proc/${managed.pty.pid}/cwd`);
        if (cwd && cwd !== managed.metadata.cwd) {
          managed.metadata.cwd = cwd;
          this.recordEvent(managed, 'agent', 'cwd.changed', { cwd });
        }
      } catch {
        // The PTY process may have exited between scheduling and the /proc lookup.
      }
    }, 25);
    managed.cwdRefreshTimer.unref();
  }

  private snapshot(managed: ManagedSession): AgentSessionSnapshot {
    return {
      session: { ...managed.metadata },
      cursor: managed.sequence,
      earliestCursor: managed.earliestSequence - 1,
    };
  }

  private recordEvent(
    managed: ManagedSession,
    actor: TerminalEventActor,
    eventType: TerminalEventType,
    data: Record<string, unknown>,
  ): TerminalEvent {
    const now = new Date().toISOString();
    const event: TerminalEvent = {
      event_id: randomUUID(),
      session_id: managed.metadata.session_id,
      sequence: ++managed.sequence,
      timestamp: now,
      actor,
      event_type: eventType,
      data,
    };
    // Fast-path byte estimation for terminal output events (most frequent):
    // measure only the text payload + fixed structural overhead to avoid full JSON.stringify
    const textPayload = (eventType === 'terminal.stdout' || eventType === 'terminal.stderr') ? data.text : undefined;
    const eventBytes = typeof textPayload === 'string' ? Buffer.byteLength(textPayload) + 150 : Buffer.byteLength(JSON.stringify(event));
    managed.events.push(event);
    managed.eventSizes.push(eventBytes);
    managed.retainedBytes += eventBytes;
    managed.metadata.last_activity_at = now;

    while (managed.retainedBytes > this.bufferHighWaterBytes && managed.events.length - managed.eventHead > 1) {
      const removed = managed.events[managed.eventHead];
      const removedBytes = managed.eventSizes[managed.eventHead];
      if (!removed || removedBytes === undefined) break;
      managed.eventHead += 1;
      managed.retainedBytes -= removedBytes;
      managed.earliestSequence = removed.sequence + 1;
    }
    if (managed.eventHead >= 1024 && managed.eventHead * 2 >= managed.events.length) {
      managed.events = managed.events.slice(managed.eventHead);
      managed.eventSizes = managed.eventSizes.slice(managed.eventHead);
      managed.eventHead = 0;
    }

    this.eventEmitter.emit('terminal-event', event);
    return event;
  }
}
