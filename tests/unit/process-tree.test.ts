import { describe, expect, it, vi } from 'vitest';
import { signalProcessTree, type KillableChild, type TaskkillRunner } from '../../packages/local-agent/src/process-tree.js';

describe('signalProcessTree', () => {
  it('uses graceful Windows tree termination without /F for SIGTERM', () => {
    const child = fakeChild();
    const taskkill = vi.fn<TaskkillRunner>((_args, callback) => callback(null));

    signalProcessTree(child, 'SIGTERM', 'win32', taskkill);

    expect(taskkill).toHaveBeenCalledWith(['/T', '/PID', '4321'], expect.any(Function));
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('uses forced Windows tree termination only for SIGKILL', () => {
    const child = fakeChild();
    const taskkill = vi.fn<TaskkillRunner>((_args, callback) => callback(null));

    signalProcessTree(child, 'SIGKILL', 'win32', taskkill);

    expect(taskkill).toHaveBeenCalledWith(['/F', '/T', '/PID', '4321'], expect.any(Function));
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('falls back to child.kill when taskkill reports an asynchronous error', () => {
    const child = fakeChild();
    const taskkill = vi.fn<TaskkillRunner>((_args, callback) => callback(new Error('taskkill failed')));

    signalProcessTree(child, 'SIGTERM', 'win32', taskkill);

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('falls back to child.kill when launching taskkill throws synchronously', () => {
    const child = fakeChild();
    const taskkill: TaskkillRunner = () => { throw new Error('spawn failed'); };

    signalProcessTree(child, 'SIGKILL', 'win32', taskkill);

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('preserves process-group signaling on non-Windows platforms', () => {
    const child = fakeChild();
    const killGroup = vi.fn(() => true);

    signalProcessTree(child, 'SIGTERM', 'linux', undefined, killGroup);

    expect(killGroup).toHaveBeenCalledWith(-4321, 'SIGTERM');
    expect(child.kill).not.toHaveBeenCalled();
  });
});

function fakeChild(): KillableChild & { kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals | number) => boolean>> } {
  return { pid: 4321, kill: vi.fn(() => true) };
}
