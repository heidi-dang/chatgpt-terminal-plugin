import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../packages/mcp-server/src/config.js';
import { TerminalService } from '../../packages/mcp-server/src/service.js';

function config(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    MCP_PUBLIC_URL: 'http://127.0.0.1:8787/mcp',
    MCP_AUTH_MODE: 'development',
    MCP_DEVELOPMENT_TOKEN: 'development-token-0123456789',
    ...overrides,
  });
}

describe('terminal session policy', () => {
  it('defaults user and agent quotas to unlimited', () => {
    const parsed = config();
    expect(parsed.maxSessionsPerUser).toBe(0);
    expect(parsed.maxSessionsPerAgent).toBe(0);
  });

  it('does not wait before returning a newly-created session snapshot', async () => {
    const gateway = {
      listSessions: vi.fn(() => []),
      start: vi.fn(async () => ({
        session: {
          session_id: 'session-1', agent_id: 'agent-1', user_id: 'user-1', execution_profile: 'owner-full',
          cwd: '/tmp', shell: 'bash', cols: 120, rows: 30, status: 'running',
          created_at: new Date().toISOString(), last_activity_at: new Date().toISOString(), exit_code: null,
        },
        events: [], cursor: 1, earliestCursor: 1,
      })),
      read: vi.fn(async () => ({
        output: '', events: [], next_cursor: 1, has_more: false, status: 'running', exit_code: null,
      })),
    };
    const audit = { record: vi.fn(async () => undefined) };
    const service = new TerminalService(gateway as never, config(), audit as never);
    await service.start({ userId: 'user-1', clientId: 'client-1', executionProfile: 'owner-full' }, {
      agent_id: 'agent-1', cols: 120, rows: 30,
    });
    expect(gateway.read).toHaveBeenCalledWith('user-1', 'session-1', 0, expect.any(Number), 0);
  });
  it('allows creation with hundreds of active sessions when quotas are disabled', async () => {
    const now = new Date().toISOString();
    const active = Array.from({ length: 250 }, (_, index) => ({
      session_id: `existing-${index}`,
      agent_id: 'agent-1',
      user_id: 'user-1',
      execution_profile: 'owner-full' as const,
      cwd: '/tmp', shell: 'bash', cols: 120, rows: 30, status: 'running' as const,
      created_at: now, last_activity_at: now, exit_code: null,
    }));
    const gateway = {
      listSessions: vi.fn(() => active),
      start: vi.fn(async () => ({
        session: { ...active[0]!, session_id: 'session-new' },
        events: [], cursor: 1, earliestCursor: 1,
      })),
      read: vi.fn(async () => ({ output: '', events: [], next_cursor: 1, has_more: false, status: 'running', exit_code: null })),
    };
    const audit = { record: vi.fn(async () => undefined) };
    const service = new TerminalService(gateway as never, config(), audit as never);
    await expect(service.start({ userId: 'user-1', clientId: 'client-1', executionProfile: 'owner-full' }, {
      agent_id: 'agent-1', cols: 120, rows: 30,
    })).resolves.toMatchObject({ session_id: 'session-new' });
    expect(gateway.start).toHaveBeenCalledOnce();
  });

  it('still enforces an explicitly configured positive quota', async () => {
    const now = new Date().toISOString();
    const gateway = {
      listSessions: vi.fn(() => [{
        session_id: 'existing-1', agent_id: 'agent-1', user_id: 'user-1', execution_profile: 'owner-full',
        cwd: '/tmp', shell: 'bash', cols: 120, rows: 30, status: 'running',
        created_at: now, last_activity_at: now, exit_code: null,
      }]),
      start: vi.fn(),
    };
    const audit = { record: vi.fn(async () => undefined) };
    const service = new TerminalService(gateway as never, config({ TERMINAL_MAX_SESSIONS_PER_USER: '1' }), audit as never);
    await expect(service.start({ userId: 'user-1', clientId: 'client-1', executionProfile: 'owner-full' }, {
      agent_id: 'agent-1', cols: 120, rows: 30,
    })).rejects.toMatchObject({ code: 'SESSION_LIMIT_REACHED' });
    expect(gateway.start).not.toHaveBeenCalled();
  });

});
