import { execFile } from 'node:child_process';

export interface KillableChild {
  pid?: number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type TaskkillRunner = (args: string[], callback: (error: Error | null) => void) => void;

const runTaskkill: TaskkillRunner = (args, callback) => {
  execFile('taskkill', args, { windowsHide: true }, (error) => callback(error));
};

export function signalProcessTree(
  child: KillableChild,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
  taskkill: TaskkillRunner = runTaskkill,
  killGroup: (pid: number, signal: NodeJS.Signals) => boolean = (pid, requestedSignal) => process.kill(pid, requestedSignal),
): void {
  const pid = child.pid;
  if (!pid) return;

  if (platform !== 'win32') {
    try {
      killGroup(-pid, signal);
    } catch (error) {
      if (!isNoSuchProcess(error)) throw error;
    }
    return;
  }

  const args = signal === 'SIGKILL'
    ? ['/F', '/T', '/PID', String(pid)]
    : ['/T', '/PID', String(pid)];
  const fallback = (): void => {
    try {
      child.kill(signal);
    } catch (error) {
      if (!isNoSuchProcess(error)) {
        console.error(JSON.stringify({ level: 'warn', event: 'agent.windows_process_fallback_failed', pid, error: errorMessage(error) }));
      }
    }
  };

  try {
    taskkill(args, (error) => {
      if (error) fallback();
    });
  } catch {
    fallback();
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
