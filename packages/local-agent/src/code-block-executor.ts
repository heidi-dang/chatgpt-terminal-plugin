import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TerminalProtocolError,
  type CodeCancelOutput,
  type CodeExecuteInput,
  type CodeExecuteOutput,
  type CodeRuntime,
} from '@terminal/protocol';

export interface CodeBlockExecutorOptions {
  environment: Record<string, string>;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxCombinedOutputBytes?: number;
  killGraceMs?: number;
}

interface ActiveExecution {
  userId: string;
  child: ChildProcess;
  cancelled: boolean;
  forceKillTimer?: NodeJS.Timeout;
}

interface RuntimeInvocation {
  extension: string;
  command: string;
  args: (scriptPath: string) => string[];
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_STREAM_LIMIT = 256 * 1024;
const DEFAULT_COMBINED_LIMIT = 384 * 1024;
const DEFAULT_KILL_GRACE_MS = 1_000;

export class CodeBlockExecutor {
  private readonly active = new Map<string, ActiveExecution>();
  private readonly environment: Record<string, string>;
  private readonly defaultTimeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly maxStdoutBytes: number;
  private readonly maxStderrBytes: number;
  private readonly maxCombinedOutputBytes: number;
  private readonly killGraceMs: number;

  constructor(options: CodeBlockExecutorOptions) {
    this.environment = { ...options.environment };
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxTimeoutMs = options.maxTimeoutMs ?? MAX_TIMEOUT_MS;
    this.maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_STREAM_LIMIT;
    this.maxStderrBytes = options.maxStderrBytes ?? DEFAULT_STREAM_LIMIT;
    this.maxCombinedOutputBytes = options.maxCombinedOutputBytes ?? DEFAULT_COMBINED_LIMIT;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  }

  async execute(
    userId: string,
    input: CodeExecuteInput,
    cwd: string,
    onChunk?: (stream: 'stdout' | 'stderr', chunk: string) => void,
  ): Promise<CodeExecuteOutput> {
    if (this.active.has(input.execution_id)) {
      throw new TerminalProtocolError('INVALID_ARGUMENT', 'Execution identifier is already active.');
    }

    const invocation = runtimeInvocation(input.runtime, this.environment);
    const timeoutMs = Math.min(input.timeout_ms ?? this.defaultTimeoutMs, this.maxTimeoutMs);
    const tempDir = await mkdtemp(join(tmpdir(), 'chatgpt-terminal-code-'));
    const scriptPath = join(tempDir, `script${invocation.extension}`);
    const startedAt = Date.now();

    try {
      await writeFile(scriptPath, input.code, { encoding: 'utf8', mode: 0o700, flag: 'wx' });
      return await this.runChild(userId, input, cwd, invocation.command, invocation.args(scriptPath), timeoutMs, startedAt, onChunk);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  cancel(userId: string, executionId: string): CodeCancelOutput {
    const active = this.active.get(executionId);
    if (!active) return { execution_id: executionId, cancelled: false };
    if (active.userId !== userId) {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'Code execution is owned by another user.');
    }
    active.cancelled = true;
    this.terminate(active);
    return { execution_id: executionId, cancelled: true };
  }

  shutdown(): void {
    for (const active of this.active.values()) this.terminate(active);
    this.active.clear();
  }

  private runChild(
    userId: string,
    input: CodeExecuteInput,
    cwd: string,
    command: string,
    args: string[],
    timeoutMs: number,
    startedAt: number,
    onChunk?: (stream: 'stdout' | 'stderr', chunk: string) => void,
  ): Promise<CodeExecuteOutput> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: this.environment,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      const active: ActiveExecution = { userId, child, cancelled: false };
      this.active.set(input.execution_id, active);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let combinedBytes = 0;
      let timedOut = false;
      let limitError: TerminalProtocolError | undefined;
      let settled = false;

      const finish = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (active.forceKillTimer) clearTimeout(active.forceKillTimer);
        this.active.delete(input.execution_id);
        if (limitError) {
          reject(limitError);
          return;
        }
        if (active.cancelled) {
          reject(new TerminalProtocolError('REQUEST_CANCELLED', 'Code execution was cancelled.'));
          return;
        }
        resolve({
          execution_id: input.execution_id,
          stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8'),
          stderr: Buffer.concat(stderrChunks, stderrBytes).toString('utf8'),
          exit_code: exitCode,
          timed_out: timedOut,
          duration_ms: Math.max(0, Date.now() - startedAt),
        });
      };

      const append = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
        if (limitError) return;
        const streamBytes = stream === 'stdout' ? stdoutBytes : stderrBytes;
        const streamLimit = stream === 'stdout' ? this.maxStdoutBytes : this.maxStderrBytes;
        const allowed = Math.max(0, Math.min(streamLimit - streamBytes, this.maxCombinedOutputBytes - combinedBytes));
        if (allowed > 0) {
          const slice = chunk.subarray(0, allowed);
          if (stream === 'stdout') {
            stdoutChunks.push(slice);
            stdoutBytes += slice.length;
          } else {
            stderrChunks.push(slice);
            stderrBytes += slice.length;
          }
          combinedBytes += slice.length;
          if (onChunk) {
            try {
              onChunk(stream, slice.toString('utf8'));
            } catch {
              // Ignore consumer chunk handler errors
            }
          }
        }
        if (allowed < chunk.length) {
          limitError = new TerminalProtocolError('OUTPUT_LIMIT_REACHED', 'Code execution exceeded the configured output limit.');
          this.terminate(active);
        }
      };

      child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.active.delete(input.execution_id);
        reject(new TerminalProtocolError('PTY_CREATE_FAILED', `Failed to start code runtime: ${error.message}`));
      });
      child.once('close', (code) => finish(code));

      const timeout = setTimeout(() => {
        timedOut = true;
        this.terminate(active);
      }, timeoutMs);
      timeout.unref();
    });
  }

  private terminate(active: ActiveExecution): void {
    const pid = active.child.pid;
    if (!pid || active.child.exitCode !== null || active.child.signalCode !== null) return;
    signalProcessTree(active.child, 'SIGTERM');
    if (active.forceKillTimer) clearTimeout(active.forceKillTimer);
    active.forceKillTimer = setTimeout(() => signalProcessTree(active.child, 'SIGKILL'), this.killGraceMs);
    active.forceKillTimer.unref();
  }
}

function runtimeInvocation(runtime: CodeRuntime, environment: Readonly<Record<string, string>>): RuntimeInvocation {
  switch (runtime) {
    case 'bash':
      return { extension: '.sh', command: 'bash', args: (scriptPath) => [scriptPath] };
    case 'python3':
      return { extension: '.py', command: 'python3', args: (scriptPath) => [scriptPath] };
    case 'node':
      return { extension: '.mjs', command: process.execPath, args: (scriptPath) => [scriptPath] };
    case 'typescript': {
      const configuredNode = environment.TERMINAL_TYPESCRIPT_NODE?.trim();
      return { extension: '.ts', command: configuredNode || process.execPath, args: (scriptPath) => ['--experimental-strip-types', scriptPath] };
    }
  }
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-pid, signal);
  } catch (error) {
    if (!isNoSuchProcess(error)) throw error;
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH');
}
