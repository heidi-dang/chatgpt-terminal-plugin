import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { constants, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import { NodePtyTerminalRuntime, type TerminalProcess, type TerminalRuntime, type TerminalRuntimeMetrics } from './terminal-runtime.js';
import { SessionEventJournal } from './event-journal.js';
export { NodePtyTerminalRuntime } from './terminal-runtime.js';
export { SessionEventJournal } from './event-journal.js';
export type { SessionEventJournalOptions, JournalReadResult } from './event-journal.js';
export type { TerminalProcess, TerminalRuntime, TerminalRuntimeMetrics, TerminalSpawnOptions } from './terminal-runtime.js';
import { CodeBlockExecutor } from './code-block-executor.js';
import { LspManager, type LspServerDefinition } from './lsp-manager.js';
import { SemanticLspManager } from './semantic-lsp.js';
import { discoverFilesWithRipgrep } from './ripgrep-discovery.js';
export { discoverLspServers, resolveLspServers } from './lsp-discovery.js';
import {
  TerminalProtocolError,
  terminalEventSchema,
  terminalSessionSchema,
  type Agent,
  type AgentHealthTelemetry,
  type CodeCancelOutput,
  type CodeExecuteInput,
  type CodeExecuteOutput,
  type ExecutionProfile,
  type LspRequestInput,
  type LspRequestOutput,
  type LspStartInput,
  type LspStartOutput,
  type LspStopOutput,
  type SemanticApplyEditInput,
  type SemanticApplyEditOutput,
  type SemanticCloseInput,
  type SemanticCloseOutput,
  type SemanticMemoryOutput,
  type SemanticMemoryReadInput,
  type SemanticMemoryWriteInput,
  type SemanticOpenInput,
  type SemanticOpenOutput,
  type SemanticPreviewEditInput,
  type SemanticPreviewEditOutput,
  type SemanticProjectOverviewInput,
  type SemanticProjectOverviewOutput,
  type SemanticQueryInput,
  type SemanticQueryOutput,
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
  lspServers?: Readonly<Record<string, LspServerDefinition>>;
  shells?: string[];
  bufferHighWaterBytes?: number;
  maxEventBytes?: number;
  idleTimeoutMs?: number;
  maxLifetimeMs?: number;
  closedSessionRetentionMs?: number;
  sweepIntervalMs?: number;
  terminationGraceMs?: number;
  outputFlushIntervalMs?: number;
  outputFlushBytes?: number;
  terminalRuntime?: TerminalRuntime;
  eventJournalDir?: string;
  eventJournalMaxBytes?: number;
  eventJournalRetentionMs?: number;
  eventJournalIncludeInput?: boolean;
  workspaceRootsStatePath?: string;
  stateDir?: string;
}

export interface AgentSessionSnapshot {
  session: TerminalSession;
  cursor: number;
  earliestCursor: number;
}

interface ManagedSession {
  process?: TerminalProcess;
  metadata: TerminalSession;
  events: TerminalEvent[];
  eventSizes: number[];
  eventHead: number;
  sequence: number;
  retainedBytes: number;
  earliestSequence: number;
  closeRequest?: { actor: TerminalEventActor; reason: string; finalized: boolean };
  cwdRefreshTimer?: NodeJS.Timeout;
  outputFlushTimer: NodeJS.Timeout | undefined;
  outputBuffer: string;
  outputBufferBytes: number;
  persistenceTimer?: NodeJS.Timeout;
}

interface PersistedSessionState {
  version: 1;
  session: TerminalSession;
  events: TerminalEvent[];
  sequence: number;
  earliest_sequence: number;
}

export interface TerminalAgentApi {
  describe(): Agent;
  runtimeMetrics(): TerminalRuntimeMetrics;
  getTelemetry(): AgentHealthTelemetry;
  getWorkspaceRoots(): string[];
  addWorkspaceRoot(root: string): string[];
  removeWorkspaceRoot(root: string): string[];
  listSessions(): TerminalSession[];
  listSessionSnapshots(): AgentSessionSnapshot[];
  start(userId: string, input: TerminalStartInput, requestedProfile: ExecutionProfile): AgentSessionSnapshot;
  write(sessionId: string, text: string, actor?: TerminalEventActor): AgentSessionSnapshot;
  resize(sessionId: string, cols: number, rows: number): AgentSessionSnapshot;
  interrupt(sessionId: string): AgentSessionSnapshot;
  close(sessionId: string): AgentSessionSnapshot;
  status(sessionId: string): AgentSessionSnapshot;
  readEvents(sessionId: string, after: number, maxBytes: number): { events: TerminalEvent[]; nextCursor: number; hasMore: boolean };
  readFile(sessionId: string, path: string, maxBytes: number): Promise<{ path: string; content: string; size: number; truncated: boolean }>;
  listFiles(sessionId: string, path: string, maxEntries: number): Promise<{ path: string; entries: Array<{ name: string; type: string; size: number; modified_at: string }>; truncated: boolean }>;
  writeFile(sessionId: string, path: string, content: string, createDirectories: boolean): Promise<{ path: string; bytes_written: number }>;
  deleteFile(sessionId: string, filePath: string): Promise<{ path: string }>;
  renameFile(sessionId: string, fromPath: string, toPath: string): Promise<{ from: string; to: string }>;
  searchFiles(sessionId: string, pattern: string, path: string, include: string | undefined, maxResults: number, contextLines: number): Promise<{ pattern: string; matches: Array<{ file: string; line: number; text: string; context_before?: string[]; context_after?: string[] }>; truncated: boolean; files_searched: number }>;
  executeCode(userId: string, input: CodeExecuteInput, requestedProfile: ExecutionProfile, onChunk?: (stream: 'stdout' | 'stderr', chunk: string) => void): Promise<CodeExecuteOutput>;
  cancelCode(userId: string, executionId: string, requestedProfile: ExecutionProfile): CodeCancelOutput;
  startLsp(userId: string, input: LspStartInput, requestedProfile: ExecutionProfile): Promise<LspStartOutput>;
  requestLsp(userId: string, input: LspRequestInput, requestedProfile: ExecutionProfile): Promise<LspRequestOutput>;
  stopLsp(userId: string, lspId: string, requestedProfile: ExecutionProfile): LspStopOutput;
  openSemantic(userId: string, input: SemanticOpenInput, requestedProfile: ExecutionProfile): Promise<SemanticOpenOutput>;
  querySemantic(userId: string, input: SemanticQueryInput, requestedProfile: ExecutionProfile): Promise<SemanticQueryOutput>;
  previewSemanticEdit(userId: string, input: SemanticPreviewEditInput, requestedProfile: ExecutionProfile): Promise<SemanticPreviewEditOutput>;
  applySemanticEdit(userId: string, input: SemanticApplyEditInput, requestedProfile: ExecutionProfile): Promise<SemanticApplyEditOutput>;
  projectSemanticOverview(userId: string, input: SemanticProjectOverviewInput, requestedProfile: ExecutionProfile): Promise<SemanticProjectOverviewOutput>;
  readSemanticMemory(userId: string, input: SemanticMemoryReadInput, requestedProfile: ExecutionProfile): Promise<SemanticMemoryOutput>;
  writeSemanticMemory(userId: string, input: SemanticMemoryWriteInput, requestedProfile: ExecutionProfile): Promise<SemanticMemoryOutput>;
  closeSemantic(userId: string, input: SemanticCloseInput, requestedProfile: ExecutionProfile): SemanticCloseOutput;
  stopProcessFeatures(): void;
  onEvent(listener: (event: TerminalEvent) => void): () => void;
  shutdown(): void;
}

const CONTROL_PLANE_SECRET_ENV = new Set([
  'AGENT_ENROLLMENT_TOKEN',
  'MCP_DEVELOPMENT_TOKEN',
  'STREAM_TOKEN_SECRET',
  'OAUTH_CLIENT_SECRET',
]);

export function cleanEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && !CONTROL_PLANE_SECRET_ENV.has(entry[0]),
    ),
  );
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isFileNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'));
}

function errorMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Simple glob matching for file include filters (e.g. "*.ts", "*.{js,jsx}"). */
function matchGlob(filename: string, pattern: string): boolean {
  // Handle {a,b} alternation
  const braceMatch = pattern.match(/^(.*)\.\{([^}]+)\}$/);
  const extensionGroup = braceMatch?.[2];
  if (extensionGroup) {
    const extensions = extensionGroup.split(',');
    return extensions.some((ext) => filename.endsWith('.' + ext));
  }
  // Handle simple *.ext
  if (pattern.startsWith('*.')) {
    return filename.endsWith(pattern.slice(1));
  }
  // Exact match
  return filename === pattern;
}

/** Read a file as UTF-8 text, returning null if it's binary or too large. */
async function readFileContent(filePath: string, maxBytes: number): Promise<string | null> {
  try {
    const info = await stat(filePath);
    if (info.size > maxBytes) return null;
    const fd = await open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(info.size, maxBytes));
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
      const chunk = buffer.subarray(0, bytesRead);
      // Quick binary check: if there are null bytes in the first 8KB, skip
      if (chunk.subarray(0, 8192).includes(0)) return null;
      return chunk.toString('utf8');
    } finally {
      await fd.close();
    }
  } catch {
    return null;
  }
}

type SearchMatch = {
  file: string;
  line: number;
  text: string;
  context_before?: string[];
  context_after?: string[];
};

async function searchSingleTextFile(
  filePath: string,
  displayPath: string,
  regex: RegExp,
  contextLines: number,
  maxResults: number,
  matches: SearchMatch[],
): Promise<boolean> {
  const content = await readFileContent(filePath, 512 * 1024);
  if (content === null) return false;
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const lineText = lines[index] ?? '';
    if (!regex.test(lineText)) continue;
    const match: SearchMatch = {
      file: displayPath,
      line: index + 1,
      text: lineText.slice(0, 500),
    };
    if (contextLines > 0) {
      match.context_before = lines.slice(Math.max(0, index - contextLines), index).map((line) => line.slice(0, 500));
      match.context_after = lines.slice(index + 1, index + 1 + contextLines).map((line) => line.slice(0, 500));
    }
    matches.push(match);
    if (matches.length >= maxResults) return true;
  }
  return false;
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
  private roots: string[];

  constructor(
    roots: string[],
    private readonly profile: ExecutionProfile,
  ) {
    this.roots = unique(roots.map((root) => canonicalWorkspacePath(root)));
  }

  getRoots(): string[] {
    return [...this.roots];
  }

  addRoot(root: string): void {
    const canonical = canonicalWorkspacePath(root);
    this.roots = unique([...this.roots, canonical]);
  }

  removeRoot(root: string): void {
    const canonical = canonicalWorkspacePath(root);
    this.roots = this.roots.filter((r) => r !== canonical);
  }

  setRoots(roots: string[]): void {
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

  resolveExistingPath(path: string): string {
    const canonical = canonicalWorkspacePath(path);
    this.assertCanonicalAllowed(canonical);
    return canonical;
  }

  resolveWritablePath(path: string): string {
    const absolute = resolve(path);
    if (this.profile === 'owner-full') return absolute;
    if (this.roots.length === 0) {
      throw new TerminalProtocolError('PATH_NOT_ALLOWED', 'No allowed workspace roots are configured.');
    }

    let ancestor = dirname(absolute);
    while (true) {
      try {
        const canonicalAncestor = realpathSync(ancestor);
        this.assertCanonicalAllowed(canonicalAncestor);
        return resolve(canonicalAncestor, relative(ancestor, absolute));
      } catch (error) {
        if (error instanceof TerminalProtocolError) throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) {
          throw new TerminalProtocolError('PATH_NOT_ALLOWED', 'Writable path has no resolvable allowed ancestor.');
        }
        ancestor = parent;
      }
    }
  }

  private assertCanonicalAllowed(canonical: string): void {
    if (this.profile === 'owner-full') return;
    if (this.roots.length === 0) {
      throw new TerminalProtocolError('PATH_NOT_ALLOWED', 'No allowed workspace roots are configured.');
    }
    const allowed = this.roots.some((root) => {
      const delta = relative(root, canonical);
      return delta === '' || (!delta.startsWith('..') && !isAbsolute(delta));
    });
    if (!allowed) {
      throw new TerminalProtocolError('PATH_NOT_ALLOWED', 'Path is outside the allowed workspace roots.');
    }
  }
}

function canonicalWorkspacePath(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    throw new TerminalProtocolError('PATH_NOT_ALLOWED', 'Working directory does not exist or cannot be resolved safely.');
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const delta = relative(root, candidate);
  return delta === '' || (!delta.startsWith('..') && !isAbsolute(delta));
}

function loadWorkspaceRoots(statePath: string | undefined, fallback: string[]): string[] {
  if (!statePath) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || !('roots' in parsed) || !Array.isArray((parsed as { roots?: unknown }).roots)) {
      throw new Error('workspace root state must contain a roots array');
    }
    const roots = (parsed as { roots: unknown[] }).roots;
    if (!roots.every((root) => typeof root === 'string' && root.length > 0 && root.length <= 4096) || roots.length > 256) {
      throw new Error('workspace root state contains invalid roots');
    }
    return roots as string[];
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return fallback;
    throw new TerminalProtocolError('INVALID_ARGUMENT', `Cannot load workspace root state: ${errorMsg(error)}`);
  }
}

function persistWorkspaceRoots(statePath: string | undefined, roots: string[]): void {
  if (!statePath) return;
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  const tempPath = `${statePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify({ version: 1, roots })}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tempPath, statePath);
  } catch (error) {
    throw new TerminalProtocolError('INVALID_ARGUMENT', `Cannot persist workspace root state: ${errorMsg(error)}`);
  }
}

function isTerminalFinal(status: TerminalSession['status']): boolean {
  return status === 'closed' || status === 'exited' || status === 'failed';
}

function splitUtf8ByBytes(text: string, maxBytes: number): string[] {
  if (maxBytes <= 0 || Buffer.byteLength(text) <= maxBytes) return [text];
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char);
    if (current && currentBytes + charBytes > maxBytes) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current) chunks.push(current);
  return chunks;
}

export class LocalTerminalAgent implements TerminalAgentApi {
  private readonly eventEmitter = new EventEmitter();
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly shells: string[];
  private readonly bufferHighWaterBytes: number;
  private readonly maxEventBytes: number;
  private readonly outputFlushIntervalMs: number;
  private readonly outputFlushBytes: number;
  private readonly runtime: TerminalRuntime;
  private readonly eventJournal: SessionEventJournal | undefined;
  private readonly idleTimeoutMs: number;
  private readonly maxLifetimeMs: number;
  private readonly closedSessionRetentionMs: number;
  private readonly sweepTimer: NodeJS.Timeout;
  private readonly agent: Agent;
  private readonly workspacePolicy: WorkspacePolicy;
  private readonly executionWorkspacePolicy: WorkspacePolicy;
  private readonly codeExecutor: CodeBlockExecutor;
  private readonly lspManager: LspManager;
  private readonly semanticManager: SemanticLspManager;
  private readonly stateDir: string | undefined;

  constructor(private readonly options: LocalTerminalAgentOptions) {
    this.shells = unique(options.shells ?? defaultShells());
    this.bufferHighWaterBytes = options.bufferHighWaterBytes ?? 1024 * 1024;
    this.maxEventBytes = options.maxEventBytes ?? 64 * 1024;
    this.outputFlushIntervalMs = options.outputFlushIntervalMs ?? 8;
    this.outputFlushBytes = Math.min(options.outputFlushBytes ?? 32 * 1024, this.maxEventBytes);
    this.runtime = options.terminalRuntime ?? new NodePtyTerminalRuntime({ terminationGraceMs: options.terminationGraceMs ?? 750 });
    this.eventJournal = options.eventJournalDir
      ? new SessionEventJournal({
          dir: options.eventJournalDir,
          maxBytesPerSession: options.eventJournalMaxBytes ?? 8 * 1024 * 1024,
          retentionMs: options.eventJournalRetentionMs ?? 7 * 24 * 60 * 60_000,
          includeCommandInput: options.eventJournalIncludeInput ?? false,
          sweepIntervalMs: options.sweepIntervalMs ?? 30_000,
        })
      : undefined;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60_000;
    this.maxLifetimeMs = options.maxLifetimeMs ?? 8 * 60 * 60_000;
    this.closedSessionRetentionMs = options.closedSessionRetentionMs ?? 15 * 60_000;
    this.stateDir = options.stateDir;
    if (this.stateDir) mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
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
        semantic: true,
      },
      connected_at: now,
      last_seen: now,
    };
    this.sweepTimer = setInterval(() => this.sweepExpiredSessions(), options.sweepIntervalMs ?? 30_000);
    this.sweepTimer.unref();
    const workspaceRoots = loadWorkspaceRoots(options.workspaceRootsStatePath, options.allowedWorkspaceRoots);
    this.workspacePolicy = new WorkspacePolicy(workspaceRoots, options.executionProfile);
    // Code and LSP execution are intentionally workspace-contained even for owner-full.
    this.executionWorkspacePolicy = new WorkspacePolicy(workspaceRoots, 'developer');
    const environment = cleanEnvironment();
    this.codeExecutor = new CodeBlockExecutor({ environment });
    this.lspManager = new LspManager({ servers: options.lspServers ?? {}, environment });
    this.semanticManager = new SemanticLspManager(this.lspManager, {
      ...(this.stateDir ? { memoryDir: join(this.stateDir, 'semantic-memory') } : {}),
    });
    this.restorePersistedSessions();
  }

  getTelemetry(): AgentHealthTelemetry {
    const runningSessions = [...this.sessions.values()].filter((s) => s.metadata.status === 'running').length;
    const [oneMinute = 0, fiveMinutes = 0, fifteenMinutes = 0] = os.loadavg();
    return {
      cpu_load: [oneMinute, fiveMinutes, fifteenMinutes],
      freemem_bytes: os.freemem(),
      totalmem_bytes: os.totalmem(),
      uptime_seconds: os.uptime(),
      active_sessions: runningSessions,
      active_lsp_processes: this.lspManager.activeCount,
      active_code_executions: this.codeExecutor.activeCount,
    };
  }

  getWorkspaceRoots(): string[] {
    return this.workspacePolicy.getRoots();
  }

  addWorkspaceRoot(root: string): string[] {
    const previous = this.getWorkspaceRoots();
    try {
      this.workspacePolicy.addRoot(root);
      this.executionWorkspacePolicy.addRoot(root);
      const roots = this.getWorkspaceRoots();
      persistWorkspaceRoots(this.options.workspaceRootsStatePath, roots);
      return roots;
    } catch (error) {
      this.workspacePolicy.setRoots(previous);
      this.executionWorkspacePolicy.setRoots(previous);
      throw error;
    }
  }

  removeWorkspaceRoot(root: string): string[] {
    const canonical = canonicalWorkspacePath(root);
    const active = [...this.sessions.values()].find((managed) => !isTerminalFinal(managed.metadata.status) && isPathWithin(canonical, managed.metadata.cwd));
    if (active) {
      throw new TerminalProtocolError('INVALID_ARGUMENT', `Cannot remove workspace root while terminal session ${active.metadata.session_id} is active within it.`);
    }
    const previous = this.getWorkspaceRoots();
    try {
      this.workspacePolicy.removeRoot(canonical);
      this.executionWorkspacePolicy.removeRoot(canonical);
      const roots = this.getWorkspaceRoots();
      persistWorkspaceRoots(this.options.workspaceRootsStatePath, roots);
      return roots;
    } catch (error) {
      this.workspacePolicy.setRoots(previous);
      this.executionWorkspacePolicy.setRoots(previous);
      throw error;
    }
  }

  describe(): Agent {
    return {
      ...this.agent,
      telemetry: this.getTelemetry(),
      capabilities: { ...this.agent.capabilities, shells: [...this.agent.capabilities.shells] },
    };
  }

  runtimeMetrics(): TerminalRuntimeMetrics {
    return this.runtime.metrics();
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

    const cwd = new WorkspacePolicy(this.workspacePolicy.getRoots(), effectiveProfile).resolveCwd(input.cwd);
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

    let terminal: TerminalProcess;
    try {
      terminal = this.runtime.spawn({
        shell,
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
      process: terminal,
      metadata,
      events: [],
      eventSizes: [],
      eventHead: 0,
      sequence: 0,
      retainedBytes: 0,
      earliestSequence: 1,
      outputFlushTimer: undefined,
      outputBuffer: '',
      outputBufferBytes: 0,
    };
    this.sessions.set(sessionId, managed);

    terminal.onData((text) => {
      if (managed.closeRequest?.finalized) return;
      this.enqueueOutput(managed, text);
      this.scheduleCwdRefresh(managed);
    });
    terminal.onExit(({ exitCode, signal }) => {
      this.flushOutput(managed);
      managed.metadata.exit_code = exitCode;
      managed.metadata.last_activity_at = new Date().toISOString();
      const closeRequest = managed.closeRequest;
      if (closeRequest) {
        setImmediate(() => {
          if (closeRequest.finalized) return;
          closeRequest.finalized = true;
          managed.metadata.status = 'closed';
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
      // A newly spawned Unix PTY can receive input before the shell has enabled CR-to-NL translation.
      // Submit startup commands with LF so they cannot remain buffered as an unterminated line.
      this.write(sessionId, `${input.command}${process.platform === 'win32' ? '\r' : '\n'}`, 'chatgpt');
    }

    return this.snapshot(managed);
  }

  write(sessionId: string, text: string, actor: TerminalEventActor = 'chatgpt'): AgentSessionSnapshot {
    const managed = this.requireWritableSession(sessionId);
    const byteLength = Buffer.byteLength(text);
    if (byteLength > this.maxEventBytes) {
      throw new TerminalProtocolError('OUTPUT_LIMIT_REACHED', 'Terminal input exceeds the configured event size limit.');
    }
    managed.process.write(text);
    this.recordEvent(managed, actor, 'command.input', { text });
    return this.snapshot(managed);
  }

  resize(sessionId: string, cols: number, rows: number): AgentSessionSnapshot {
    const managed = this.requireWritableSession(sessionId);
    managed.process.resize(cols, rows);
    managed.metadata.cols = cols;
    managed.metadata.rows = rows;
    this.recordEvent(managed, 'chatgpt', 'terminal.resize', { cols, rows });
    return this.snapshot(managed);
  }

  interrupt(sessionId: string): AgentSessionSnapshot {
    const managed = this.requireWritableSession(sessionId);
    managed.process.interrupt();
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
      const replay = this.readJournalEvents(managed, after, maxBytes);
      if (replay) return replay;
      throw new TerminalProtocolError('INVALID_CURSOR', 'Requested cursor is older than the retained terminal buffer and durable replay is unavailable.');
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

  // --- File Operations ---
  // These operate relative to the session's current working directory,
  // enforced by the same workspace policy as PTY creation.

  async readFile(sessionId: string, filePath: string, maxBytes: number): Promise<{ path: string; content: string; size: number; truncated: boolean }> {
    const managed = this.requireSession(sessionId);
    const resolved = this.resolveFilePath(managed, filePath);
    try {
      const info = await stat(resolved);
      if (!info.isFile()) throw new TerminalProtocolError('INVALID_ARGUMENT', 'Path is not a regular file.');
      if (info.size > maxBytes * 4) throw new TerminalProtocolError('FILE_TOO_LARGE', `File is ${info.size} bytes; max allowed is ${maxBytes * 4}.`);
      const buffer = Buffer.alloc(Math.min(info.size, maxBytes));
      const fd = await open(resolved, 'r');
      try {
        const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
        return {
          path: relative(managed.metadata.cwd, resolved) || resolved,
          content: buffer.subarray(0, bytesRead).toString('utf8'),
          size: info.size,
          truncated: info.size > maxBytes,
        };
      } finally {
        await fd.close();
      }
    } catch (error) {
      if (error instanceof TerminalProtocolError) throw error;
      if (isFileNotFound(error)) throw new TerminalProtocolError('FILE_NOT_FOUND', `File not found: ${filePath}`);
      throw new TerminalProtocolError('INVALID_ARGUMENT', `Cannot read file: ${errorMsg(error)}`);
    }
  }

  async listFiles(sessionId: string, dirPath: string, maxEntries: number): Promise<{ path: string; entries: Array<{ name: string; type: string; size: number; modified_at: string }>; truncated: boolean }> {
    const managed = this.requireSession(sessionId);
    const resolved = this.resolveFilePath(managed, dirPath);
    try {
      const dirents = await readdir(resolved, { withFileTypes: true });
      const entries: Array<{ name: string; type: string; size: number; modified_at: string }> = [];
      const truncated = dirents.length > maxEntries;
      for (const dirent of dirents.slice(0, maxEntries)) {
        try {
          const entryPath = resolve(resolved, dirent.name);
          const info = await lstat(entryPath).catch(() => null);
          entries.push({
            name: dirent.name,
            type: dirent.isDirectory() ? 'directory' : dirent.isSymbolicLink() ? 'symlink' : dirent.isFile() ? 'file' : 'other',
            size: info?.size ?? 0,
            modified_at: info ? new Date(info.mtimeMs).toISOString() : new Date().toISOString(),
          });
        } catch {
          // Skip entries we can't stat (permission denied, etc.)
        }
      }
      return {
        path: relative(managed.metadata.cwd, resolved) || resolved,
        entries,
        truncated,
      };
    } catch (error) {
      if (isFileNotFound(error)) throw new TerminalProtocolError('FILE_NOT_FOUND', `Directory not found: ${dirPath}`);
      throw new TerminalProtocolError('INVALID_ARGUMENT', `Cannot list directory: ${errorMsg(error)}`);
    }
  }

  async writeFile(sessionId: string, filePath: string, content: string, createDirectories: boolean): Promise<{ path: string; bytes_written: number }> {
    const managed = this.requireSession(sessionId);
    if (managed.metadata.execution_profile === 'read-only') {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'File writes are not permitted under the read-only execution profile.');
    }
    const requested = isAbsolute(filePath) ? filePath : resolve(managed.metadata.cwd, filePath);
    let resolved = this.workspacePolicy.resolveWritablePath(requested);
    try {
      if (createDirectories) await mkdir(dirname(resolved), { recursive: true });
      const canonicalParent = this.workspacePolicy.resolveExistingPath(dirname(resolved));
      resolved = resolve(canonicalParent, basename(resolved));

      const targetInfo = await lstat(resolved).catch((error: unknown) => {
        if (isFileNotFound(error)) return null;
        throw error;
      });
      if (targetInfo?.isSymbolicLink()) {
        throw new TerminalProtocolError('PATH_NOT_ALLOWED', 'Refusing to write through a symbolic link.');
      }
      if (targetInfo && !targetInfo.isFile()) {
        throw new TerminalProtocolError('INVALID_ARGUMENT', 'Write target is not a regular file.');
      }

      const buffer = Buffer.from(content, 'utf8');
      const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
      const handle = await open(resolved, constants.O_WRONLY | constants.O_CREAT | noFollow, 0o644);
      try {
        if (process.platform === 'linux') {
          this.workspacePolicy.resolveExistingPath(`/proc/self/fd/${handle.fd}`);
        }
        await handle.truncate(0);
        await handle.writeFile(buffer);
      } finally {
        await handle.close();
      }
      return {
        path: relative(managed.metadata.cwd, resolved) || resolved,
        bytes_written: buffer.length,
      };
    } catch (error) {
      if (error instanceof TerminalProtocolError) throw error;
      if (isFileNotFound(error)) throw new TerminalProtocolError('FILE_NOT_FOUND', `Parent directory not found: ${filePath}`);
      throw new TerminalProtocolError('INVALID_ARGUMENT', `Cannot write file: ${errorMsg(error)}`);
    }
  }

  async deleteFile(sessionId: string, filePath: string): Promise<{ path: string }> {
    const managed = this.requireSession(sessionId);
    if (managed.metadata.execution_profile === 'read-only') {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'File deletes are not permitted under the read-only execution profile.');
    }

    const requested = isAbsolute(filePath) ? filePath : resolve(managed.metadata.cwd, filePath);
    // Resolve only the parent/allowed ancestor so lstat observes the requested
    // directory entry itself instead of following a final-component symlink.
    const resolved = this.workspacePolicy.resolveWritablePath(requested);
    try {
      const info = await lstat(resolved);
      if (info.isSymbolicLink()) {
        throw new TerminalProtocolError('PATH_NOT_ALLOWED', 'Refusing to delete a symbolic link.');
      }
      if (!info.isFile()) {
        throw new TerminalProtocolError('INVALID_ARGUMENT', 'Delete target is not a regular file.');
      }
      await unlink(resolved);
      return { path: relative(managed.metadata.cwd, resolved) || resolved };
    } catch (error) {
      if (error instanceof TerminalProtocolError) throw error;
      if (isFileNotFound(error)) throw new TerminalProtocolError('FILE_NOT_FOUND', `File not found: ${filePath}`);
      throw new TerminalProtocolError('INVALID_ARGUMENT', `Cannot delete file: ${errorMsg(error)}`);
    }
  }

  async renameFile(sessionId: string, fromPath: string, toPath: string): Promise<{ from: string; to: string }> {
    const managed = this.requireSession(sessionId);
    if (managed.metadata.execution_profile === 'read-only') {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'File renames are not permitted under the read-only execution profile.');
    }

    const requestedFrom = isAbsolute(fromPath) ? fromPath : resolve(managed.metadata.cwd, fromPath);
    const requestedTo = isAbsolute(toPath) ? toPath : resolve(managed.metadata.cwd, toPath);
    // Do not canonicalize the source entry itself: doing so follows a symlink
    // before lstat and can rename its target. Canonicalize only its parent.
    const resolvedFrom = this.workspacePolicy.resolveWritablePath(requestedFrom);
    const resolvedTo = this.workspacePolicy.resolveWritablePath(requestedTo);
    try {
      const sourceInfo = await lstat(resolvedFrom);
      if (sourceInfo.isSymbolicLink()) {
        throw new TerminalProtocolError('PATH_NOT_ALLOWED', 'Refusing to rename a symbolic link.');
      }
      if (!sourceInfo.isFile()) {
        throw new TerminalProtocolError('INVALID_ARGUMENT', 'Rename source is not a regular file.');
      }

      const destinationInfo = await lstat(resolvedTo).catch((error: unknown) => {
        if (isFileNotFound(error)) return null;
        throw error;
      });
      if (destinationInfo?.isSymbolicLink()) {
        throw new TerminalProtocolError('PATH_NOT_ALLOWED', 'Refusing to replace a symbolic link.');
      }
      if (destinationInfo && !destinationInfo.isFile()) {
        throw new TerminalProtocolError('INVALID_ARGUMENT', 'Rename destination is not a regular file.');
      }

      await rename(resolvedFrom, resolvedTo);
      return {
        from: relative(managed.metadata.cwd, resolvedFrom) || resolvedFrom,
        to: relative(managed.metadata.cwd, resolvedTo) || resolvedTo,
      };
    } catch (error) {
      if (error instanceof TerminalProtocolError) throw error;
      if (isFileNotFound(error)) throw new TerminalProtocolError('FILE_NOT_FOUND', `Source file not found: ${fromPath}`);
      throw new TerminalProtocolError('INVALID_ARGUMENT', `Cannot rename file: ${errorMsg(error)}`);
    }
  }

  async searchFiles(
    sessionId: string,
    pattern: string,
    searchPath: string,
    include: string | undefined,
    maxResults: number,
    contextLines: number,
  ): Promise<{ pattern: string; matches: SearchMatch[]; truncated: boolean; files_searched: number }> {
    const managed = this.requireSession(sessionId);
    const resolved = this.resolveFilePath(managed, searchPath);
    const info = await stat(resolved).catch(() => null);
    if (!info) throw new TerminalProtocolError('FILE_NOT_FOUND', `Path not found: ${searchPath}`);

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'i');
    } catch {
      throw new TerminalProtocolError('INVALID_ARGUMENT', `Invalid regex pattern: ${pattern}`);
    }

    const matches: SearchMatch[] = [];
    let filesSearched = 0;
    let truncated = false;
    const maxFilesSearched = 10_000;

    const searchFile = async (entryPath: string): Promise<void> => {
      filesSearched += 1;
      if (await searchSingleTextFile(
        entryPath,
        relative(managed.metadata.cwd, entryPath) || entryPath,
        regex,
        contextLines,
        maxResults,
        matches,
      )) truncated = true;
    };

    const walk = async (dir: string): Promise<void> => {
      if (truncated) return;
      let dirents;
      try {
        dirents = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const dirent of dirents) {
        if (truncated) return;
        const entryPath = resolve(dir, dirent.name);
        if (dirent.name.startsWith('.') || dirent.name === 'node_modules') continue;
        if (dirent.isDirectory()) {
          await walk(entryPath);
          continue;
        }
        if (!dirent.isFile() || (include && !matchGlob(dirent.name, include))) continue;
        if (filesSearched >= maxFilesSearched) {
          truncated = true;
          return;
        }
        await searchFile(entryPath);
      }
    };

    if (info.isFile()) {
      filesSearched = 1;
      truncated = await searchSingleTextFile(
        resolved,
        relative(managed.metadata.cwd, resolved) || resolved,
        regex,
        contextLines,
        maxResults,
        matches,
      );
    } else {
      const accelerated = await discoverFilesWithRipgrep(
        resolved,
        (entryPath) => !include || matchGlob(basename(entryPath), include),
        maxFilesSearched,
      );
      if (!accelerated) {
        await walk(resolved);
      } else {
        for (const discoveredPath of accelerated.files) {
          if (truncated) break;
          if (filesSearched >= maxFilesSearched) {
            truncated = true;
            break;
          }
          const fileInfo = await lstat(discoveredPath).catch(() => null);
          if (!fileInfo?.isFile()) continue;
          let entryPath: string;
          try {
            entryPath = this.workspacePolicy.resolveExistingPath(discoveredPath);
          } catch {
            continue;
          }
          if (!isPathWithin(resolved, entryPath)) continue;
          await searchFile(entryPath);
        }
        if (accelerated.truncated) truncated = true;
      }
    }

    return { pattern, matches, truncated, files_searched: filesSearched };
  }

  async executeCode(
    userId: string,
    input: CodeExecuteInput,
    requestedProfile: ExecutionProfile,
    onChunk?: (stream: 'stdout' | 'stderr', chunk: string) => void,
  ): Promise<CodeExecuteOutput> {
    this.assertProcessExecutionAllowed(requestedProfile);
    const fallbackRoot = this.executionWorkspacePolicy.getRoots()[0];
    const requestedCwd = input.cwd ?? fallbackRoot;
    if (!requestedCwd) {
      throw new TerminalProtocolError('PATH_NOT_ALLOWED', 'No allowed workspace root is configured for code execution.');
    }
    const cwd = this.executionWorkspacePolicy.resolveCwd(requestedCwd);
    return this.codeExecutor.execute(userId, input, cwd, onChunk);
  }

  cancelCode(userId: string, executionId: string, requestedProfile: ExecutionProfile): CodeCancelOutput {
    this.assertProcessExecutionAllowed(requestedProfile);
    return this.codeExecutor.cancel(userId, executionId);
  }

  async startLsp(userId: string, input: LspStartInput, requestedProfile: ExecutionProfile): Promise<LspStartOutput> {
    this.assertProcessExecutionAllowed(requestedProfile);
    const root = this.executionWorkspacePolicy.resolveCwd(input.root);
    return this.lspManager.start(userId, input, root);
  }

  requestLsp(userId: string, input: LspRequestInput, requestedProfile: ExecutionProfile): Promise<LspRequestOutput> {
    this.assertProcessExecutionAllowed(requestedProfile);
    return this.lspManager.request(userId, input);
  }

  stopLsp(userId: string, lspId: string, requestedProfile: ExecutionProfile): LspStopOutput {
    this.assertProcessExecutionAllowed(requestedProfile);
    return this.lspManager.stop(userId, lspId);
  }

  async openSemantic(userId: string, input: SemanticOpenInput, _requestedProfile: ExecutionProfile): Promise<SemanticOpenOutput> {
    void _requestedProfile;
    const root = this.executionWorkspacePolicy.resolveCwd(input.root);
    return this.semanticManager.open(userId, input, root);
  }

  querySemantic(userId: string, input: SemanticQueryInput, _requestedProfile: ExecutionProfile): Promise<SemanticQueryOutput> {
    void _requestedProfile;
    switch (input.operation) {
      case 'document_symbols':
        return this.semanticManager.documentSymbols(userId, input.semantic_id, input.path);
      case 'workspace_symbols':
        return this.semanticManager.findSymbols(userId, input.semantic_id, input.query);
      case 'references':
        return this.semanticManager.references(userId, input.semantic_id, input.path, input.line, input.character, input.include_declaration);
      case 'definition':
        return this.semanticManager.definition(userId, input.semantic_id, input.path, input.line, input.character);
      case 'implementations':
        return this.semanticManager.implementations(userId, input.semantic_id, input.path, input.line, input.character);
      case 'diagnostics':
        return this.semanticManager.diagnostics(userId, input.semantic_id, input.path);
    }
  }

  previewSemanticEdit(userId: string, input: SemanticPreviewEditInput, _requestedProfile: ExecutionProfile): Promise<SemanticPreviewEditOutput> {
    void _requestedProfile;
    return this.semanticManager.previewEdit(userId, input.semantic_id, input.edit);
  }

  applySemanticEdit(userId: string, input: SemanticApplyEditInput, requestedProfile: ExecutionProfile): Promise<SemanticApplyEditOutput> {
    this.assertProcessExecutionAllowed(requestedProfile);
    return this.semanticManager.applyEdit(userId, input.semantic_id, input.preview_id);
  }

  projectSemanticOverview(userId: string, input: SemanticProjectOverviewInput, _requestedProfile: ExecutionProfile): Promise<SemanticProjectOverviewOutput> {
    void _requestedProfile;
    return this.semanticManager.projectOverview(userId, input.semantic_id);
  }

  readSemanticMemory(userId: string, input: SemanticMemoryReadInput, _requestedProfile: ExecutionProfile): Promise<SemanticMemoryOutput> {
    void _requestedProfile;
    return this.semanticManager.readMemory(userId, input.semantic_id, input.name);
  }

  writeSemanticMemory(userId: string, input: SemanticMemoryWriteInput, requestedProfile: ExecutionProfile): Promise<SemanticMemoryOutput> {
    this.assertProcessExecutionAllowed(requestedProfile);
    return this.semanticManager.writeMemory(userId, input.semantic_id, input.name, input.content);
  }

  closeSemantic(userId: string, input: SemanticCloseInput, _requestedProfile: ExecutionProfile): SemanticCloseOutput {
    void _requestedProfile;
    return this.semanticManager.close(userId, input.semantic_id);
  }

  private assertProcessExecutionAllowed(requestedProfile: ExecutionProfile): void {
    const effectiveProfile = restrictiveExecutionProfile(this.options.executionProfile, requestedProfile);
    if (effectiveProfile === 'read-only') {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'The effective execution profile does not allow process execution.');
    }
  }

  private resolveFilePath(managed: ManagedSession, filePath: string): string {
    const absolute = isAbsolute(filePath) ? filePath : resolve(managed.metadata.cwd, filePath);
    return this.workspacePolicy.resolveExistingPath(absolute);
  }

  onEvent(listener: (event: TerminalEvent) => void): () => void {
    this.eventEmitter.on('terminal-event', listener);
    return () => this.eventEmitter.off('terminal-event', listener);
  }

  stopProcessFeatures(): void {
    this.codeExecutor.shutdown();
    this.semanticManager.stopAll();
    this.lspManager.stopAll();
  }

  shutdown(): void {
    clearInterval(this.sweepTimer);
    this.stopProcessFeatures();
    for (const managed of this.sessions.values()) {
      if (managed.metadata.status !== 'closed' && managed.metadata.status !== 'exited' && managed.metadata.status !== 'closing') {
        this.closeManaged(managed, 'system', 'agent_shutdown');
      }
      this.persistSessionSafely(managed);
    }
    this.eventJournal?.close();
    this.eventEmitter.removeAllListeners();
  }

  private sweepExpiredSessions(): void {
    const now = Date.now();
    this.eventJournal?.sweep(now);
    for (const [sessionId, managed] of this.sessions) {
      const activityMs = Date.parse(managed.metadata.last_activity_at);
      if (isTerminalFinal(managed.metadata.status)) {
        if (Number.isFinite(activityMs) && now - activityMs >= this.closedSessionRetentionMs) {
          if (managed.outputFlushTimer) clearTimeout(managed.outputFlushTimer);
          this.sessions.delete(sessionId);
          this.deletePersistedSession(managed);
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

    const terminal = managed.process;
    if (!terminal) {
      managed.metadata.status = 'closed';
      this.recordEvent(managed, actor, 'session.closed', { reason, exit_code: managed.metadata.exit_code });
      return;
    }

    const closeRequest = { actor, reason, finalized: false };
    managed.closeRequest = closeRequest;
    managed.metadata.status = 'closing';
    managed.metadata.last_activity_at = new Date().toISOString();
    this.flushOutput(managed);
    try {
      terminal.terminate();
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

  private requireWritableSession(sessionId: string): ManagedSession & { process: TerminalProcess } {
    const managed = this.requireSession(sessionId);
    if (!managed.process || managed.closeRequest || managed.metadata.status === 'closing' || managed.metadata.status === 'closed' || managed.metadata.status === 'exited' || managed.metadata.status === 'failed') {
      throw new TerminalProtocolError('SESSION_CLOSED', 'Terminal session is not writable.');
    }
    return managed as ManagedSession & { process: TerminalProcess };
  }

  private readJournalEvents(
    managed: ManagedSession,
    after: number,
    maxBytes: number,
  ): { events: TerminalEvent[]; nextCursor: number; hasMore: boolean } | undefined {
    if (!this.eventJournal) return undefined;
    const replay = this.eventJournal.read(managed.metadata.session_id);
    if (replay.earliestSequence === undefined || after < replay.earliestSequence - 1) return undefined;

    const events: TerminalEvent[] = [];
    let bytes = 0;
    for (let index = 0; index < replay.events.length; index += 1) {
      const event = replay.events[index];
      const eventBytes = replay.eventBytes[index];
      if (!event || eventBytes === undefined || event.sequence <= after) continue;
      if (events.length === 0 && event.sequence !== after + 1) return undefined;
      if (events.length > 0 && bytes + eventBytes > maxBytes) break;
      if (events.length === 0 && eventBytes > maxBytes) {
        throw new TerminalProtocolError(
          'OUTPUT_LIMIT_REACHED',
          `The next terminal event requires ${eventBytes} bytes, which exceeds max_bytes=${maxBytes}.`,
        );
      }
      events.push(event);
      bytes += eventBytes;
    }

    const nextCursor = events.at(-1)?.sequence ?? after;
    return { events, nextCursor, hasMore: nextCursor < managed.sequence };
  }

  private enqueueOutput(managed: ManagedSession, text: string): void {
    if (!text) return;
    for (const chunk of splitUtf8ByBytes(text, this.outputFlushBytes)) {
      const chunkBytes = Buffer.byteLength(chunk);
      if (managed.outputBufferBytes > 0 && managed.outputBufferBytes + chunkBytes > this.outputFlushBytes) {
        this.flushOutput(managed);
      }
      managed.outputBuffer += chunk;
      managed.outputBufferBytes += chunkBytes;
      if (managed.outputBufferBytes >= this.outputFlushBytes) this.flushOutput(managed);
    }

    if (managed.outputBufferBytes > 0 && !managed.outputFlushTimer) {
      managed.outputFlushTimer = setTimeout(() => {
        managed.outputFlushTimer = undefined;
        if (managed.closeRequest?.finalized) return;
        this.flushOutput(managed);
      }, this.outputFlushIntervalMs);
      managed.outputFlushTimer.unref();
    }
  }

  private flushOutput(managed: ManagedSession): void {
    if (managed.outputFlushTimer) {
      clearTimeout(managed.outputFlushTimer);
      managed.outputFlushTimer = undefined;
    }
    if (managed.outputBufferBytes === 0) return;
    const text = managed.outputBuffer;
    managed.outputBuffer = '';
    managed.outputBufferBytes = 0;
    this.recordEvent(managed, 'agent', 'terminal.stdout', { text });
  }

  private scheduleCwdRefresh(managed: ManagedSession): void {
    const terminal = managed.process;
    if (!terminal || process.platform !== 'linux' || managed.cwdRefreshTimer || managed.closeRequest?.finalized) return;
    managed.cwdRefreshTimer = setTimeout(() => {
      delete managed.cwdRefreshTimer;
      if (isTerminalFinal(managed.metadata.status) || managed.closeRequest?.finalized) return;
      try {
        const cwd = readlinkSync(`/proc/${terminal.pid}/cwd`);
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

  private sessionStatePath(sessionId: string): string | undefined {
    if (!this.stateDir) return undefined;
    const digest = createHash('sha256').update(sessionId).digest('hex');
    return join(this.stateDir, `${digest}.json`);
  }

  private scheduleSessionPersistence(managed: ManagedSession): void {
    if (!this.stateDir || managed.persistenceTimer) return;
    managed.persistenceTimer = setTimeout(() => {
      delete managed.persistenceTimer;
      this.persistSessionSafely(managed);
    }, 25);
    managed.persistenceTimer.unref();
  }

  private persistSessionSafely(managed: ManagedSession): void {
    if (managed.persistenceTimer) {
      clearTimeout(managed.persistenceTimer);
      delete managed.persistenceTimer;
    }
    try {
      this.persistSession(managed);
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'agent.session_state_write_failed',
        session_id: managed.metadata.session_id,
        error: errorMsg(error),
      }));
    }
  }

  private persistSession(managed: ManagedSession): void {
    const statePath = this.sessionStatePath(managed.metadata.session_id);
    if (!statePath || !this.stateDir) return;
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const state: PersistedSessionState = {
      version: 1,
      session: { ...managed.metadata },
      events: managed.events.slice(managed.eventHead),
      sequence: managed.sequence,
      earliest_sequence: managed.earliestSequence,
    };
    const tempPath = `${statePath}.${process.pid}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tempPath, statePath);
  }

  private deletePersistedSession(managed: ManagedSession): void {
    if (managed.persistenceTimer) {
      clearTimeout(managed.persistenceTimer);
      delete managed.persistenceTimer;
    }
    const statePath = this.sessionStatePath(managed.metadata.session_id);
    if (!statePath) return;
    try {
      unlinkSync(statePath);
    } catch (error) {
      if (!isFileNotFound(error)) {
        console.error(JSON.stringify({
          level: 'warn',
          event: 'agent.session_state_delete_failed',
          session_id: managed.metadata.session_id,
          error: errorMsg(error),
        }));
      }
    }
  }

  private restorePersistedSessions(): void {
    if (!this.stateDir) return;
    let entries: string[];
    try {
      entries = readdirSync(this.stateDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      throw new TerminalProtocolError('INVALID_ARGUMENT', `Cannot read terminal session state directory: ${errorMsg(error)}`);
    }
    const maxRestoredSessions = 256;
    let restoredSessions = 0;
    let scannedStateFiles = 0;
    const maxStateBytes = Math.max(1024 * 1024, this.bufferHighWaterBytes * 4 + 256 * 1024);
    for (const name of entries) {
      if (restoredSessions >= maxRestoredSessions) break;
      scannedStateFiles += 1;
      const statePath = join(this.stateDir, name);
      try {
        const info = statSync(statePath);
        if (!info.isFile() || info.size > maxStateBytes) throw new Error('persisted session state exceeds the configured size bound');
        const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as unknown;
        if (!parsed || typeof parsed !== 'object') throw new Error('persisted session state must be an object');
        const candidate = parsed as Partial<PersistedSessionState>;
        if (candidate.version !== 1 || !Array.isArray(candidate.events)) throw new Error('unsupported persisted session state version');
        if (!Number.isInteger(candidate.sequence) || (candidate.sequence ?? -1) < 0) throw new Error('persisted session sequence is invalid');
        if (!Number.isInteger(candidate.earliest_sequence) || (candidate.earliest_sequence ?? 0) < 1) throw new Error('persisted session retained boundary is invalid');
        if (candidate.events.length > 20_000) throw new Error('persisted session contains too many retained events');

        const metadata = terminalSessionSchema.parse(candidate.session);
        if (metadata.agent_id !== this.agent.agent_id) continue;
        const events = candidate.events.map((event) => terminalEventSchema.parse(event));
        const sequence = candidate.sequence as number;
        const persistedEarliest = candidate.earliest_sequence as number;
        if (persistedEarliest > sequence + 1) throw new Error('persisted session retained boundary is ahead of its cursor');
        if (events.length > 0 && events[0]?.sequence !== persistedEarliest) throw new Error('persisted session event boundary does not match its cursor');
        let previousSequence = persistedEarliest - 1;
        for (const event of events) {
          if (event.session_id !== metadata.session_id || event.sequence !== previousSequence + 1 || event.sequence > sequence) {
            throw new Error('persisted session event sequence is invalid');
          }
          previousSequence = event.sequence;
        }
        if (events.length > 0 && previousSequence !== sequence) throw new Error('persisted session history does not reach its advertised cursor');
        if (events.length === 0 && sequence !== 0) throw new Error('persisted session cursor has no retained history');
        if (this.sessions.has(metadata.session_id)) throw new Error('duplicate persisted session identifier');

        const eventSizes = events.map((event) => Buffer.byteLength(JSON.stringify(event)));
        let eventHead = 0;
        let retainedBytes = eventSizes.reduce((total, bytes) => total + bytes, 0);
        let earliestSequence = persistedEarliest;
        while (retainedBytes > this.bufferHighWaterBytes && events.length - eventHead > 1) {
          const removed = events[eventHead];
          const removedBytes = eventSizes[eventHead];
          if (!removed || removedBytes === undefined) break;
          eventHead += 1;
          retainedBytes -= removedBytes;
          earliestSequence = removed.sequence + 1;
        }

        const activityMs = Date.parse(metadata.last_activity_at);
        if (isTerminalFinal(metadata.status) && Number.isFinite(activityMs) && Date.now() - activityMs >= this.closedSessionRetentionMs) {
          unlinkSync(statePath);
          continue;
        }

        const managed: ManagedSession = {
          metadata: { ...metadata },
          events,
          eventSizes,
          eventHead,
          sequence,
          retainedBytes,
          earliestSequence,
          outputFlushTimer: undefined,
          outputBuffer: '',
          outputBufferBytes: 0,
        };
        this.sessions.set(metadata.session_id, managed);
        restoredSessions += 1;
        if (!isTerminalFinal(metadata.status)) {
          managed.metadata.status = 'closed';
          managed.metadata.exit_code = null;
          this.recordEvent(managed, 'system', 'session.closed', {
            reason: 'agent_restart',
            exit_code: null,
          });
          this.persistSessionSafely(managed);
        }
      } catch (error) {
        console.error(JSON.stringify({
          level: 'warn',
          event: 'agent.session_state_invalid',
          file: name,
          error: errorMsg(error),
        }));
      }
    }
    if (scannedStateFiles < entries.length) {
      console.error(JSON.stringify({
        level: 'warn',
        event: 'agent.session_state_limit_reached',
        files: entries.length,
        restored: restoredSessions,
        limit: maxRestoredSessions,
      }));
    }
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
    // Keep retained-byte accounting exact. Terminal output commonly contains ANSI/control
    // bytes that expand when JSON-escaped, so raw text length can materially undercount memory.
    const eventBytes = Buffer.byteLength(JSON.stringify(event));
    managed.events.push(event);
    managed.eventSizes.push(eventBytes);
    managed.retainedBytes += eventBytes;
    managed.metadata.last_activity_at = now;
    try {
      this.eventJournal?.append(event);
    } catch {
      // Durable replay is optional. A disk-full or permission error must not
      // interrupt the live terminal stream or recursively emit another event.
    }

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

    this.scheduleSessionPersistence(managed);
    this.eventEmitter.emit('terminal-event', event);
    return event;
  }
}
