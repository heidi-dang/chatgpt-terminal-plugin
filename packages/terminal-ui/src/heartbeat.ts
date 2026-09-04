export type HeartbeatMode = 'acquiring' | 'recovering' | 'healthy';

export interface HeartbeatDocument {
  hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface HeartbeatClock {
  setTimeout(handler: () => void, timeout?: number): number;
  clearTimeout(handle: number): void;
}

export const HEARTBEAT_FAST_INTERVAL_MS = 1_000;
export const HEARTBEAT_HEALTHY_INTERVAL_MS = 10_000;

export class AdaptiveHeartbeat {
  private active = false;
  private mode: HeartbeatMode = 'acquiring';
  private timer: number | undefined;
  private running = false;

  constructor(
    private readonly run: () => Promise<void> | void,
    private readonly doc: HeartbeatDocument = document,
    private readonly clock: HeartbeatClock = window,
  ) {}

  start(mode: HeartbeatMode = 'acquiring'): void {
    if (this.active) {
      this.setMode(mode);
      return;
    }
    this.active = true;
    this.mode = mode;
    this.doc.addEventListener('visibilitychange', this.handleVisibility);
    this.schedule(0);
  }

  stop(): void {
    this.active = false;
    this.running = false;
    this.clearTimer();
    this.doc.removeEventListener('visibilitychange', this.handleVisibility);
  }

  setMode(mode: HeartbeatMode): void {
    this.mode = mode;
    if (this.active && !this.doc.hidden && !this.running) {
      this.clearTimer();
      this.schedule(this.intervalFor(mode));
    }
  }

  poke(): void {
    if (!this.active || this.doc.hidden || this.running) return;
    this.clearTimer();
    this.schedule(0);
  }

  private readonly handleVisibility = (): void => {
    if (!this.active) return;
    if (this.doc.hidden) {
      this.clearTimer();
      return;
    }
    this.poke();
  };

  private schedule(delay: number): void {
    if (!this.active || this.doc.hidden || this.timer !== undefined) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      if (!this.active || this.doc.hidden || this.running) return;
      this.running = true;
      void Promise.resolve(this.run()).finally(() => {
        this.running = false;
        if (this.active && !this.doc.hidden) this.schedule(this.intervalFor(this.mode));
      });
    }, delay);
  }

  private intervalFor(mode: HeartbeatMode): number {
    return mode === 'healthy' ? HEARTBEAT_HEALTHY_INTERVAL_MS : HEARTBEAT_FAST_INTERVAL_MS;
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }
}