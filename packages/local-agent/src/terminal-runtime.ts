import { readdirSync, readFileSync } from 'node:fs';
import * as pty from 'node-pty';

export interface TerminalSpawnOptions {
  shell: string;
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  name: string;
}

export interface TerminalExit {
  exitCode: number;
  signal?: number;
}

export interface TerminalDisposable {
  dispose(): void;
}

export interface TerminalProcess {
  readonly pid: number;
  write(text: string): void;
  resize(cols: number, rows: number): void;
  interrupt(): void;
  terminate(): void;
  forceKill(): void;
  onData(listener: (text: string) => void): TerminalDisposable;
  onExit(listener: (event: TerminalExit) => void): TerminalDisposable;
}

export interface TerminalRuntimeMetrics {
  pty_create_total: number;
  pty_create_failed_total: number;
  active_ptys: number;
  graceful_terminate_total: number;
  force_kill_total: number;
  termination_escalation_total: number;
  tree_signal_fallback_total: number;
}

export interface TerminalRuntime {
  spawn(options: TerminalSpawnOptions): TerminalProcess;
  metrics(): TerminalRuntimeMetrics;
}

export interface NodePtyTerminalRuntimeOptions {
  terminationGraceMs?: number;
  spawnPty?: (
    file: string,
    args: string[] | string,
    options: pty.IPtyForkOptions | pty.IWindowsPtyForkOptions,
  ) => pty.IPty;
  platform?: NodeJS.Platform;
}

interface LinuxProcessInfo {
  pid: number;
  ppid: number;
  pgrp: number;
  session: number;
  startTime: string;
}

class MutableRuntimeMetrics implements TerminalRuntimeMetrics {
  pty_create_total = 0;
  pty_create_failed_total = 0;
  active_ptys = 0;
  graceful_terminate_total = 0;
  force_kill_total = 0;
  termination_escalation_total = 0;
  tree_signal_fallback_total = 0;

  snapshot(): TerminalRuntimeMetrics {
    return {
      pty_create_total: this.pty_create_total,
      pty_create_failed_total: this.pty_create_failed_total,
      active_ptys: this.active_ptys,
      graceful_terminate_total: this.graceful_terminate_total,
      force_kill_total: this.force_kill_total,
      termination_escalation_total: this.termination_escalation_total,
      tree_signal_fallback_total: this.tree_signal_fallback_total,
    };
  }
}

export class NodePtyTerminalRuntime implements TerminalRuntime {
  private readonly terminationGraceMs: number;
  private readonly spawnPty: NonNullable<NodePtyTerminalRuntimeOptions['spawnPty']>;
  private readonly platform: NodeJS.Platform;
  private readonly runtimeMetrics = new MutableRuntimeMetrics();

  constructor(options: NodePtyTerminalRuntimeOptions = {}) {
    this.terminationGraceMs = options.terminationGraceMs ?? 750;
    this.spawnPty = options.spawnPty ?? pty.spawn;
    this.platform = options.platform ?? process.platform;
  }

  spawn(options: TerminalSpawnOptions): TerminalProcess {
    this.runtimeMetrics.pty_create_total += 1;
    let raw: pty.IPty;
    try {
      raw = this.spawnPty(options.shell, [], {
        name: options.name,
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env: options.env,
      });
    } catch (error) {
      this.runtimeMetrics.pty_create_failed_total += 1;
      throw error;
    }

    this.runtimeMetrics.active_ptys += 1;
    return new NodePtyTerminalProcess(
      raw,
      this.platform,
      this.terminationGraceMs,
      this.runtimeMetrics,
    );
  }

  metrics(): TerminalRuntimeMetrics {
    return this.runtimeMetrics.snapshot();
  }
}

class NodePtyTerminalProcess implements TerminalProcess {
  private readonly knownTargets = new Map<number, string>();
  private readonly exitSubscription: pty.IDisposable;
  private forceTimer: NodeJS.Timeout | undefined;
  private exited = false;
  private terminateRequested = false;

  constructor(
    private readonly raw: pty.IPty,
    private readonly platform: NodeJS.Platform,
    private readonly terminationGraceMs: number,
    private readonly runtimeMetrics: MutableRuntimeMetrics,
  ) {
    this.exitSubscription = raw.onExit(() => {
      if (this.exited) return;
      this.exited = true;
      if (!this.terminateRequested && this.forceTimer) {
        clearTimeout(this.forceTimer);
        this.forceTimer = undefined;
      }
      this.runtimeMetrics.active_ptys = Math.max(0, this.runtimeMetrics.active_ptys - 1);
      this.exitSubscription.dispose();
    });
  }

  get pid(): number {
    return this.raw.pid;
  }

  write(text: string): void {
    this.raw.write(text);
  }

  resize(cols: number, rows: number): void {
    this.raw.resize(cols, rows);
  }

  interrupt(): void {
    // Ctrl+C is intentionally written through the PTY. The terminal driver then
    // delivers SIGINT to the current foreground process group, which is more
    // correct for interactive shells than signalling only the shell PID.
    this.raw.write('\u0003');
  }

  terminate(): void {
    if (this.exited || this.terminateRequested) return;
    this.terminateRequested = true;
    this.runtimeMetrics.graceful_terminate_total += 1;
    this.signalTree('SIGTERM');
    if (this.exited && !this.hasTrackedLiveTargets()) return;

    this.forceTimer = setTimeout(() => {
      this.forceTimer = undefined;
      if (this.exited && !this.hasTrackedLiveTargets()) return;
      this.runtimeMetrics.termination_escalation_total += 1;
      this.forceKill();
    }, this.terminationGraceMs);
    this.forceTimer.unref();
  }

  forceKill(): void {
    if (this.exited && !this.hasTrackedLiveTargets()) return;
    this.runtimeMetrics.force_kill_total += 1;
    this.signalTree('SIGKILL');
  }

  onData(listener: (text: string) => void): TerminalDisposable {
    return this.raw.onData(listener);
  }

  onExit(listener: (event: TerminalExit) => void): TerminalDisposable {
    return this.raw.onExit(listener);
  }

  private hasTrackedLiveTargets(): boolean {
    if (this.platform !== 'linux' || this.knownTargets.size === 0) return false;
    const live = new Map(readLinuxProcessSnapshot().map((item) => [item.pid, item.startTime]));
    for (const [pid, startTime] of this.knownTargets) {
      if (live.get(pid) === startTime) return true;
    }
    return false;
  }

  private signalTree(signal: NodeJS.Signals): void {
    if (this.platform === 'win32') {
      this.raw.kill();
      return;
    }

    if (this.platform === 'linux') {
      const snapshot = readLinuxProcessSnapshot();
      const targets = collectLinuxTreeTargets(this.pid, snapshot, this.knownTargets);
      for (const target of targets) this.knownTargets.set(target.pid, target.startTime);
      if (signalLinuxTargets(targets, signal)) return;
      this.runtimeMetrics.tree_signal_fallback_total += 1;
    }

    // forkpty children are normally process-group/session leaders on Unix.
    // Signal the process group first; if it has already disappeared or the
    // platform does not expose that group as expected, fall back to node-pty.
    try {
      process.kill(-this.pid, signal);
      return;
    } catch (error) {
      if (!isMissingProcess(error)) this.runtimeMetrics.tree_signal_fallback_total += 1;
    }

    try {
      this.raw.kill(signal);
    } catch (error) {
      if (!isMissingProcess(error)) throw error;
    }
  }
}

function readLinuxProcessSnapshot(): LinuxProcessInfo[] {
  const processes: LinuxProcessInfo[] = [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return processes;
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const closeParen = stat.lastIndexOf(')');
      if (closeParen < 0) continue;
      const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
      const ppid = Number(fields[1]);
      const pgrp = Number(fields[2]);
      const session = Number(fields[3]);
      const startTime = fields[19];
      if (!Number.isInteger(ppid) || !Number.isInteger(pgrp) || !Number.isInteger(session) || !startTime) continue;
      processes.push({ pid, ppid, pgrp, session, startTime });
    } catch {
      // Processes can exit between reading /proc and opening stat. Ignore them.
    }
  }
  return processes;
}

function collectLinuxTreeTargets(
  rootPid: number,
  snapshot: LinuxProcessInfo[],
  knownTargets: ReadonlyMap<number, string>,
): LinuxProcessInfo[] {
  const byPid = new Map(snapshot.map((item) => [item.pid, item]));
  const selected = new Set<number>([rootPid]);

  // A PTY shell is a session leader. Include every process still in that
  // terminal session, including background jobs with their own process groups.
  for (const item of snapshot) {
    if (item.session === rootPid) selected.add(item.pid);
  }

  // Include descendants even if they called setsid() and left the PTY session.
  // Build this closure before signalling so children cannot be orphaned first.
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of snapshot) {
      if (!selected.has(item.pid) && selected.has(item.ppid)) {
        selected.add(item.pid);
        changed = true;
      }
    }
  }

  // During forced escalation retain only PIDs whose Linux start-time still
  // matches, preventing an exited child's recycled PID from being killed.
  for (const [pid, startTime] of knownTargets) {
    const item = byPid.get(pid);
    if (item?.startTime === startTime) selected.add(pid);
  }

  return [...selected]
    .map((pid) => byPid.get(pid))
    .filter((item): item is LinuxProcessInfo => Boolean(item));
}

function signalLinuxTargets(targets: LinuxProcessInfo[], signal: NodeJS.Signals): boolean {
  if (targets.length === 0) return false;
  const groups = new Set(
    targets
      .filter((item) => item.pgrp > 1)
      .map((item) => item.pgrp),
  );
  let signalled = false;

  // Process groups are contained within a session, so this reaches foreground
  // and background jobs without relying on one shell PID.
  for (const group of groups) {
    try {
      process.kill(-group, signal);
      signalled = true;
    } catch (error) {
      if (!isMissingProcess(error)) throw error;
    }
  }

  // Cover unusual targets that have no usable group and descendants that may
  // have moved groups between /proc sampling and signalling.
  for (const target of targets) {
    if (target.pid <= 1) continue;
    if (groups.has(target.pgrp)) continue;
    try {
      process.kill(target.pid, signal);
      signalled = true;
    } catch (error) {
      if (!isMissingProcess(error)) throw error;
    }
  }
  return signalled;
}

function isMissingProcess(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === 'object'
      && 'code' in error
      && (error.code === 'ESRCH' || error.code === 'ENOENT'),
  );
}
