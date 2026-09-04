import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AdaptiveHeartbeat,
  HEARTBEAT_FAST_INTERVAL_MS,
  HEARTBEAT_HEALTHY_INTERVAL_MS,
  type HeartbeatDocument,
} from '../../packages/terminal-ui/src/heartbeat.js';

class FakeDocument implements HeartbeatDocument {
  hidden = false;
  private listener: (() => void) | undefined;

  addEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listener = listener;
  }

  removeEventListener(): void {
    this.listener = undefined;
  }

  setVisibility(hidden: boolean): void {
    this.hidden = hidden;
    this.listener?.();
  }
}

describe('adaptive terminal surface heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls immediately, quickly during recovery, and slowly while healthy', async () => {
    vi.useFakeTimers();
    const doc = new FakeDocument();
    const poll = vi.fn();
    const heartbeat = new AdaptiveHeartbeat(poll, doc, timerClock());

    heartbeat.start('acquiring');
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_FAST_INTERVAL_MS);
    expect(poll).toHaveBeenCalledTimes(2);

    heartbeat.setMode('healthy');
    await vi.advanceTimersByTimeAsync(HEARTBEAT_HEALTHY_INTERVAL_MS - 1);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(3);
    heartbeat.stop();
  });

  it('suspends hidden-page polling and resynchronizes immediately on visibility', async () => {
    vi.useFakeTimers();
    const doc = new FakeDocument();
    const poll = vi.fn();
    const heartbeat = new AdaptiveHeartbeat(poll, doc, timerClock());

    heartbeat.start('healthy');
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);

    doc.setVisibility(true);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_HEALTHY_INTERVAL_MS * 2);
    expect(poll).toHaveBeenCalledTimes(1);

    doc.setVisibility(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(2);
    heartbeat.stop();
  });

  it('does not overlap a slow surface poll with a second heartbeat', async () => {
    vi.useFakeTimers();
    const doc = new FakeDocument();
    let resolvePoll: (() => void) | undefined;
    const poll = vi.fn(() => new Promise<void>((resolve) => { resolvePoll = resolve; }));
    const heartbeat = new AdaptiveHeartbeat(poll, doc, timerClock());

    heartbeat.start('acquiring');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_FAST_INTERVAL_MS * 2);
    expect(poll).toHaveBeenCalledTimes(1);

    resolvePoll?.();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_FAST_INTERVAL_MS);
    expect(poll).toHaveBeenCalledTimes(2);
    heartbeat.stop();
  });
});

function timerClock() {
  return {
    setTimeout: (handler: () => void, timeout?: number) => setTimeout(handler, timeout) as unknown as number,
    clearTimeout: (handle: number) => clearTimeout(handle),
  };
}