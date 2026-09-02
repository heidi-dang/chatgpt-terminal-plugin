import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { constants, readlinkSync, realpathSync } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import * as pty from 'node-pty';
import { CodeBlockExecutor } from './code-block-executor.js';
import { LspManager, type LspServerDefinition } from './lsp-manager.js';
export { discoverLspServers, resolveLspServers } from './lsp-discovery.js';
import {
  TerminalProtocolError,
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
  getTelemetry(): AgentHealthTelemetry;
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
  private readonly workspacePolicy: WorkspacePolicy;
  private readonly executionWorkspacePolicy: WorkspacePolicy;
  private readonly codeExecutor: CodeBlockExecutor;
  private readonly lspManager: LspManager;

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
    this.workspacePolicy = new WorkspacePolicy(options.allowedWorkspaceRoots, options.executionProfile);
    // Code and LSP execution are intentionally workspace-contained even for owner-full.
    this.executionWorkspacePolicy = new WorkspacePolicy(options.allowedWorkspaceRoots, 'developer');
    const environment = cleanEnvironment();
    this.codeExecutor = new CodeBlockExecutor({ environment });
    this.lspManager = new LspManager({ servers: options.lspServers ?? {}, environment });
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

  describe(): Agent {
    return {
      ...this.agent,
      telemetry: this.getTelemetry(),
      capabilities: { ...this.agent.capabilities, shells: [...this.agent.capabilities.shells] },
    };
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
  ): Promise<{ pattern: string; matches: Array<{ file: string; line: number; text: string; context_before?: string[]; context_after?: string[] }>; truncated: boolean; files_searched: number }> {
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

    const matches: Array<{ file: string; line: number; text: string; context_before?: string[]; context_after?: string[] }> = [];
    let filesSearched = 0;
    let truncated = false;
    const maxFilesSearched = 10_000;

    const walk = async (dir: string): Promise<void> => {
      if (truncated) return;
      let dirents;
      try {
        dirents = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // skip unreadable directories
      }
      for (const dirent of dirents) {
        if (truncated) return;
        const entryPath = resolve(dir, dirent.name);
        // Skip hidden dirs, node_modules, .git
        if (dirent.name.startsWith('.') || dirent.name === 'node_modules') continue;
        if (dirent.isDirectory()) {
          await walk(entryPath);
        } else if (dirent.isFile()) {
          if (filesSearched >= maxFilesSearched) {
            truncated = true;
            return;
          }
          // Apply include filter (simple glob: *.ts, *.js etc)
          if (include && !matchGlob(dirent.name, include)) continue;
          filesSearched += 1;
          try {
            const content = await readFileContent(entryPath, 512 * 1024); // max 512KB per file
            if (content === null) continue; // binary or too large
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i += 1) {
              const lineText = lines[i] ?? '';
              if (regex.test(lineText)) {
                const match: { file: string; line: number; text: string; context_before?: string[]; context_after?: string[] } = {
                  file: relative(managed.metadata.cwd, entryPath) || entryPath,
                  line: i + 1,
                  text: lineText.slice(0, 500),
                };
                if (contextLines > 0) {
                  match.context_before = lines.slice(Math.max(0, i - contextLines), i).map(l => l.slice(0, 500));
                  match.context_after = lines.slice(i + 1, i + 1 + contextLines).map(l => l.slice(0, 500));
                }
                matches.push(match);
                if (matches.length >= maxResults) {
                  truncated = true;
                  return;
                }
              }
            }
          } catch {
            // skip unreadable files
          }
        }
      }
    };

    if (info.isFile()) {
      // Search single file
      filesSearched = 1;
      try {
        const content = await readFileContent(resolved, 512 * 1024);
        if (content !== null) {
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i += 1) {
            const lineText = lines[i] ?? '';
            if (regex.test(lineText)) {
              const match: { file: string; line: number; text: string; context_before?: string[]; context_after?: string[] } = {
                file: relative(managed.metadata.cwd, resolved) || resolved,
                line: i + 1,
                text: lineText.slice(0, 500),
              };
              if (contextLines > 0) {
                match.context_before = lines.slice(Math.max(0, i - contextLines), i).map(l => l.slice(0, 500));
                match.context_after = lines.slice(i + 1, i + 1 + contextLines).map(l => l.slice(0, 500));
              }
              matches.push(match);
              if (matches.length >= maxResults) { truncated = true; break; }
            }
          }
        }
      } catch {
        throw new TerminalProtocolError('INVALID_ARGUMENT', `Cannot read file: ${searchPath}`);
      }
    } else {
      await walk(resolved);
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
    const fallbackRoot = this.options.allowedWorkspaceRoots[0];
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
    this.lspManager.stopAll();
  }

  shutdown(): void {
    clearInterval(this.sweepTimer);
    this.stopProcessFeatures();
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
    // Keep retained-byte accounting exact. Terminal output commonly contains ANSI/control
    // bytes that expand when JSON-escaped, so raw text length can materially undercount memory.
    const eventBytes = Buffer.byteLength(JSON.stringify(event));
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
