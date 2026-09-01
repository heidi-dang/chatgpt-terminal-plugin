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

type ExecutionTermination = 'cancelled' | 'shutdown';

interface ExecutionState {
  userId: string;
  child?: ChildProcess;
  termination?: ExecutionTermination;
  finished: boolean;
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
  private readonly executions = new Map<string, ExecutionState>();
  private stopped = false;
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

  async execute(userId: string, input: CodeExecuteInput, cwd: string): Promise<CodeExecuteOutput> {
    if (this.stopped) {
      throw new TerminalProtocolError('AGENT_OFFLINE', 'Code executor has been shut down.');
    }
    if (this.executions.has(input.execution_id)) {
      throw new TerminalProtocolError('INVALID_ARGUMENT', 'Execution identifier is already active.');
    }

    const invocation = runtimeInvocation(input.runtime, this.environment);
    const timeoutMs = Math.min(input.timeout_ms ?? this.defaultTimeoutMs, this.maxTimeoutMs);
    const execution: ExecutionState = { userId, finished: false };
    this.executions.set(input.execution_id, execution);
    let tempDir: string | undefined;
    const startedAt = Date.now();

    try {
      tempDir = await mkdtemp(join(tmpdir(), 'chatgpt-terminal-code-'));
      this.throwIfTerminated(execution);
      const scriptPath = join(tempDir, `script${invocation.extension}`);
      await writeFile(scriptPath, input.code, { encoding: 'utf8', mode: 0o700, flag: 'wx' });
      this.throwIfTerminated(execution);
      return await this.runChild(execution, input, cwd, invocation.command, invocation.args(scriptPath), timeoutMs, startedAt);
    } finally {
      try {
        if (tempDir) await rm(tempDir, { recursive: true, force: true });
      } finally {
        if (this.executions.get(input.execution_id) === execution) this.executions.delete(input.execution_id);
      }
    }
  }

  cancel(userId: string, executionId: string): CodeCancelOutput {
    const execution = this.executions.get(executionId);
    if (!execution || execution.finished || execution.termination === 'shutdown') {
      return { execution_id: executionId, cancelled: false };
    }
    if (execution.userId !== userId) {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'Code execution is owned by another user.');
    }
    if (execution.termination !== 'cancelled') {
      execution.termination = 'cancelled';
      this.terminate(execution);
    }
    return { execution_id: executionId, cancelled: true };
  }

  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const execution of this.executions.values()) {
      if (execution.finished) continue;
      execution.termination = 'shutdown';
      this.terminate(execution);
    }
  }

  private runChild(
    execution: ExecutionState,
    input: CodeExecuteInput,
    cwd: string,
    command: string,
    args: string[],
    timeoutMs: number,
    startedAt: number,
  ): Promise<CodeExecuteOutput> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: this.environment,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      execution.child = child;

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
        if (execution.forceKillTimer) clearTimeout(execution.forceKillTimer);
        execution.finished = true;
        if (limitError) {
          reject(limitError);
          return;
        }
        const terminationError = this.terminationError(execution);
        if (terminationError) {
          reject(terminationError);
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
        }
        if (allowed < chunk.length) {
          limitError = new TerminalProtocolError('OUTPUT_LIMIT_REACHED', 'Code execution exceeded the configured output limit.');
          this.terminate(execution);
        }
      };

      child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (execution.forceKillTimer) clearTimeout(execution.forceKillTimer);
        execution.finished = true;
        reject(this.terminationError(execution) ?? new TerminalProtocolError('PTY_CREATE_FAILED', `Failed to start code runtime: ${error.message}`));
      });
      child.once('close', (code) => finish(code));

      const timeout = setTimeout(() => {
        timedOut = true;
        this.terminate(execution);
      }, timeoutMs);
      timeout.unref();
    });
  }

  private throwIfTerminated(execution: ExecutionState): void {
    const error = this.terminationError(execution);
    if (!error) return;
    execution.finished = true;
    throw error;
  }

  private terminationError(execution: ExecutionState): TerminalProtocolError | undefined {
    if (execution.termination === 'cancelled') {
      return new TerminalProtocolError('REQUEST_CANCELLED', 'Code execution was cancelled.');
    }
    if (execution.termination === 'shutdown') {
      return new TerminalProtocolError('AGENT_OFFLINE', 'Code executor shut down before execution completed.', true);
    }
    return undefined;
  }

  private terminate(execution: ExecutionState): void {
    const child = execution.child;
    const pid = child?.pid;
    if (!child || !pid || child.exitCode !== null || child.signalCode !== null) return;
    signalProcessTree(child, 'SIGTERM');
    if (execution.forceKillTimer) clearTimeout(execution.forceKillTimer);
    execution.forceKillTimer = setTimeout(() => signalProcessTree(child, 'SIGKILL'), this.killGraceMs);
    execution.forceKillTimer.unref();
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
