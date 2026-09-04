import { AdaptiveHeartbeat, type HeartbeatMode } from './heartbeat.js';
import {
  isFinalStatus,
  mergeViewState,
  parseStreamMeta,
  parseSurfaceId,
  parseSurfaceState,
  parseViewState,
  type CallToolResult,
  type StreamState,
  type TerminalViewState,
} from './protocol.js';
import { TerminalOutputRenderer } from './text.js';
import { TerminalStreamController, type StreamControllerHost, type TransportMode } from './stream-controller.js';
import type { TerminalAppBridge } from './bridge.js';

const MAX_OUTPUT_CHARS = 600_000;
const OUTPUT_TRIM_TARGET = 450_000;
const MOBILE_MAX_OUTPUT_CHARS = 220_000;
const MOBILE_OUTPUT_TRIM_TARGET = 160_000;

const CONNECTION_LABELS: Record<StreamState, string> = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
  failed: 'Connection failed',
};

export class TerminalViewer implements StreamControllerHost {
  private viewState: TerminalViewState | null = null;
  private streamState: StreamState = 'connecting';
  private transportMode: TransportMode = 'sse';
  private cursor = 0;
  private outputFrame: number | undefined;
  private outputQueue = '';
  private hasLiveOutput = false;
  private surfaceId: string | undefined;
  private surfacePollInFlight = false;
  private bridgeReady = false;
  private followLive = true;
  private pendingOutputCount = 0;

  private readonly shell: HTMLElement;
  private readonly machine: HTMLElement;
  private readonly status: HTMLElement;
  private readonly path: HTMLElement;
  private readonly output: HTMLElement;
  private readonly footerShell: HTMLElement;
  private readonly footerStream: HTMLElement;
  private readonly exit: HTMLElement;
  private readonly jumpToLive: HTMLButtonElement;
  private readonly announcement: HTMLElement;
  private readonly outputRenderer: TerminalOutputRenderer;
  private readonly stream: TerminalStreamController;
  private readonly heartbeat: AdaptiveHeartbeat;

  constructor(
    private readonly app: TerminalAppBridge,
    private readonly doc: Document = document,
  ) {
    this.shell = requireElement(doc, 'terminal-shell');
    this.machine = requireElement(doc, 'terminal-machine');
    this.status = requireElement(doc, 'terminal-status');
    this.path = requireElement(doc, 'terminal-path');
    this.output = requireElement(doc, 'terminal-output');
    this.footerShell = requireElement(doc, 'terminal-shell-name');
    this.footerStream = requireElement(doc, 'terminal-stream-state');
    this.exit = requireElement(doc, 'terminal-exit');
    this.jumpToLive = ensureElement(doc, 'terminal-jump-to-live', 'button', 'terminal-jump-to-live') as HTMLButtonElement;
    this.jumpToLive.type = 'button';
    this.jumpToLive.setAttribute('aria-controls', 'terminal-output');
    this.jumpToLive.textContent ||= 'Jump to live';
    this.announcement = ensureElement(doc, 'terminal-live-announcement', 'div', 'terminal-live-announcement');
    this.outputRenderer = new TerminalOutputRenderer(this.output);
    this.stream = new TerminalStreamController(app, this);
    this.heartbeat = new AdaptiveHeartbeat(() => this.pollSurface(), doc, doc.defaultView ?? window);
  }

  bind(): void {
    this.app.ontoolresult = (result) => this.applyToolResult(result);
    this.app.onhostcontextchanged = (context) => {
      const theme = context.theme;
      if (typeof theme === 'string') this.doc.documentElement.dataset.theme = theme;
    };
    this.app.onteardown = async () => {
      const surfaceId = this.surfaceId;
      try {
        if (surfaceId) await this.app.callServerTool({ name: 'terminal_turn_close', arguments: { surface_id: surfaceId } });
      } catch (error) {
        console.error('[terminal-app] terminal teardown cleanup failed', error);
      } finally {
        this.destroy();
      }
      return {};
    };
    this.app.onerror = (error) => {
      console.error('[terminal-app]', error);
      this.showBridgeFailure(error);
    };
    this.output.addEventListener('scroll', this.handleScroll);
    this.jumpToLive.addEventListener('click', this.handleJumpToLive);
    this.updateJumpControl();
  }

  markBridgeReady(): void {
    this.bridgeReady = true;
    this.shell.dataset.bridge = 'ready';
    if (this.surfaceId) this.startSurfaceSync();
  }

  showBridgeFailure(error: unknown): void {
    this.streamState = 'failed';
    this.shell.dataset.bridge = 'failed';
    this.renderState();
    this.queueOutput(`\n[Terminal UI bridge failed: ${errorMessage(error)}]\n`);
  }

  applyToolResult(result: CallToolResult): void {
    const surface = parseSurfaceState(result);
    const resultSurfaceId = surface?.surface_id ?? parseSurfaceId(result);
    if (!this.surfaceId && resultSurfaceId) {
      this.surfaceId = resultSurfaceId;
      if (this.bridgeReady) this.startSurfaceSync();
    }
    if (resultSurfaceId && this.surfaceId && resultSurfaceId !== this.surfaceId) return;
    if (surface && !surface.surface_open) {
      this.stopSurfaceSync();
      this.stream.finish();
      this.viewState = null;
      this.machine.textContent = 'Terminal turn complete';
      this.path.textContent = 'A fresh terminal will open on the next prompt.';
      this.path.title = '';
      this.renderState();
      return;
    }

    const next = parseViewState(result);
    let sessionChanged = false;
    if (next) {
      const previousSession = this.viewState?.session_id;
      const canSwitch = previousSession === undefined || previousSession === next.session_id || (Boolean(resultSurfaceId) && resultSurfaceId === this.surfaceId);
      if (!canSwitch) return;
      this.viewState = mergeViewState(this.viewState, next);
      if (previousSession !== next.session_id) {
        sessionChanged = true;
        this.stream.reset(next.cursor);
        this.cursor = next.cursor;
        this.hasLiveOutput = false;
        this.outputRenderer.reset();
        this.followLive = true;
        this.pendingOutputCount = 0;
        if (next.initial_output) this.queueOutput(next.initial_output);
      }
      this.renderState();
    }

    const meta = parseStreamMeta(result);
    if (meta && (sessionChanged || this.streamState !== 'live')) this.stream.start(meta);
    if (this.viewState && isFinalStatus(this.viewState.status)) this.stream.finish();
    this.updateHeartbeatMode();
  }

  destroy(): void {
    this.stopSurfaceSync();
    this.stream.destroy();
    this.surfaceId = undefined;
    this.flushOutput();
    this.output.removeEventListener('scroll', this.handleScroll);
    this.jumpToLive.removeEventListener('click', this.handleJumpToLive);
  }

  getViewState(): TerminalViewState | null {
    return this.viewState;
  }

  getCursor(): number {
    return this.cursor;
  }

  setCursor(cursor: number): void {
    this.cursor = cursor;
  }

  updateViewState(state: TerminalViewState): void {
    this.viewState = state;
  }

  patchViewState(patch: Partial<TerminalViewState>): void {
    if (this.viewState) this.viewState = { ...this.viewState, ...patch };
  }

  queueOutput(text: string): void {
    if (!text) return;
    this.outputQueue += text;
    if (this.outputFrame !== undefined) return;
    this.outputFrame = window.requestAnimationFrame?.(() => {
      this.outputFrame = undefined;
      this.flushOutput();
    }) ?? window.setTimeout(() => {
      this.outputFrame = undefined;
      this.flushOutput();
    }, 0);
  }

  flushOutput(): void {
    if (this.outputFrame !== undefined) {
      window.cancelAnimationFrame(this.outputFrame);
      window.clearTimeout(this.outputFrame);
      this.outputFrame = undefined;
    }
    if (!this.outputQueue) return;
    const wasFollowing = this.isNearTail();
    this.followLive = wasFollowing;
    this.outputRenderer.append(this.outputQueue, true);
    this.outputQueue = '';
    this.hasLiveOutput = true;
    this.trimOutput();
    if (wasFollowing) {
      this.output.scrollTop = this.output.scrollHeight;
    } else {
      this.pendingOutputCount += 1;
    }
    this.updateJumpControl();
  }

  renderState(): void {
    const current = this.viewState;
    const displayState = isFinalStatus(current?.status) ? current?.status ?? 'offline' : this.streamState;
    this.shell.dataset.state = displayState;
    this.machine.textContent = current?.agent_name ?? current?.agent_id ?? 'Connecting to computer';
    this.status.dataset.state = displayState;
    this.status.title = this.transportDiagnostic();
    const statusLabel = this.status.querySelector<HTMLElement>('[data-terminal-status-label]') ?? this.status.lastElementChild;
    if (statusLabel) statusLabel.textContent = this.userFacingState(displayState);
    this.path.textContent = current?.cwd ?? 'Waiting for terminal session…';
    this.path.title = current?.cwd ?? '';
    this.footerShell.textContent = current?.shell ?? 'shell';
    this.footerStream.textContent = `${this.transportMode.toUpperCase()} ${this.streamState.toUpperCase()}`;
    this.footerStream.title = this.transportDiagnostic();
    if (current?.exit_code == null) {
      this.exit.hidden = true;
      this.exit.textContent = '';
      delete this.exit.dataset.success;
    } else {
      this.exit.hidden = false;
      this.exit.textContent = `EXIT ${current.exit_code}`;
      this.exit.dataset.success = current.exit_code === 0 ? 'true' : 'false';
    }
    this.updateHeartbeatMode();
  }

  setTransportState(mode: TransportMode, state: StreamState): void {
    this.transportMode = mode;
    this.streamState = state;
    this.renderState();
  }

  private startSurfaceSync(): void {
    if (!this.surfaceId) return;
    this.heartbeat.start(this.heartbeatMode());
  }

  private stopSurfaceSync(): void {
    this.heartbeat.stop();
    this.surfacePollInFlight = false;
  }

  private async pollSurface(): Promise<void> {
    const surfaceId = this.surfaceId;
    if (!surfaceId || this.surfacePollInFlight) return;
    this.surfacePollInFlight = true;
    try {
      const previousSession = this.viewState?.session_id;
      const result = await this.callTool('terminal_surface_status', { surface_id: surfaceId, session_id: previousSession ?? null });
      const surface = parseSurfaceState(result);
      if (!result.isError && this.surfaceId === surfaceId && surface?.surface_id === surfaceId) {
        this.applyToolResult(result);
        if (surface.session_id && surface.session_id !== previousSession) this.stream.requestRefresh(false);
      }
    } catch (error) {
      console.error('[terminal-app] surface sync failed', error);
    } finally {
      this.surfacePollInFlight = false;
      this.updateHeartbeatMode();
    }
  }

  private readonly handleScroll = (): void => {
    const nearTail = this.isNearTail();
    this.followLive = nearTail;
    if (nearTail) this.pendingOutputCount = 0;
    this.updateJumpControl();
  };

  private readonly handleJumpToLive = (): void => {
    this.followLive = true;
    this.pendingOutputCount = 0;
    this.output.scrollTop = this.output.scrollHeight;
    this.announcement.textContent = 'Live terminal output resumed.';
    this.updateJumpControl();
    this.output.focus({ preventScroll: true });
  };

  private isNearTail(): boolean {
    return this.output.scrollHeight - this.output.scrollTop - this.output.clientHeight < 24;
  }

  private updateJumpControl(): void {
    const show = !this.followLive;
    this.jumpToLive.hidden = !show;
    const count = this.pendingOutputCount;
    this.jumpToLive.textContent = count > 0 ? `New output (${count}) · Jump to live` : 'Jump to live';
    this.jumpToLive.setAttribute('aria-label', count > 0 ? `${count} new terminal output updates. Jump to live.` : 'Jump to live terminal output.');
    if (count > 0) this.announcement.textContent = `${count} new terminal output update${count === 1 ? '' : 's'} available.`;
  }

  private trimOutput(): void {
    const narrowViewport = this.doc.defaultView?.matchMedia?.('(max-width: 560px)').matches ?? false;
    const maxOutputChars = narrowViewport ? MOBILE_MAX_OUTPUT_CHARS : MAX_OUTPUT_CHARS;
    if (this.outputRenderer.textLength <= maxOutputChars) return;
    this.outputRenderer.trim(narrowViewport ? MOBILE_OUTPUT_TRIM_TARGET : OUTPUT_TRIM_TARGET, narrowViewport ? 'mobile' : 'memory');
  }

  private heartbeatMode(): HeartbeatMode {
    if (!this.viewState) return 'acquiring';
    return this.streamState === 'live' ? 'healthy' : 'recovering';
  }

  private updateHeartbeatMode(): void {
    if (this.surfaceId) this.heartbeat.setMode(this.heartbeatMode());
  }

  private userFacingState(state: string): string {
    if (state in CONNECTION_LABELS) return CONNECTION_LABELS[state as StreamState];
    if (state === 'exited') return 'Exited';
    if (state === 'closed') return 'Closed';
    return state.replaceAll('_', ' ');
  }

  private transportDiagnostic(): string {
    return `${this.transportMode.toUpperCase()} transport · ${this.streamState.toUpperCase()} connection`;
  }

  private callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return this.app.callServerTool({ name, arguments: args });
  }
}

function requireElement(doc: Document, id: string): HTMLElement {
  const element = doc.getElementById(id);
  if (!element) throw new Error(`Terminal UI element #${id} is missing.`);
  return element;
}

function ensureElement(doc: Document, id: string, tag: string, className: string): HTMLElement {
  const existing = doc.getElementById(id);
  if (existing) return existing;
  const element = doc.createElement(tag);
  element.id = id;
  element.className = className;
  const frame = doc.querySelector('.terminal-frame') ?? doc.body;
  frame.appendChild(element);
  return element;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}