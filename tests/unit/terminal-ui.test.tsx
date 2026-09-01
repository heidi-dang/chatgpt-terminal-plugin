// @vitest-environment jsdom
import { join } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  app: {
    ontoolresult: undefined as ((result: unknown) => Promise<void> | void) | undefined,
    onhostcontextchanged: undefined as ((context: Record<string, unknown>) => void) | undefined,
    onteardown: undefined as (() => Promise<unknown>) | undefined,
    onerror: undefined as ((error: Error) => void) | undefined,
    getHostContext: vi.fn(() => ({ theme: 'dark', platform: 'mobile' })),
    callServerTool: vi.fn(),
  },
  refreshCount: 0,
  terminals: [] as Array<{
    options: Record<string, unknown>;
    writes: string[];
    dispose: ReturnType<typeof vi.fn>;
    cols: number;
    rows: number;
  }>,
}));

vi.mock('@modelcontextprotocol/ext-apps/react', async () => {
  const React = await import('react');
  return {
    useApp: (options: { onAppCreated?: (app: unknown) => void }) => {
      React.useEffect(() => { options.onAppCreated?.(mocks.app); }, []);
      return { app: mocks.app, error: null, isConnected: true };
    },
    useHostStyles: () => undefined,
  };
});

vi.mock('@xterm/xterm', () => ({
  Terminal: class FakeTerminal {
    options: Record<string, unknown>;
    writes: string[] = [];
    dispose = vi.fn();
    cols = 80;
    rows = 24;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      mocks.terminals.push(this);
    }
    loadAddon() {}
    open() {}
    write(text: string) { this.writes.push(text); }
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class FakeFitAddon { fit() {} },
}));

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe() {}
  disconnect() {}
  trigger(): void { this.callback([], this as unknown as ResizeObserver); }
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  close = vi.fn();
  constructor(readonly url: string) { FakeEventSource.instances.push(this); }
  emit(data: unknown): void { this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>); }
  emitError(): void { this.onerror?.(); }
  emitOpen(): void { this.onopen?.(); }
}

let root: Root | undefined;
let frameId = 0;
let frameCallbacks = new Map<number, FrameRequestCallback>();

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="mount"></div>';
  document.head.querySelector('meta[name="terminal-ui-version"]')?.remove();
  mocks.terminals.length = 0;
  mocks.refreshCount = 0;
  FakeEventSource.instances.length = 0;
  FakeResizeObserver.instances.length = 0;
  frameCallbacks = new Map();
  frameId = 0;
  mocks.app.ontoolresult = undefined;
  mocks.app.onhostcontextchanged = undefined;
  mocks.app.onteardown = undefined;
  mocks.app.onerror = undefined;
  mocks.app.getHostContext.mockReturnValue({ theme: 'dark', platform: 'mobile' });
  mocks.app.callServerTool.mockReset();
  mocks.app.callServerTool.mockImplementation(async ({ name }: { name: string }) => {
    if (name === 'terminal_stream_refresh') {
      mocks.refreshCount += 1;
      return {
        structuredContent: { session_id: 'session-1', expires_at: new Date(Date.now() + 60_000).toISOString() },
        content: [],
        _meta: { terminal_stream: { url: `https://terminal.example/events?token=refreshed-${mocks.refreshCount}`, expires_at: new Date(Date.now() + 60_000).toISOString() } },
      };
    }
    if (name === 'terminal_status') {
      return { structuredContent: { session_id: 'session-1', status: 'running', cursor: 8, shell: 'bash', cwd: '/workspace' }, content: [] };
    }
    return { structuredContent: { session_id: 'session-1', status: 'running', cursor: 8 }, content: [] };
  });
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++frameId;
    frameCallbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frameCallbacks.delete(id); });
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function terminalSource(): FakeEventSource {
  const source = FakeEventSource.instances.find((candidate) => candidate.url.includes('/events?token='));
  if (!source) throw new Error('Terminal EventSource was not created.');
  return source;
}

async function flushFrames(): Promise<void> {
  await act(async () => {
    const callbacks = [...frameCallbacks.values()];
    frameCallbacks.clear();
    for (const callback of callbacks) callback(performance.now());
  });
}

async function initializeSession(): Promise<void> {
  await act(async () => {
    await mocks.app.ontoolresult?.({
      structuredContent: {
        session_id: 'session-1', agent_id: 'agent-1', agent_name: 'My computer', cwd: '/workspace', shell: 'bash',
        status: 'running', cursor: 4, initial_output: 'initial\r\n', exit_code: null,
      },
      content: [],
      _meta: { terminal_stream: { url: 'https://terminal.example/events?token=initial', expires_at: new Date(Date.now() + 60_000).toISOString() } },
    });
  });
}

describe('terminal MCP App UI', () => {
  it('renders a watch-only live console and frame-batches real-time SSE output', async () => {
    const { TerminalApp } = await import('../../packages/terminal-ui/src/main.js');
    root = createRoot(document.getElementById('mount')!);
    await act(async () => root?.render(<TerminalApp />));
    await initializeSession();

    expect(mocks.terminals).toHaveLength(1);
    const terminal = mocks.terminals[0]!;
    expect(terminal.options.disableStdin).toBe(true);
    expect(terminal.options.cursorBlink).toBe(false);
    expect(document.querySelectorAll('button')).toHaveLength(0);
    expect(document.body.textContent).toContain('CHATGPT LIVE TERMINAL');
    expect(document.body.textContent).toContain('My computer');
    expect(document.body.textContent).toContain('/workspace');
    expect(terminal.writes).toContain('initial\r\n');

    const source = terminalSource();
    await act(async () => {
      source.emit({ sequence: 5, event_type: 'terminal.stdout', data: { text: 'one\r\n' } });
      source.emit({ sequence: 6, event_type: 'terminal.stdout', data: { text: 'two\r\n' } });
    });
    expect(terminal.writes).not.toContain('one\r\ntwo\r\n');
    await flushFrames();
    expect(terminal.writes).toContain('one\r\ntwo\r\n');

    await act(async () => source.emit({ sequence: 7, event_type: 'process.exit', data: { exit_code: 0 } }));
    expect(document.body.textContent).toContain('EXIT 0');
    expect(source.close).toHaveBeenCalled();
  });

  it('tracks live cwd and drains terminal output before final session.closed', async () => {
    const { TerminalApp } = await import('../../packages/terminal-ui/src/main.js');
    root = createRoot(document.getElementById('mount')!);
    await act(async () => root?.render(<TerminalApp />));
    await initializeSession();
    const terminal = mocks.terminals[0]!;
    const source = terminalSource();

    await act(async () => source.emit({ sequence: 5, event_type: 'cwd.changed', data: { cwd: '/workspace/child' } }));
    expect(document.body.textContent).toContain('/workspace/child');

    await act(async () => {
      await mocks.app.ontoolresult?.({ structuredContent: { session_id: 'session-1', status: 'closing', cursor: 5 }, content: [] });
    });
    expect(source.close).not.toHaveBeenCalled();

    await act(async () => source.emit({ sequence: 6, event_type: 'terminal.stdout', data: { text: 'shutdown-drain\r\n' } }));
    expect(terminal.writes).not.toContain('shutdown-drain\r\n');
    await act(async () => source.emit({ sequence: 7, event_type: 'session.closed', data: { reason: 'explicit_close', exit_code: 0 } }));
    expect(terminal.writes).toContain('shutdown-drain\r\n');
    expect(document.body.textContent).toContain('CLOSED');
    expect(document.body.textContent).toContain('EXIT 0');
    expect(source.close).toHaveBeenCalled();
  });

  it('deduplicates SSE, detects gaps, refreshes capability, and ignores stale sources', async () => {
    const { TerminalApp, classifySequence } = await import('../../packages/terminal-ui/src/main.js');
    expect(classifySequence(5, 5)).toBe('stale');
    expect(classifySequence(5, 6)).toBe('next');
    expect(classifySequence(5, 7)).toBe('gap');
    root = createRoot(document.getElementById('mount')!);
    await act(async () => root?.render(<TerminalApp />));
    await initializeSession();
    const terminal = mocks.terminals[0]!;
    const initial = terminalSource();

    await act(async () => {
      initial.emit({ sequence: 5, event_type: 'terminal.stdout', data: { text: 'once\r\n' } });
      initial.emit({ sequence: 5, event_type: 'terminal.stdout', data: { text: 'duplicate\r\n' } });
    });
    await flushFrames();
    expect(terminal.writes).toContain('once\r\n');
    expect(terminal.writes).not.toContain('duplicate\r\n');

    await act(async () => {
      initial.emit({ sequence: 7, event_type: 'terminal.stdout', data: { text: 'gap\r\n' } });
      await Promise.resolve();
    });
    expect(initial.close).toHaveBeenCalled();
    expect(mocks.app.callServerTool).toHaveBeenCalledWith({ name: 'terminal_stream_refresh', arguments: { session_id: 'session-1', after: 5 } });
    const recovered = FakeEventSource.instances.find((candidate) => candidate.url.includes('refreshed-1'))!;
    expect(recovered).toBeTruthy();

    await act(async () => initial.emit({ sequence: 6, event_type: 'terminal.stdout', data: { text: 'stale-source\r\n' } }));
    await act(async () => recovered.emit({ sequence: 6, event_type: 'terminal.stdout', data: { text: 'recovered\r\n' } }));
    await flushFrames();
    expect(terminal.writes).not.toContain('stale-source\r\n');
    expect(terminal.writes).toContain('recovered\r\n');
  });

  it('debounces iframe resize traffic and stops resize mutations after exit', async () => {
    vi.useFakeTimers();
    const { TerminalApp } = await import('../../packages/terminal-ui/src/main.js');
    root = createRoot(document.getElementById('mount')!);
    await act(async () => root?.render(<TerminalApp />));
    await initializeSession();
    const observer = FakeResizeObserver.instances.at(-1)!;
    observer.trigger();
    observer.trigger();
    await act(async () => vi.advanceTimersByTime(120));
    expect(mocks.app.callServerTool.mock.calls.filter(([request]) => request.name === 'terminal_resize')).toHaveLength(1);

    const source = terminalSource();
    await act(async () => source.emit({ sequence: 5, event_type: 'process.exit', data: { exit_code: 0 } }));
    mocks.terminals[0]!.cols = 100;
    observer.trigger();
    await act(async () => vi.advanceTimersByTime(120));
    expect(mocks.app.callServerTool.mock.calls.filter(([request]) => request.name === 'terminal_resize')).toHaveLength(1);
  });

  it('contains dedicated iPhone responsive breakpoints and no toolbar surface', async () => {
    const css = await import('node:fs/promises').then(({ readFile }) => readFile(join(process.cwd(), 'packages/terminal-ui/src/styles.css'), 'utf8'));
    expect(css).toMatch(/@media\s*\(max-width:\s*560px\)/);
    expect(css).toMatch(/@media\s*\(max-width:\s*390px\)/);
    expect(css).not.toMatch(/terminal-toolbar/);
    expect(css).toMatch(/safe-area-inset-bottom/);
  });
});
