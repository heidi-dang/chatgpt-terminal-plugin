// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChatGptMcpBridge,
  TerminalViewer,
  appendRichTerminalText,
  classifySequence,
  highlightTerminalText,
  normalizeTerminalText,
  type CallToolResult,
  type TerminalAppBridge,
} from '../../packages/terminal-ui/src/main.js';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  emit(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }

  emitOpen(): void {
    this.onopen?.();
  }

  emitError(): void {
    this.onerror?.();
  }
}

class FakeResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(readonly callback: ResizeObserverCallback) {}
}

function fixture(): void {
  document.head.innerHTML = '';
  document.body.innerHTML = `
    <main id="terminal-shell" data-terminal-static-shell data-state="connecting">
      <span id="terminal-machine">Connecting to computer</span>
      <span id="terminal-status" data-state="connecting"><span></span><span>CONNECTING</span></span>
      <div id="terminal-path">Waiting for terminal session…</div>
      <pre id="terminal-output">Terminal UI ready.\nWaiting for terminal stream…</pre>
      <span id="terminal-shell-name">shell</span>
      <span id="terminal-stream-state">SSE CONNECTING</span>
      <span id="terminal-exit" hidden></span>
    </main>`;
}

function createFakeApp(): TerminalAppBridge & { callServerTool: ReturnType<typeof vi.fn> } {
  const app = {
    ontoolresult: undefined as ((result: CallToolResult) => void) | undefined,
    onhostcontextchanged: undefined as ((context: Record<string, unknown>) => void) | undefined,
    onteardown: undefined as (() => Promise<Record<string, never>>) | undefined,
    onerror: undefined as ((error: Error) => void) | undefined,
    callServerTool: vi.fn(async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
      if (name === 'terminal_stream_refresh') {
        return {
          structuredContent: { session_id: 'session-1', status: 'running', cursor: 5 },
          _meta: {
            terminal_stream: {
              url: 'https://terminal.example/events?token=refreshed',
              expires_at: new Date(Date.now() + 60_000).toISOString(),
            },
          },
        };
      }
      if (name === 'terminal_status') {
        return { structuredContent: { session_id: 'session-1', status: 'running', cursor: 8, cwd: '/workspace', shell: 'bash' } };
      }
      if (name === 'terminal_read') {
        return {
          structuredContent: {
            output: 'fallback\r\n',
            events: [
              { sequence: 5, event_type: 'terminal.stdout', data: { text: 'fallback\r\n' } },
              { sequence: 6, event_type: 'process.exit', data: { exit_code: 0 } },
            ],
            next_cursor: 6,
            has_more: false,
            status: 'exited',
            exit_code: 0,
          },
        };
      }
      return { structuredContent: {} };
    }),
  };
  return app;
}

function initialResult() {
  return {
    structuredContent: {
      session_id: 'session-1',
      agent_id: 'agent-1',
      agent_name: 'My computer',
      cwd: '/workspace',
      shell: 'bash',
      status: 'running',
      cursor: 4,
      initial_output: '\u001b[32minitial\u001b[0m\r\n',
      exit_code: null,
    },
    _meta: {
      terminal_stream: {
        url: 'https://terminal.example/events?token=initial',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    },
  };
}

let frameId = 0;
let frames = new Map<number, FrameRequestCallback>();

async function flushFrames(): Promise<void> {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(performance.now());
  await Promise.resolve();
}

function terminalSource(token = 'initial'): FakeEventSource {
  const source = FakeEventSource.instances.find((candidate) => candidate.url.includes(`token=${token}`));
  if (!source) throw new Error(`Terminal source ${token} was not created.`);
  return source;
}

beforeEach(() => {
  fixture();
  FakeEventSource.instances.length = 0;
  frameId = 0;
  frames = new Map();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++frameId;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('terminal MCP App UI', () => {
  it('renders live SSE output into the static shell with one paint per frame', async () => {
    const app = createFakeApp();
    const viewer = new TerminalViewer(app);
    viewer.bind();
    app.ontoolresult?.(initialResult());
    await flushFrames();

    expect(document.body.textContent).toContain('My computer');
    expect(document.body.textContent).toContain('/workspace');
    expect(document.getElementById('terminal-output')?.textContent).toContain('initial\n');

    const source = terminalSource();
    source.emitOpen();
    source.emit({ sequence: 5, event_type: 'terminal.stdout', data: { text: '\u001b[31mone\u001b[0m\r\n' } });
    source.emit({ sequence: 6, event_type: 'terminal.stderr', data: { text: 'two\r\n' } });
    expect(document.getElementById('terminal-output')?.textContent).not.toContain('one\ntwo\n');
    await flushFrames();
    expect(document.getElementById('terminal-output')?.textContent).toContain('one\ntwo\n');
    expect(document.getElementById('terminal-stream-state')?.textContent).toBe('SSE LIVE');

    source.emit({ sequence: 7, event_type: 'process.exit', data: { exit_code: 0 } });
    expect(document.getElementById('terminal-shell')?.dataset.state).toBe('exited');
    expect(document.getElementById('terminal-exit')?.textContent).toBe('EXIT 0');
    expect(source.close).toHaveBeenCalled();
  });

  it('tracks cwd, drains queued output, and closes only on the final lifecycle event', async () => {
    const app = createFakeApp();
    const viewer = new TerminalViewer(app);
    viewer.bind();
    app.ontoolresult?.(initialResult());
    await flushFrames();
    const source = terminalSource();

    source.emit({ sequence: 5, event_type: 'cwd.changed', data: { cwd: '/workspace/child' } });
    expect(document.getElementById('terminal-path')?.textContent).toBe('/workspace/child');

    app.ontoolresult?.({ structuredContent: { session_id: 'session-1', status: 'closing', cursor: 5 } });
    expect(source.close).not.toHaveBeenCalled();
    source.emit({ sequence: 6, event_type: 'terminal.stdout', data: { text: 'shutdown-drain\r\n' } });
    expect(document.getElementById('terminal-output')?.textContent).not.toContain('shutdown-drain');
    source.emit({ sequence: 7, event_type: 'session.closed', data: { exit_code: 0 } });
    expect(document.getElementById('terminal-output')?.textContent).toContain('shutdown-drain\n');
    expect(document.getElementById('terminal-shell')?.dataset.state).toBe('closed');
    expect(source.close).toHaveBeenCalled();
  });

  it('deduplicates events and refreshes the stream on a forward sequence gap', async () => {
    expect(classifySequence(5, 5)).toBe('stale');
    expect(classifySequence(5, 6)).toBe('next');
    expect(classifySequence(5, 7)).toBe('gap');

    const app = createFakeApp();
    const viewer = new TerminalViewer(app);
    viewer.bind();
    app.ontoolresult?.(initialResult());
    await flushFrames();
    const initial = terminalSource();

    initial.emit({ sequence: 5, event_type: 'terminal.stdout', data: { text: 'once\r\n' } });
    initial.emit({ sequence: 5, event_type: 'terminal.stdout', data: { text: 'duplicate\r\n' } });
    await flushFrames();
    expect(document.getElementById('terminal-output')?.textContent).toContain('once\n');
    expect(document.getElementById('terminal-output')?.textContent).not.toContain('duplicate');

    initial.emit({ sequence: 7, event_type: 'terminal.stdout', data: { text: 'gap\r\n' } });
    await vi.waitFor(() => expect(app.callServerTool).toHaveBeenCalledWith({
      name: 'terminal_stream_refresh',
      arguments: { session_id: 'session-1', after: 5 },
    }));
    await vi.waitFor(() => expect(FakeEventSource.instances.some((candidate) => candidate.url.includes('token=refreshed'))).toBe(true));
    expect(initial.close).toHaveBeenCalled();

    initial.emit({ sequence: 6, event_type: 'terminal.stdout', data: { text: 'stale-source\r\n' } });
    terminalSource('refreshed').emit({ sequence: 6, event_type: 'terminal.stdout', data: { text: 'recovered\r\n' } });
    await flushFrames();
    expect(document.getElementById('terminal-output')?.textContent).not.toContain('stale-source');
    expect(document.getElementById('terminal-output')?.textContent).toContain('recovered\n');
  });

  it('ignores a stale stream refresh after a same-surface PTY replacement', async () => {
    const app = createFakeApp();
    const surfaceId = '44444444-4444-4444-8444-444444444444';
    let resolveOldRefresh: ((result: CallToolResult) => void) | undefined;
    app.callServerTool.mockImplementation(({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      if (name === 'terminal_stream_refresh' && args.session_id === 'session-1') {
        return new Promise<CallToolResult>((resolve) => { resolveOldRefresh = resolve; });
      }
      return Promise.resolve({ structuredContent: {} });
    });

    const viewer = new TerminalViewer(app);
    viewer.bind();
    const initial = initialResult();
    app.ontoolresult?.({
      ...initial,
      structuredContent: {
        ...initial.structuredContent,
        surface_id: surfaceId,
        surface_open: true,
        surface_active: true,
      },
    });
    await flushFrames();

    terminalSource().emit({ sequence: 6, event_type: 'terminal.stdout', data: { text: 'gap\r\n' } });
    await vi.waitFor(() => expect(resolveOldRefresh).toBeTypeOf('function'));

    app.ontoolresult?.({
      structuredContent: {
        surface_id: surfaceId,
        surface_open: true,
        surface_active: true,
        session_id: 'session-2',
        status: 'running',
        cursor: 2,
        initial_output: 'replacement\r\n',
        cwd: '/replacement',
        shell: 'bash',
      },
      _meta: {
        terminal_stream: {
          url: 'https://terminal.example/events?token=replacement-race',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    });
    const replacement = terminalSource('replacement-race');

    resolveOldRefresh?.({
      structuredContent: { session_id: 'session-1', status: 'running', cursor: 4 },
      _meta: {
        terminal_stream: {
          url: 'https://terminal.example/events?token=stale-refresh',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(replacement.close).not.toHaveBeenCalled();
    expect(FakeEventSource.instances.some((candidate) => candidate.url.includes('token=stale-refresh'))).toBe(false);
    expect(document.getElementById('terminal-path')?.textContent).toBe('/replacement');
    viewer.destroy();
  });

  it('does not let stale cursor resynchronization restore a replaced PTY', async () => {
    const app = createFakeApp();
    const surfaceId = '55555555-5555-4555-8555-555555555555';
    let resolveOldStatus: ((result: CallToolResult) => void) | undefined;
    app.callServerTool.mockImplementation(({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      if (name === 'terminal_stream_refresh' && args.session_id === 'session-1') {
        return Promise.resolve({ isError: true, _meta: { terminal_error: { code: 'INVALID_CURSOR' } } });
      }
      if (name === 'terminal_status' && args.session_id === 'session-1') {
        return new Promise<CallToolResult>((resolve) => { resolveOldStatus = resolve; });
      }
      return Promise.resolve({ structuredContent: {} });
    });

    const viewer = new TerminalViewer(app);
    viewer.bind();
    const initial = initialResult();
    app.ontoolresult?.({
      ...initial,
      structuredContent: {
        ...initial.structuredContent,
        surface_id: surfaceId,
        surface_open: true,
        surface_active: true,
      },
    });
    await flushFrames();

    terminalSource().emit({ sequence: 6, event_type: 'terminal.stdout', data: { text: 'gap\r\n' } });
    await vi.waitFor(() => expect(resolveOldStatus).toBeTypeOf('function'));

    app.ontoolresult?.({
      structuredContent: {
        surface_id: surfaceId,
        surface_open: true,
        surface_active: true,
        session_id: 'session-2',
        status: 'running',
        cursor: 2,
        initial_output: 'replacement\r\n',
        cwd: '/replacement',
        shell: 'bash',
      },
      _meta: {
        terminal_stream: {
          url: 'https://terminal.example/events?token=replacement-resync',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    });

    resolveOldStatus?.({
      structuredContent: {
        session_id: 'session-1',
        status: 'running',
        cursor: 8,
        cwd: '/stale-session',
        shell: 'bash',
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById('terminal-path')?.textContent).toBe('/replacement');
    expect(document.getElementById('terminal-output')?.textContent).not.toContain('Live output gap');
    viewer.destroy();
  });

  it('does not recreate a terminal stream when refresh completes after viewer destruction', async () => {
    const app = createFakeApp();
    let resolveRefresh: ((result: CallToolResult) => void) | undefined;
    app.callServerTool.mockImplementation(({ name }: { name: string; arguments: Record<string, unknown> }) => {
      if (name === 'terminal_stream_refresh') {
        return new Promise<CallToolResult>((resolve) => { resolveRefresh = resolve; });
      }
      return Promise.resolve({ structuredContent: {} });
    });

    const viewer = new TerminalViewer(app);
    viewer.bind();
    app.ontoolresult?.(initialResult());
    await flushFrames();
    terminalSource().emit({ sequence: 6, event_type: 'terminal.stdout', data: { text: 'gap\r\n' } });
    await vi.waitFor(() => expect(resolveRefresh).toBeTypeOf('function'));

    const sourcesBeforeDestroy = FakeEventSource.instances.length;
    viewer.destroy();
    resolveRefresh?.({
      structuredContent: { session_id: 'session-1', status: 'running', cursor: 4 },
      _meta: {
        terminal_stream: {
          url: 'https://terminal.example/events?token=late-refresh',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(FakeEventSource.instances).toHaveLength(sourcesBeforeDestroy);
  });

  it('starts MCP fallback immediately when an SSE event is malformed', async () => {
    const app = createFakeApp();
    const viewer = new TerminalViewer(app);
    viewer.bind();
    app.ontoolresult?.(initialResult());
    await flushFrames();

    terminalSource().emit({ sequence: 'invalid', event_type: 'terminal.stdout', data: { text: 'bad\r\n' } });

    await vi.waitFor(() => expect(app.callServerTool).toHaveBeenCalledWith({
      name: 'terminal_read',
      arguments: { session_id: 'session-1', after: 4, max_bytes: 32768, wait_ms: 1000 },
    }));
    expect(document.getElementById('terminal-stream-state')?.textContent).toMatch(/^MCP /);
    viewer.destroy();
  });

  it('falls back to bounded MCP terminal reads when direct SSE cannot connect', async () => {
    const app = createFakeApp();
    const viewer = new TerminalViewer(app);
    viewer.bind();
    app.ontoolresult?.(initialResult());
    await flushFrames();

    terminalSource().emitError();

    await vi.waitFor(() => expect(app.callServerTool).toHaveBeenCalledWith({
      name: 'terminal_read',
      arguments: { session_id: 'session-1', after: 4, max_bytes: 32768, wait_ms: 1000 },
    }));
    await flushFrames();

    expect(document.getElementById('terminal-output')?.textContent).toContain('fallback\n');
    expect(document.getElementById('terminal-shell')?.dataset.state).toBe('exited');
    expect(document.getElementById('terminal-exit')?.textContent).toBe('EXIT 0');
  });

  it('clears a pending SSE connect timeout when the viewer is destroyed', async () => {
    vi.useFakeTimers();
    const app = createFakeApp();
    const viewer = new TerminalViewer(app);
    viewer.bind();
    app.ontoolresult?.(initialResult());
    await flushFrames();

    expect(vi.getTimerCount()).toBeGreaterThan(0);
    viewer.destroy();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back to MCP reads when EventSource stays stuck connecting', async () => {
    vi.useFakeTimers();
    const app = createFakeApp();
    const viewer = new TerminalViewer(app);
    viewer.bind();
    app.ontoolresult?.(initialResult());
    await flushFrames();

    expect(document.getElementById('terminal-stream-state')?.textContent).toBe('SSE CONNECTING');
    await vi.advanceTimersByTimeAsync(3_000);

    expect(app.callServerTool).toHaveBeenCalledWith({
      name: 'terminal_read',
      arguments: { session_id: 'session-1', after: 4, max_bytes: 32768, wait_ms: 1000 },
    });
  });

  it('does not skip unrendered stream events when a same-session tool result reports a newer cursor', async () => {
    const app = createFakeApp();
    const viewer = new TerminalViewer(app);
    viewer.bind();
    app.ontoolresult?.(initialResult());
    await flushFrames();

    app.ontoolresult?.({
      structuredContent: { session_id: 'session-1', status: 'running', cursor: 8, cwd: '/workspace', shell: 'bash' },
    });
    terminalSource().emit({ sequence: 5, event_type: 'terminal.stdout', data: { text: 'must-not-be-skipped\r\n' } });
    await flushFrames();

    expect(document.getElementById('terminal-output')?.textContent).toContain('must-not-be-skipped\n');
  });

  it('renders host-normalized MCP read output and advances the fallback cursor', async () => {
    const app = createFakeApp();
    let readCount = 0;
    app.callServerTool.mockImplementation(async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
      if (name === 'terminal_read') {
        readCount += 1;
        if (readCount === 1) {
          return {
            structuredContent: {
              output: 'host-normalized\r\n',
              next_cursor: 6,
              has_more: false,
              status: 'running',
            },
          };
        }
        return {
          structuredContent: {
            output: 'fallback-done\r\n',
            next_cursor: 7,
            has_more: false,
            status: 'exited',
            exit_code: 0,
          },
        };
      }
      if (name === 'terminal_stream_refresh') {
        return {
          structuredContent: { session_id: 'session-1', status: 'running', cursor: 4 },
          _meta: { terminal_stream: { url: 'https://terminal.example/events?token=refreshed', expires_at: new Date(Date.now() + 60_000).toISOString() } },
        };
      }
      return { structuredContent: {} };
    });

    const viewer = new TerminalViewer(app);
    viewer.bind();
    app.ontoolresult?.(initialResult());
    await flushFrames();
    terminalSource().emitError();

    await vi.waitFor(() => expect(app.callServerTool).toHaveBeenCalledWith({
      name: 'terminal_read',
      arguments: { session_id: 'session-1', after: 6, max_bytes: 32768, wait_ms: 1000 },
    }));
    await flushFrames();

    expect(document.getElementById('terminal-output')?.textContent).toContain('host-normalized\nfallback-done\n');
    expect(document.getElementById('terminal-shell')?.dataset.state).toBe('exited');
  });

  it('renders content-only MCP read output and advances the fallback cursor', async () => {
    const app = createFakeApp();
    let readCount = 0;
    app.callServerTool.mockImplementation(async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
      if (name !== 'terminal_read') return { structuredContent: {} };
      readCount += 1;
      const payload = readCount === 1
        ? { output: 'content-only\r\n', events: [], next_cursor: 6, has_more: false, status: 'running', exit_code: null }
        : { output: 'content-done\r\n', events: [], next_cursor: 7, has_more: false, status: 'exited', exit_code: 0 };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    });

    const viewer = new TerminalViewer(app);
    viewer.bind();
    app.ontoolresult?.(initialResult());
    await flushFrames();
    terminalSource().emitError();

    await vi.waitFor(() => expect(app.callServerTool).toHaveBeenCalledWith({
      name: 'terminal_read',
      arguments: { session_id: 'session-1', after: 6, max_bytes: 32768, wait_ms: 1000 },
    }));
    await flushFrames();

    expect(document.getElementById('terminal-output')?.textContent).toContain('content-only\ncontent-done\n');
    expect(document.getElementById('terminal-shell')?.dataset.state).toBe('exited');
  });

  it('does not report MCP live until the first fallback read succeeds', async () => {
    const app = createFakeApp();
    let resolveFirstRead: ((result: CallToolResult) => void) | undefined;
    let firstRead = true;
    app.callServerTool.mockImplementation(({ name }: { name: string; arguments: Record<string, unknown> }) => {
      if (name === 'terminal_read' && firstRead) {
        firstRead = false;
        return new Promise<CallToolResult>((resolve) => { resolveFirstRead = resolve; });
      }
      if (name === 'terminal_read') return new Promise<CallToolResult>(() => undefined);
      return Promise.resolve({ structuredContent: {} });
    });

    const viewer = new TerminalViewer(app);
    viewer.bind();
    app.ontoolresult?.(initialResult());
    await flushFrames();
    terminalSource().emitError();

    expect(document.getElementById('terminal-stream-state')?.textContent).toBe('MCP CONNECTING');

    resolveFirstRead?.({
      structuredContent: { output: '', events: [], next_cursor: 4, has_more: false, status: 'running', exit_code: null },
    });
    await vi.waitFor(() => expect(document.getElementById('terminal-stream-state')?.textContent).toBe('MCP LIVE'));
    viewer.destroy();
  });


  it('falls back to MCP reads when surface sync discovers a session without an SSE capability', async () => {
    const app = createFakeApp();
    const surfaceId = '33333333-3333-4333-8333-333333333333';
    app.callServerTool.mockImplementation(async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
      if (name === 'terminal_surface_status') {
        return {
          structuredContent: {
            surface_id: surfaceId,
            surface_open: true,
            surface_active: true,
            session_id: 'session-ios',
            status: 'running',
            cursor: 2,
            initial_output: '',
            agent_id: 'agent-ios',
            agent_name: 'iPhone host',
            cwd: '/workspace',
            shell: 'bash',
            exit_code: null,
          },
        };
      }
      if (name === 'terminal_stream_refresh') {
        return { structuredContent: { session_id: 'session-ios', status: 'running', cursor: 2 } };
      }
      if (name === 'terminal_read') {
        return {
          structuredContent: {
            output: 'ios-mcp-fallback\r\n',
            events: [],
            next_cursor: 3,
            has_more: false,
            status: 'exited',
            exit_code: 0,
          },
        };
      }
      return { structuredContent: {} };
    });

    const viewer = new TerminalViewer(app);
    viewer.bind();
    app.ontoolresult?.({
      structuredContent: { surface_id: surfaceId, surface_open: true, surface_active: false, session_id: null },
    });
    viewer.markBridgeReady();

    await vi.waitFor(() => expect(app.callServerTool).toHaveBeenCalledWith({
      name: 'terminal_read',
      arguments: { session_id: 'session-ios', after: 2, max_bytes: 32768, wait_ms: 1000 },
    }));
    await flushFrames();

    expect(document.getElementById('terminal-output')?.textContent).toContain('ios-mcp-fallback\n');
    expect(document.getElementById('terminal-exit')?.textContent).toBe('EXIT 0');
    viewer.destroy();
  });

  it('switches a replacement PTY inside the same surface and ignores a different surface', async () => {
    const app = createFakeApp();
    const surfaceId = '11111111-1111-4111-8111-111111111111';
    app.callServerTool.mockImplementation(async ({ name }: { name: string; arguments: Record<string, unknown> }) => {
      if (name === 'terminal_surface_status') {
        return {
          structuredContent: {
            surface_id: surfaceId,
            surface_open: true,
            surface_active: true,
            session_id: 'session-2',
            status: 'running',
            cursor: 2,
            initial_output: 'replacement\r\n',
            agent_id: 'agent-1',
            agent_name: 'My computer',
            cwd: '/replacement',
            shell: 'bash',
            exit_code: null,
          },
        };
      }
      if (name === 'terminal_stream_refresh') {
        return {
          structuredContent: { session_id: 'session-2', status: 'running', cursor: 2 },
          _meta: {
            terminal_stream: {
              url: 'https://terminal.example/events?token=replacement',
              expires_at: new Date(Date.now() + 60_000).toISOString(),
            },
          },
        };
      }
      return { structuredContent: {} };
    });

    const viewer = new TerminalViewer(app);
    viewer.bind();
    app.ontoolresult?.({
      structuredContent: { surface_id: surfaceId, surface_open: true, surface_active: false, session_id: null },
    });
    viewer.markBridgeReady();

    await vi.waitFor(() => expect(app.callServerTool).toHaveBeenCalledWith({
      name: 'terminal_surface_status', arguments: { surface_id: surfaceId, session_id: null },
    }));
    await vi.waitFor(() => expect(app.callServerTool).toHaveBeenCalledWith({
      name: 'terminal_stream_refresh', arguments: { session_id: 'session-2', after: 2 },
    }));
    await flushFrames();

    expect(document.querySelectorAll('#terminal-shell')).toHaveLength(1);
    expect(document.getElementById('terminal-output')?.textContent).toContain('replacement\n');
    expect(document.getElementById('terminal-path')?.textContent).toBe('/replacement');

    app.ontoolresult?.({
      structuredContent: {
        surface_id: '22222222-2222-4222-8222-222222222222',
        surface_open: true,
        surface_active: true,
        session_id: 'session-3',
        status: 'running',
        cursor: 1,
        initial_output: 'WRONG-SURFACE\r\n',
      },
    });
    await flushFrames();
    expect(document.getElementById('terminal-output')?.textContent).not.toContain('WRONG-SURFACE');
    expect(document.getElementById('terminal-path')?.textContent).toBe('/replacement');
    viewer.destroy();
  });

  it('releases widget resources on host teardown without ending the assistant turn', async () => {
    const app = createFakeApp();
    const viewer = new TerminalViewer(app);
    viewer.bind();
    app.ontoolresult?.(initialResult());
    const source = terminalSource();

    await app.onteardown?.();

    expect(source.close).toHaveBeenCalledTimes(1);
    expect(app.callServerTool).not.toHaveBeenCalledWith({ name: 'terminal_turn_close', arguments: {} });
  });

  it('ignores an in-flight surface heartbeat after viewer destruction', async () => {
    const app = createFakeApp();
    const surfaceId = '66666666-6666-4666-8666-666666666666';
    let resolveSurface: ((result: CallToolResult) => void) | undefined;
    app.callServerTool.mockImplementation(({ name }: { name: string; arguments: Record<string, unknown> }) => {
      if (name === 'terminal_surface_status') {
        return new Promise<CallToolResult>((resolve) => { resolveSurface = resolve; });
      }
      return Promise.resolve({ structuredContent: {} });
    });

    const viewer = new TerminalViewer(app);
    viewer.bind();
    app.ontoolresult?.({ structuredContent: { surface_id: surfaceId, surface_open: true, surface_active: false, session_id: null } });
    viewer.markBridgeReady();
    await vi.waitFor(() => expect(resolveSurface).toBeTypeOf('function'));
    viewer.destroy();

    resolveSurface?.({
      structuredContent: {
        surface_id: surfaceId,
        surface_open: true,
        surface_active: true,
        session_id: 'session-late',
        status: 'running',
        cursor: 1,
        initial_output: 'late-output\r\n',
        cwd: '/late',
        shell: 'bash',
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById('terminal-path')?.textContent).not.toBe('/late');
    expect(document.getElementById('terminal-output')?.textContent).not.toContain('late-output');
  });

  it('hot reloads CSS without replacing the document or terminal SSE source', async () => {
    const css = '.terminal-shell { outline: 1px solid transparent; }';
    const fetchMock = vi.fn(async () => new Response(css, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const documentOpen = vi.spyOn(document, 'open');
    const app = createFakeApp();
    const viewer = new TerminalViewer(app);
    viewer.bind();
    app.ontoolresult?.(initialResult());
    const terminal = terminalSource();
    const reload = FakeEventSource.instances.find((candidate) => candidate.url.endsWith('/terminal-ui/reload'))!;

    reload.emit({ version: 'styles-v2', kind: 'styles' });
    await vi.waitFor(() => expect(document.querySelector<HTMLStyleElement>('#terminal-live-styles')?.textContent).toBe(css));
    expect(fetchMock).toHaveBeenCalled();
    expect(documentOpen).not.toHaveBeenCalled();
    expect(terminal.close).not.toHaveBeenCalled();
  });

  it('does not let an older stylesheet fetch overwrite a newer hot reload', async () => {
    let resolveV1: ((response: Response) => void) | undefined;
    let resolveV2: ((response: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => new Promise<Response>((resolve) => {
      if (String(input).includes('styles-v1')) resolveV1 = resolve;
      else resolveV2 = resolve;
    })));
    const app = createFakeApp();
    const viewer = new TerminalViewer(app);
    viewer.bind();
    app.ontoolresult?.(initialResult());
    const reload = FakeEventSource.instances.find((candidate) => candidate.url.endsWith('/terminal-ui/reload'))!;

    reload.emit({ version: 'styles-v1', kind: 'styles' });
    reload.emit({ version: 'styles-v2', kind: 'styles' });
    await vi.waitFor(() => expect(resolveV1).toBeTypeOf('function'));
    await vi.waitFor(() => expect(resolveV2).toBeTypeOf('function'));
    resolveV2?.(new Response('.newer { display: block; }', { status: 200 }));
    await vi.waitFor(() => expect(document.querySelector<HTMLStyleElement>('#terminal-live-styles')?.textContent).toContain('.newer'));
    resolveV1?.(new Response('.older { display: none; }', { status: 200 }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(document.querySelector<HTMLStyleElement>('#terminal-live-styles')?.textContent).toContain('.newer');
    expect(document.querySelector<HTMLStyleElement>('#terminal-live-styles')?.textContent).not.toContain('.older');
    viewer.destroy();
  });

  it('does not apply a stylesheet fetch that completes after viewer destruction', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })));
    const app = createFakeApp();
    const viewer = new TerminalViewer(app);
    viewer.bind();
    app.ontoolresult?.(initialResult());
    const reload = FakeEventSource.instances.find((candidate) => candidate.url.endsWith('/terminal-ui/reload'))!;

    reload.emit({ version: 'styles-after-destroy', kind: 'styles' });
    await vi.waitFor(() => expect(resolveFetch).toBeTypeOf('function'));
    viewer.destroy();
    resolveFetch?.(new Response('.late { display: block; }', { status: 200 }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(document.querySelector('#terminal-live-styles')).toBeNull();
  });

  it('adds rich terminal syntax tokens without changing the transcript text', () => {
    const text = 'shacker@host:/workspace$ pnpm test --filter "ui" ./src 42\nERROR build failed\nPASS 12 tests\n';
    const host = document.createElement('div');
    host.appendChild(highlightTerminalText(document, text));

    expect(host.textContent).toBe(text);
    for (const token of ['prompt', 'command', 'option', 'string', 'path', 'number', 'error', 'success']) {
      expect(host.querySelector(`.term-${token}`)).not.toBeNull();
    }
  });

  it('renders ANSI and semantic terminal syntax with DOM-safe themed spans', () => {
    const output = document.getElementById('terminal-output')!;
    output.textContent = '';

    appendRichTerminalText(output, '\u001b[31;1mERROR\u001b[0m const answer = "ok"; --force /tmp/demo 42\n');

    expect(output.textContent).toBe('ERROR const answer = "ok"; --force /tmp/demo 42\n');
    expect(output.querySelector('.term-red.term-bold')?.textContent).toBe('ERROR');
    expect(output.querySelector('.term-keyword')?.textContent).toBe('const');
    expect(output.querySelector('.term-string')?.textContent).toBe('"ok"');
    expect(output.querySelector('.term-option')?.textContent).toBe('--force');
    expect(output.querySelector('.term-path')?.textContent).toBe('/tmp/demo');
    expect(output.querySelector('.term-number')?.textContent).toBe('42');
    expect(output.innerHTML).not.toContain('<script');
  });

  it('classifies plain diagnostic and comment lines without changing terminal text', () => {
    const output = document.getElementById('terminal-output')!;
    output.textContent = '';
    const text = 'WARN retrying\n// source comment\nPASS complete\n';
    appendRichTerminalText(output, text);
    expect(output.textContent).toBe(text);
    expect(output.querySelector('.term-warning')?.textContent).toContain('WARN');
    expect(output.querySelector('.term-comment')?.textContent).toContain('// source comment');
    expect(output.querySelector('.term-success')?.textContent).toContain('PASS');
  });

  it('animates multi-line Overflow without ever reordering terminal truth', () => {
    vi.useFakeTimers();
    const output = document.getElementById('terminal-output')!;
    output.textContent = '';
    const text = 'PASS first line\nconst second = 2\nthird line\n';

    appendRichTerminalText(output, text, true);

    expect(output.querySelector('.term-overflow')).not.toBeNull();
    expect(output.textContent).toBe(text);
    expect(output.querySelector('.term-success')?.textContent).toBe('PASS');
    expect(output.querySelector('.term-keyword')?.textContent).toBe('const');
    vi.runAllTimers();
    expect(output.textContent).toBe(text);
    expect(output.querySelector('.term-overflow')).toBeNull();
    expect(output.querySelector('.term-success')?.textContent).toBe('PASS');
  });

  it('bypasses Overflow when reduced motion is requested', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    const output = document.getElementById('terminal-output')!;
    output.textContent = '';
    const text = 'first line\nsecond line\nthird line\n';

    appendRichTerminalText(output, text, true);

    expect(output.textContent).toBe(text);
    expect(output.querySelector('.term-overflow')).toBeNull();
  });

  it('normalizes common ANSI, carriage-return, and backspace terminal control bytes', () => {
    expect(normalizeTerminalText('\u001b[32mgreen\u001b[0m\r\nnext\b!')).toBe('green\nnex!');
    expect(normalizeTerminalText('\u001b]0;title\u0007prompt\rprogress')).toBe('prompt\nprogress');
  });

  it('boots through ChatGPT window.openai when the native host has no usable parent bridge', async () => {
    vi.useFakeTimers();
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => ({
      structuredContent: { surface_id: String(args.surface_id ?? 'surface-ios'), surface_open: true, surface_active: false, session_id: null },
    }));
    vi.stubGlobal('openai', {
      callTool,
      toolOutput: { surface_id: 'surface-ios', surface_open: true, surface_active: false, session_id: null },
      theme: 'dark',
    });

    const bridge = new ChatGptMcpBridge();
    const toolResult = vi.fn();
    bridge.ontoolresult = toolResult;

    const connected = expect(bridge.connect()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(15_001);
    await connected;

    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'ui/initialize' }), '*');
    expect(toolResult).toHaveBeenCalledWith({
      structuredContent: { surface_id: 'surface-ios', surface_open: true, surface_active: false, session_id: null },
    });

    const result = await bridge.callServerTool({
      name: 'terminal_surface_status',
      arguments: { surface_id: 'surface-ios', session_id: null },
    });
    expect(callTool).toHaveBeenCalledWith('terminal_surface_status', { surface_id: 'surface-ios', session_id: null });
    expect(result.structuredContent).toEqual({
      surface_id: 'surface-ios', surface_open: true, surface_active: false, session_id: null,
    });
    await bridge.close();
  });

  it('accepts terminal surface metadata injected after native ChatGPT boot', async () => {
    vi.stubGlobal('openai', { callTool: vi.fn(async () => ({ structuredContent: {} })) });
    const bridge = new ChatGptMcpBridge();
    const toolResult = vi.fn();
    const hostContext = vi.fn();
    bridge.ontoolresult = toolResult;
    bridge.onhostcontextchanged = hostContext;

    await bridge.connect();
    window.dispatchEvent(new CustomEvent('openai:set_globals', {
      detail: {
        globals: {
          toolOutput: { surface_id: 'surface-late', surface_open: true, surface_active: false, session_id: null },
          theme: 'light',
        },
      },
    }));

    expect(toolResult).toHaveBeenCalledWith({
      structuredContent: { surface_id: 'surface-late', surface_open: true, surface_active: false, session_id: null },
    });
    expect(hostContext).toHaveBeenCalledWith({ theme: 'light' });
    await bridge.close();
  });

  it('performs the minimal MCP Apps JSON-RPC handshake and validates parent-window messages', async () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    const bridge = new ChatGptMcpBridge();
    const toolResult = vi.fn();
    bridge.ontoolresult = toolResult;

    const connecting = bridge.connect();
    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      jsonrpc: '2.0', id: 1, method: 'ui/initialize',
      params: expect.objectContaining({ protocolVersion: '2026-01-26' }),
    }), '*');

    window.dispatchEvent(new MessageEvent('message', {
      source: window.parent,
      data: { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2026-01-26', hostInfo: {}, hostCapabilities: {}, hostContext: { theme: 'dark' } } },
    }));
    await connecting;
    expect(post).toHaveBeenCalledWith({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*');

    window.dispatchEvent(new MessageEvent('message', {
      source: window.parent,
      data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { session_id: 'session-1', status: 'running' } } },
    }));
    expect(toolResult).toHaveBeenCalledOnce();

    const call = bridge.callServerTool({ name: 'terminal_read', arguments: { session_id: 'session-1', after: 3 } });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
    }), '*');
    const wrappedPayload = { output: 'wrapped\\r\\n', events: [], next_cursor: 9, has_more: false, status: 'running', exit_code: null };
    window.dispatchEvent(new MessageEvent('message', {
      source: window.parent,
      data: {
        jsonrpc: '2.0',
        id: 2,
        result: { result: { content: [{ type: 'text', text: JSON.stringify(wrappedPayload) }], structuredContent: wrappedPayload } },
      },
    }));
    await expect(call).resolves.toEqual(expect.objectContaining({ structuredContent: wrappedPayload }));
    await bridge.close();
  });
});
