import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../packages/mcp-server/src/config.js';

function productionEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    MCP_PUBLIC_URL: 'https://terminal.example.com/mcp',
    MCP_AUTH_MODE: 'jwt',
    MCP_DEFAULT_EXECUTION_PROFILE: 'developer',
    OAUTH_ISSUER: 'https://auth.example.com',
    OAUTH_JWKS_URL: 'https://auth.example.com/.well-known/jwks.json',
    OAUTH_AUDIENCE: 'terminal-mcp',
    OAUTH_AUTHORIZATION_ENDPOINT: 'https://auth.example.com/authorize',
    OAUTH_TOKEN_ENDPOINT: 'https://auth.example.com/token',
    OAUTH_REQUIRED_SCOPES: 'terminal',
    STREAM_TOKEN_SECRET: 'stream-token-secret-0123456789abcdef',
    AGENT_DEVICE_REGISTRY_PATH: '/var/lib/chatgpt-terminal/devices.json',
    AGENT_ENROLLMENT_TOKEN: 'enrollment-token-0123456789abcdef',
    TERMINAL_MAX_SESSIONS_PER_USER: '4',
    TERMINAL_MAX_SESSIONS_PER_AGENT: '8',
    ...overrides,
  };
}

describe('server configuration invariants', () => {
  it('accepts a complete HTTPS production configuration and defaults host validation', () => {
    const config = loadConfig(productionEnv());
    expect(config.publicUrl.href).toBe('https://terminal.example.com/mcp');
    expect(config.allowedHosts).toEqual(['terminal.example.com']);
    expect(config.defaultExecutionProfile).toBe('developer');
    expect(config.shutdownGraceMs).toBe(2_000);
    expect(config.mcpSessionIdleMs).toBe(30 * 60_000);
    expect(config.mcpSessionSweepIntervalMs).toBe(30_000);
    expect(config.terminalTurnStatePath).toBe('/var/lib/chatgpt-terminal/terminal-turns.json');
    expect(config.terminalSurfaceRetentionMs).toBe(30 * 24 * 60 * 60_000);
  });

  it('rejects insecure production endpoints and malformed public MCP URLs', () => {
    expect(() => loadConfig(productionEnv({ MCP_PUBLIC_URL: 'http://terminal.example.com/mcp' })))
      .toThrow(/HTTPS/i);
    expect(() => loadConfig(productionEnv({ MCP_PUBLIC_URL: 'https://terminal.example.com/not-mcp' })))
      .toThrow(/exactly.*\/mcp/i);
    expect(() => loadConfig(productionEnv({ OAUTH_TOKEN_ENDPOINT: 'http://auth.example.com/token' })))
      .toThrow(/OAUTH_TOKEN_ENDPOINT.*HTTPS/i);
  });

  it('requires explicit opt-in for scope-less tokens and accepts a configured email ownership claim', () => {
    expect(() => loadConfig(productionEnv({ OAUTH_REQUIRED_SCOPES: '' })))
      .toThrow(/unless OAUTH_ALLOW_SCOPELESS_TOKENS=true/i);
    const cloudflareAccess = loadConfig(productionEnv({
      OAUTH_REQUIRED_SCOPES: '',
      OAUTH_ALLOW_SCOPELESS_TOKENS: 'true',
      OAUTH_USER_ID_CLAIM: 'email',
    }));
    expect(cloudflareAccess.requiredScopes).toEqual([]);
    expect(cloudflareAccess.oauthUserIdClaim).toBe('email');
  });

  it('accepts Cloudflare Access Managed OAuth origin validation without origin OAuth endpoints', () => {
    const config = loadConfig(productionEnv({
      MCP_AUTH_MODE: 'cloudflare-access',
      OAUTH_AUTHORIZATION_ENDPOINT: '',
      OAUTH_TOKEN_ENDPOINT: '',
      OAUTH_REGISTRATION_ENDPOINT: '',
      OAUTH_REQUIRED_SCOPES: '',
      OAUTH_ALLOW_SCOPELESS_TOKENS: 'true',
      OAUTH_USER_ID_CLAIM: 'email',
    }));
    expect(config.authMode).toBe('cloudflare-access');
    expect(config.oauthUserIdClaim).toBe('email');
    expect(config.requiredScopes).toEqual([]);
    expect(config.oauthAuthorizationEndpoint).toBeUndefined();
    expect(config.oauthTokenEndpoint).toBeUndefined();
  });

  it('keeps trusted extensions disabled by default and requires an absolute admin root', () => {
    const disabled = loadConfig(productionEnv());
    expect(disabled.extensionRoot).toBeUndefined();
    expect(() => loadConfig(productionEnv({ MCP_EXTENSION_ROOT: 'relative/extensions' })))
      .toThrow(/MCP_EXTENSION_ROOT.*absolute/i);
    const enabled = loadConfig(productionEnv({ MCP_EXTENSION_ROOT: '/opt/chatgpt-terminal/extensions' }));
    expect(enabled.extensionRoot).toBe('/opt/chatgpt-terminal/extensions');
  });

  it('requires finite production session quotas', () => {
    expect(() => loadConfig(productionEnv({ TERMINAL_MAX_SESSIONS_PER_USER: '0' })))
      .toThrow(/production.*session quota.*user/i);
    expect(() => loadConfig(productionEnv({ TERMINAL_MAX_SESSIONS_PER_AGENT: '0' })))
      .toThrow(/production.*session quota.*agent/i);
  });

  it('keeps MCP session sweeping no slower than the configured idle expiry', () => {
    expect(() => loadConfig(productionEnv({
      MCP_SESSION_IDLE_MS: '1000',
      MCP_SESSION_SWEEP_INTERVAL_MS: '2000',
    }))).toThrow(/MCP_SESSION_SWEEP_INTERVAL_MS.*less than or equal/i);
  });

  it('keeps surface retention longer than the active PTY lease', () => {
    expect(() => loadConfig(productionEnv({
      TERMINAL_TURN_LEASE_MS: '120000',
      TERMINAL_SURFACE_RETENTION_MS: '60000',
    }))).toThrow(/SURFACE_RETENTION.*greater than or equal/i);
    const config = loadConfig(productionEnv({
      TERMINAL_TURN_LEASE_MS: '120000',
      TERMINAL_SURFACE_RETENTION_MS: '2592000000',
    }));
    expect(config.terminalSurfaceRetentionMs).toBe(2_592_000_000);
  });

  it('requires an absolute persisted turn-state path when one is explicitly configured', () => {
    expect(() => loadConfig(productionEnv({ TERMINAL_TURN_STATE_PATH: 'relative/turns.json' })))
      .toThrow(/TERMINAL_TURN_STATE_PATH.*absolute/i);
    expect(loadConfig(productionEnv({ TERMINAL_TURN_STATE_PATH: '/srv/terminal/turns.json' })).terminalTurnStatePath)
      .toBe('/srv/terminal/turns.json');
  });

  it('rejects route collisions', () => {
    expect(() => loadConfig(productionEnv({ AGENT_GATEWAY_PATH: '/mcp' })))
      .toThrow(/must not collide/i);
    expect(() => loadConfig(productionEnv({ AGENT_ENROLLMENT_PATH: '/health' })))
      .toThrow(/must not collide/i);
  });
});
