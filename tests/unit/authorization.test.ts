import { describe, expect, it, vi } from 'vitest';
import { AuditLogger } from '../../packages/mcp-server/src/audit.js';
import { loadConfig } from '../../packages/mcp-server/src/config.js';
import type { AgentGateway } from '../../packages/mcp-server/src/gateway.js';
import { TerminalService, type RequestIdentity } from '../../packages/mcp-server/src/service.js';

function testConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    MCP_PUBLIC_URL: 'http://127.0.0.1:8787/mcp',
    MCP_AUTH_MODE: 'development',
    MCP_DEVELOPMENT_TOKEN: 'authorization-test-token',
    MCP_DEFAULT_EXECUTION_PROFILE: 'developer',
  });
}

function fakeGateway() {
  return {
    listAgents: vi.fn(() => []),
    listSessions: vi.fn(() => []),
    start: vi.fn(),
    read: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    interrupt: vi.fn(),
    status: vi.fn(),
    close: vi.fn(),
  };
}

const readOnlyIdentity: RequestIdentity = {
  userId: 'user-read-only',
  clientId: 'client-a',
  executionProfile: 'read-only',
};

describe('server execution-profile authorization', () => {
  it('allows read-only discovery but blocks terminal creation before routing to an agent', async () => {
    const gateway = fakeGateway();
    const service = new TerminalService(
      gateway as unknown as AgentGateway,
      testConfig(),
      new AuditLogger(undefined, undefined),
    );

    await expect(service.listAgents(readOnlyIdentity)).resolves.toEqual({ agents: [] });
    await expect(service.start(readOnlyIdentity, {
      agent_id: 'agent-a',
      shell: 'bash',
      cols: 80,
      rows: 24,
    })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(gateway.start).not.toHaveBeenCalled();
  });

  it('blocks all PTY mutations for read-only identities before gateway execution', async () => {
    const gateway = fakeGateway();
    const service = new TerminalService(
      gateway as unknown as AgentGateway,
      testConfig(),
      new AuditLogger(undefined, undefined),
    );

    await expect(service.write(readOnlyIdentity, { session_id: 'session-a', text: 'pwd\r' }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(service.resize(readOnlyIdentity, { session_id: 'session-a', cols: 100, rows: 30 }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(service.interrupt(readOnlyIdentity, 'session-a'))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(service.close(readOnlyIdentity, 'session-a'))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    expect(gateway.write).not.toHaveBeenCalled();
    expect(gateway.resize).not.toHaveBeenCalled();
    expect(gateway.interrupt).not.toHaveBeenCalled();
    expect(gateway.close).not.toHaveBeenCalled();
  });
});
