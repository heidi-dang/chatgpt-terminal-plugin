import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { signalProcessTree } from './process-tree.js';
import {
  TerminalProtocolError,
  type LspRequestInput,
  type LspRequestOutput,
  type LspStartInput,
  type LspStartOutput,
  type LspStopOutput,
} from '@terminal/protocol';

export interface LspServerDefinition {
  command: string;
  args: string[];
}

export interface LspServerNotification {
  lsp_id: string;
  method: string;
  params?: unknown;
}

export interface LspManagerOptions {
  servers: Readonly<Record<string, LspServerDefinition>>;
  environment: Record<string, string>;
  maxProcesses?: number;
  requestTimeoutMs?: number;
  maxMessageBytes?: number;
  maxBufferBytes?: number;
  maxHeaderBytes?: number;
  maxStderrBytes?: number;
  killGraceMs?: number;
}

interface PendingRequest {
  resolve: (value: LspRequestOutput) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ManagedLsp {
  lspId: string;
  userId: string;
  serverId: string;
  root: string;
  child: ChildProcessWithoutNullStreams;
  buffer: Buffer;
  stderrBytes: number;
  nextRequestId: number;
  pending: Map<number, PendingRequest>;
  forceKillTimer?: NodeJS.Timeout;
  stopping: boolean;
}

const DEFAULT_MAX_PROCESSES = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_HEADER_BYTES = 16 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 256 * 1024;
const DEFAULT_KILL_GRACE_MS = 1_000;

const STANDARD_LSP_CLIENT_NOTIFICATIONS = new Set([
  'initialized', 'exit', '$/cancelRequest', '$/setTrace', 'window/workDoneProgress/cancel',
  'workspace/didChangeConfiguration', 'workspace/didChangeWatchedFiles', 'workspace/didChangeWorkspaceFolders',
  'textDocument/didOpen', 'textDocument/didChange', 'textDocument/willSave', 'textDocument/didSave', 'textDocument/didClose',
  'notebookDocument/didOpen', 'notebookDocument/didChange', 'notebookDocument/didSave', 'notebookDocument/didClose',
]);

export class LspManager {
  private readonly processes = new Map<string, ManagedLsp>();
  private readonly notificationListeners = new Set<(notification: LspServerNotification) => void>();
  private readonly startingProcesses = new Set<ManagedLsp>();
  private stopped = false;
  private readonly servers: Readonly<Record<string, LspServerDefinition>>;
  private readonly environment: Record<string, string>;
  private readonly maxProcesses: number;
  private readonly requestTimeoutMs: number;
  private readonly maxMessageBytes: number;
  private readonly maxBufferBytes: number;
  private readonly maxHeaderBytes: number;
  private readonly maxStderrBytes: number;
  private readonly killGraceMs: number;

  constructor(options: LspManagerOptions) {
    this.servers = options.servers;
    this.environment = { ...options.environment };
    this.maxProcesses = options.maxProcesses ?? DEFAULT_MAX_PROCESSES;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    this.maxHeaderBytes = options.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES;
    this.maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  }

  async start(userId: string, input: LspStartInput, root: string): Promise<LspStartOutput> {
    if (this.stopped) {
      throw new TerminalProtocolError('AGENT_OFFLINE', 'LSP manager has been shut down.', true);
    }
    if (this.processes.size + this.startingProcesses.size >= this.maxProcesses) {
      throw new TerminalProtocolError('SESSION_LIMIT_REACHED', 'LSP process limit has been reached.');
    }
    const definition = this.servers[input.server_id];
    if (!definition) {
      throw new TerminalProtocolError('INVALID_ARGUMENT', `LSP server '${input.server_id}' is not configured on this agent.`);
    }

    let managed: ManagedLsp | undefined;
    try {
      const child = spawn(definition.command, definition.args, {
        cwd: root,
        env: this.environment,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      const lspId = randomUUID();
      managed = {
        lspId,
        userId,
        serverId: input.server_id,
        root,
        child,
        buffer: Buffer.alloc(0),
        stderrBytes: 0,
        nextRequestId: 1,
        pending: new Map(),
        stopping: false,
      };
      this.startingProcesses.add(managed);

      child.stdout.on('data', (chunk: Buffer) => this.handleStdout(managed!, chunk));
      child.stderr.on('data', (chunk: Buffer) => this.handleStderr(managed!, chunk));
      child.once('close', (code, signal) => this.handleExit(managed!, code, signal));

      await new Promise<void>((resolve, reject) => {
        const onSpawn = (): void => {
          child.off('error', onError);
          resolve();
        };
        const onError = (error: Error): void => {
          child.off('spawn', onSpawn);
          if (this.stopped || managed?.stopping) {
            reject(new TerminalProtocolError('AGENT_OFFLINE', 'Local agent shut down during LSP startup.', true));
            return;
          }
          reject(new TerminalProtocolError('PTY_CREATE_FAILED', `Failed to start configured LSP server: ${error.message}`));
        };
        child.once('spawn', onSpawn);
        child.once('error', onError);
      });

      if (this.stopped || managed.stopping) {
        this.terminate(managed);
        throw new TerminalProtocolError('AGENT_OFFLINE', 'Local agent shut down during LSP startup.', true);
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new TerminalProtocolError('PTY_CREATE_FAILED', 'Configured LSP server exited during startup.');
      }
      child.on('error', (error) => this.failProcess(managed!, new TerminalProtocolError('PTY_CREATE_FAILED', `LSP process error: ${error.message}`)));
      this.processes.set(lspId, managed);
      return { lsp_id: lspId, server_id: input.server_id, root };
    } finally {
      if (managed) this.startingProcesses.delete(managed);
    }
  }

  request(userId: string, input: LspRequestInput): Promise<LspRequestOutput> {
    const managed = this.requireOwned(userId, input.lsp_id);
    const isNotification = input.notification === true || STANDARD_LSP_CLIENT_NOTIFICATIONS.has(input.method);
    if (isNotification) {
      const message: Record<string, unknown> = { jsonrpc: '2.0', method: input.method };
      if (input.params !== undefined) message.params = input.params;
      return this.writeMessage(managed, message).then(() => ({ lsp_id: managed.lspId }));
    }

    const requestId = managed.nextRequestId++;
    return new Promise<LspRequestOutput>((resolve, reject) => {
      const timer = setTimeout(() => {
        managed.pending.delete(requestId);
        void this.writeMessage(managed, { jsonrpc: '2.0', method: '$/cancelRequest', params: { id: requestId } }).catch(() => undefined);
        reject(new TerminalProtocolError('AGENT_TIMEOUT', `LSP request '${input.method}' timed out.`));
      }, this.requestTimeoutMs);
      timer.unref();
      managed.pending.set(requestId, { resolve, reject, timer });

      const message: Record<string, unknown> = { jsonrpc: '2.0', id: requestId, method: input.method };
      if (input.params !== undefined) message.params = input.params;
      void this.writeMessage(managed, message).catch((error: unknown) => {
        const pending = managed.pending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        managed.pending.delete(requestId);
        pending.reject(normalizeLspError(error));
      });
    });
  }

  stop(userId: string, lspId: string): LspStopOutput {
    const managed = this.requireOwned(userId, lspId);
    managed.stopping = true;
    this.terminate(managed);
    return { lsp_id: lspId, stopped: true };
  }

  get activeCount(): number {
    return this.processes.size;
  }

  onNotification(listener: (notification: LspServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  stopAll(): void {
    if (this.stopped) return;
    this.stopped = true;
    const shutdownError = new TerminalProtocolError('AGENT_OFFLINE', 'Local agent is shutting down.', true);
    for (const managed of this.processes.values()) {
      managed.stopping = true;
      this.terminate(managed);
      this.rejectPending(managed, shutdownError);
    }
    for (const managed of this.startingProcesses) {
      managed.stopping = true;
      this.terminate(managed);
      this.rejectPending(managed, shutdownError);
    }
    this.processes.clear();
  }

  private requireOwned(userId: string, lspId: string): ManagedLsp {
    const managed = this.processes.get(lspId);
    if (!managed) throw new TerminalProtocolError('SESSION_NOT_FOUND', 'LSP process was not found.');
    if (managed.userId !== userId) throw new TerminalProtocolError('PERMISSION_DENIED', 'LSP process is owned by another user.');
    return managed;
  }

  private async writeMessage(managed: ManagedLsp, message: Record<string, unknown>): Promise<void> {
    let body: string;
    try {
      body = JSON.stringify(message);
    } catch {
      throw new TerminalProtocolError('INVALID_ARGUMENT', 'LSP message is not JSON serializable.');
    }
    const bodyBytes = Buffer.byteLength(body);
    if (bodyBytes > this.maxMessageBytes) {
      throw new TerminalProtocolError('OUTPUT_LIMIT_REACHED', 'Outgoing LSP message exceeds the configured limit.');
    }
    const frame = `Content-Length: ${bodyBytes}\r\n\r\n${body}`;
    await new Promise<void>((resolve, reject) => {
      managed.child.stdin.write(frame, 'utf8', (error) => {
        if (error) reject(new TerminalProtocolError('AGENT_OFFLINE', `Failed to write to LSP process: ${error.message}`));
        else resolve();
      });
    });
  }

  private handleStdout(managed: ManagedLsp, chunk: Buffer): void {
    if (!this.processes.has(managed.lspId)) return;
    if (managed.buffer.length + chunk.length > this.maxBufferBytes) {
      this.failProcess(managed, new TerminalProtocolError('OUTPUT_LIMIT_REACHED', 'LSP receive buffer exceeded the configured limit.'));
      return;
    }
    managed.buffer = Buffer.concat([managed.buffer, chunk]);
    this.drainFrames(managed);
  }

  private drainFrames(managed: ManagedLsp): void {
    while (managed.buffer.length > 0) {
      const headerEnd = managed.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        if (managed.buffer.length > this.maxHeaderBytes) {
          this.failProcess(managed, new TerminalProtocolError('INVALID_ARGUMENT', 'Malformed LSP header exceeded the configured limit.'));
        }
        return;
      }
      if (headerEnd > this.maxHeaderBytes) {
        this.failProcess(managed, new TerminalProtocolError('INVALID_ARGUMENT', 'LSP header exceeds the configured limit.'));
        return;
      }

      const headerText = managed.buffer.subarray(0, headerEnd).toString('ascii');
      const lengths = headerText
        .split('\r\n')
        .map((line) => /^Content-Length:\s*(\d+)$/i.exec(line))
        .filter((match): match is RegExpExecArray => match !== null);
      if (lengths.length !== 1) {
        this.failProcess(managed, new TerminalProtocolError('INVALID_ARGUMENT', 'Malformed LSP Content-Length header.'));
        return;
      }
      const rawLength = lengths[0]?.[1];
      const contentLength = rawLength ? Number(rawLength) : Number.NaN;
      if (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > this.maxMessageBytes) {
        this.failProcess(managed, new TerminalProtocolError('OUTPUT_LIMIT_REACHED', 'LSP message Content-Length is invalid or too large.'));
        return;
      }

      const bodyStart = headerEnd + 4;
      const frameEnd = bodyStart + contentLength;
      if (managed.buffer.length < frameEnd) return;
      const body = managed.buffer.subarray(bodyStart, frameEnd).toString('utf8');
      managed.buffer = managed.buffer.subarray(frameEnd);
      this.handleMessage(managed, body);
      if (!this.processes.has(managed.lspId)) return;
    }
  }

  private handleMessage(managed: ManagedLsp, body: string): void {
    let message: unknown;
    try {
      message = JSON.parse(body) as unknown;
    } catch {
      this.failProcess(managed, new TerminalProtocolError('INVALID_ARGUMENT', 'LSP process emitted malformed JSON.'));
      return;
    }
    if (!isRecord(message)) {
      this.failProcess(managed, new TerminalProtocolError('INVALID_ARGUMENT', 'LSP process emitted a non-object JSON message.'));
      return;
    }

    const id = message.id;
    const method = message.method;
    if (typeof method === 'string' && id === undefined) {
      const notification: LspServerNotification = {
        lsp_id: managed.lspId,
        method,
        ...('params' in message ? { params: message.params } : {}),
      };
      for (const listener of this.notificationListeners) {
        try { listener(notification); } catch { /* Listener failures must not destabilize the LSP transport. */ }
      }
      return;
    }
    if (typeof method === 'string' && (typeof id === 'number' || typeof id === 'string')) {
      this.handleServerRequest(managed, id, method, message.params);
      return;
    }
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) return;

    const pending = managed.pending.get(id);
    if (!pending) return;
    managed.pending.delete(id);
    clearTimeout(pending.timer);
    if ('error' in message && message.error !== undefined) {
      pending.reject(new TerminalProtocolError('INVALID_ARGUMENT', `LSP request failed: ${lspErrorMessage(message.error)}`));
      return;
    }
    pending.resolve({ lsp_id: managed.lspId, ...('result' in message ? { result: message.result } : {}) });
  }

  private handleServerRequest(managed: ManagedLsp, id: number | string, method: string, params: unknown): void {
    let response: Record<string, unknown>;
    switch (method) {
      case 'workspace/configuration': {
        const request = isRecord(params) ? params : undefined;
        const items = Array.isArray(request?.items) ? request.items : [];
        response = { jsonrpc: '2.0', id, result: items.map(() => null) };
        break;
      }
      case 'workspace/workspaceFolders':
        response = {
          jsonrpc: '2.0',
          id,
          result: [{ uri: pathToFileURL(managed.root).href.replace(/\/$/, ''), name: basename(managed.root) || managed.root }],
        };
        break;
      case 'window/workDoneProgress/create':
        response = { jsonrpc: '2.0', id, result: null };
        break;
      default:
        response = {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Server-initiated LSP request '${method}' is not permitted by this terminal agent.` },
        };
    }
    void this.writeMessage(managed, response)
      .catch((error: unknown) => this.failProcess(managed, normalizeLspError(error)));
  }

  private handleStderr(managed: ManagedLsp, chunk: Buffer): void {
    managed.stderrBytes += chunk.length;
    if (managed.stderrBytes > this.maxStderrBytes) {
      this.failProcess(managed, new TerminalProtocolError('OUTPUT_LIMIT_REACHED', 'LSP stderr exceeded the configured limit.'));
    }
  }

  private handleExit(managed: ManagedLsp, code: number | null, signal: NodeJS.Signals | null): void {
    if (managed.forceKillTimer) clearTimeout(managed.forceKillTimer);
    const registered = this.processes.get(managed.lspId);
    if (registered !== managed) return;
    this.processes.delete(managed.lspId);
    const detail = managed.stopping ? 'LSP process stopped.' : `LSP process exited (code=${String(code)}, signal=${String(signal)}).`;
    this.rejectPending(managed, new TerminalProtocolError('AGENT_OFFLINE', detail));
  }

  private failProcess(managed: ManagedLsp, error: Error): void {
    if (this.processes.get(managed.lspId) !== managed) return;
    this.processes.delete(managed.lspId);
    this.rejectPending(managed, error);
    managed.stopping = true;
    this.terminate(managed);
  }

  private rejectPending(managed: ManagedLsp, error: Error): void {
    for (const pending of managed.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    managed.pending.clear();
  }

  private terminate(managed: ManagedLsp): void {
    const pid = managed.child.pid;
    if (!pid || managed.child.exitCode !== null || managed.child.signalCode !== null) return;
    signalProcessTree(managed.child, 'SIGTERM');
    if (managed.forceKillTimer) clearTimeout(managed.forceKillTimer);
    managed.forceKillTimer = setTimeout(() => signalProcessTree(managed.child, 'SIGKILL'), this.killGraceMs);
    managed.forceKillTimer.unref();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lspErrorMessage(value: unknown): string {
  if (isRecord(value) && typeof value.message === 'string') return value.message;
  return 'remote LSP error';
}

function normalizeLspError(error: unknown): Error {
  return error instanceof Error ? error : new TerminalProtocolError('AGENT_OFFLINE', 'Unknown LSP transport error.');
}
