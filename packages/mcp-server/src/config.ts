import { isAbsolute } from 'node:path';
import { z } from 'zod';

const positiveInt = (fallback: number, max = Number.MAX_SAFE_INTEGER) =>
  z.preprocess(
    (value) => (value === undefined || value === '' ? fallback : Number(value)),
    z.number().int().positive().max(max),
  );

const nonNegativeInt = (fallback: number, max = Number.MAX_SAFE_INTEGER) =>
  z.preprocess(
    (value) => (value === undefined || value === '' ? fallback : Number(value)),
    z.number().int().min(0).max(max),
  );

const csv = (fallback: string[] = []) =>
  z.preprocess(
    (value) => typeof value === 'string' ? value.split(',').map((item) => item.trim()).filter(Boolean) : fallback,
    z.array(z.string()),
  );

const optionalUrl = z.preprocess(
  (value) => value === undefined || value === '' ? undefined : value,
  z.string().url().optional(),
);

const optionalString = z.preprocess(
  (value) => value === undefined || value === '' ? undefined : value,
  z.string().min(1).optional(),
);

const booleanFlag = (fallback = false) => z.preprocess(
  (value) => {
    if (value === undefined || value === '') return fallback;
    if (value === true || value === '1' || value === 'true') return true;
    if (value === false || value === '0' || value === 'false') return false;
    return value;
  },
  z.boolean(),
);

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  MCP_HOST: z.string().min(1).default('127.0.0.1'),
  MCP_PORT: positiveInt(8787, 65_535),
  MCP_PUBLIC_URL: z.string().url(),
  AGENT_GATEWAY_PATH: z.string().regex(/^\//).default('/agent'),
  AGENT_ENROLLMENT_PATH: z.string().regex(/^\//).default('/agent/enroll'),
  AGENT_DEVICE_REGISTRY_PATH: optionalString,
  AGENT_ENROLLMENT_TOKEN: optionalString,
  AGENT_AUTH_CHALLENGE_TTL_MS: positiveInt(10_000, 60_000),
  ALLOWED_HOSTS: csv(),
  ALLOWED_ORIGINS: csv(),
  MCP_AUTH_MODE: z.enum(['development', 'jwt', 'cloudflare-access']).default('development'),
  MCP_DEFAULT_EXECUTION_PROFILE: z.enum(['read-only', 'developer', 'owner-full']).default('developer'),
  MCP_DEVELOPMENT_TOKEN: optionalString,
  DEVELOPMENT_USER_ID: z.string().min(1).default('local-development'),
  OAUTH_ISSUER: optionalUrl,
  OAUTH_JWKS_URL: optionalUrl,
  OAUTH_AUDIENCE: optionalString,
  OAUTH_AUTHORIZATION_ENDPOINT: optionalUrl,
  OAUTH_TOKEN_ENDPOINT: optionalUrl,
  OAUTH_REGISTRATION_ENDPOINT: optionalUrl,
  OAUTH_REQUIRED_SCOPES: csv(['terminal']),
  OAUTH_ADVERTISED_SCOPES: csv(),
  OAUTH_ALLOW_SCOPELESS_TOKENS: booleanFlag(false),
  OAUTH_USER_ID_CLAIM: z.enum(['sub', 'email']).default('sub'),
  STREAM_TOKEN_SECRET: optionalString,
  STREAM_TOKEN_TTL_SECONDS: positiveInt(120, 3600),
  TERMINAL_MAX_READ_BYTES: positiveInt(32_768, 262_144),
  TERMINAL_MAX_EVENT_BYTES: positiveInt(65_536, 1024 * 1024),
  TERMINAL_BUFFER_HIGH_WATER_BYTES: positiveInt(1024 * 1024, 64 * 1024 * 1024),
  // 0 disables the quota for development/test; production requires finite values below.
  TERMINAL_MAX_SESSIONS_PER_USER: nonNegativeInt(0, 100_000),
  TERMINAL_MAX_SESSIONS_PER_AGENT: nonNegativeInt(0, 100_000),
  TERMINAL_IDLE_TIMEOUT_MS: positiveInt(30 * 60_000, 7 * 24 * 60 * 60_000),
  TERMINAL_MAX_LIFETIME_MS: positiveInt(8 * 60 * 60_000, 30 * 24 * 60 * 60_000),
  TERMINAL_TURN_LEASE_MS: positiveInt(120_000, 60 * 60_000),
  TERMINAL_CLOSED_SESSION_RETENTION_MS: positiveInt(15 * 60_000, 7 * 24 * 60 * 60_000),
  TERMINAL_SWEEP_INTERVAL_MS: positiveInt(30_000, 10 * 60_000),
  AGENT_REQUEST_TIMEOUT_MS: positiveInt(15_000, 120_000),
  REQUESTS_PER_MINUTE: positiveInt(120, 10_000),
  MCP_EXTENSION_ROOT: optionalString,
  MCP_EXTENSION_MAX_BYTES: positiveInt(262_144, 4 * 1024 * 1024),
  AUDIT_LOG_PATH: optionalString,
  TRANSCRIPT_LOG_PATH: optionalString,
  TRANSCRIPT_RETENTION_DAYS: positiveInt(7, 3650),
});

export type ServerConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = configSchema.parse(env);
  const publicUrl = new URL(parsed.MCP_PUBLIC_URL);
  const oauthIssuer = parsed.OAUTH_ISSUER ? new URL(parsed.OAUTH_ISSUER) : undefined;
  const oauthJwksUrl = parsed.OAUTH_JWKS_URL ? new URL(parsed.OAUTH_JWKS_URL) : undefined;
  const oauthAuthorizationEndpoint = parsed.OAUTH_AUTHORIZATION_ENDPOINT ? new URL(parsed.OAUTH_AUTHORIZATION_ENDPOINT) : undefined;
  const oauthTokenEndpoint = parsed.OAUTH_TOKEN_ENDPOINT ? new URL(parsed.OAUTH_TOKEN_ENDPOINT) : undefined;
  const oauthRegistrationEndpoint = parsed.OAUTH_REGISTRATION_ENDPOINT ? new URL(parsed.OAUTH_REGISTRATION_ENDPOINT) : undefined;

  if (publicUrl.pathname !== '/mcp' || publicUrl.search || publicUrl.hash) {
    throw new Error('MCP_PUBLIC_URL must point exactly to the public /mcp endpoint without query parameters or fragments.');
  }
  if (parsed.OAUTH_REQUIRED_SCOPES.length === 0 && !parsed.OAUTH_ALLOW_SCOPELESS_TOKENS) {
    throw new Error('OAUTH_REQUIRED_SCOPES must contain at least one scope unless OAUTH_ALLOW_SCOPELESS_TOKENS=true is explicitly configured.');
  }
  if (parsed.AGENT_GATEWAY_PATH === '/' || parsed.AGENT_GATEWAY_PATH.endsWith('/')) {
    throw new Error('AGENT_GATEWAY_PATH must be a non-root path without a trailing slash.');
  }
  if (parsed.AGENT_ENROLLMENT_PATH === '/' || parsed.AGENT_ENROLLMENT_PATH.endsWith('/')) {
    throw new Error('AGENT_ENROLLMENT_PATH must be a non-root path without a trailing slash.');
  }
  const routePaths = ['/mcp', '/health', parsed.AGENT_GATEWAY_PATH, parsed.AGENT_ENROLLMENT_PATH, `${parsed.AGENT_ENROLLMENT_PATH}/revoke`];
  if (new Set(routePaths).size !== routePaths.length) throw new Error('Configured MCP, health, gateway, and enrollment routes must not collide.');

  if (parsed.NODE_ENV === 'production') {
    if (publicUrl.protocol !== 'https:') throw new Error('Production requires MCP_PUBLIC_URL to use HTTPS.');
    for (const [name, url] of [
      ['OAUTH_ISSUER', oauthIssuer],
      ['OAUTH_JWKS_URL', oauthJwksUrl],
      ['OAUTH_AUTHORIZATION_ENDPOINT', oauthAuthorizationEndpoint],
      ['OAUTH_TOKEN_ENDPOINT', oauthTokenEndpoint],
      ['OAUTH_REGISTRATION_ENDPOINT', oauthRegistrationEndpoint],
    ] as const) {
      if (url && url.protocol !== 'https:') throw new Error(`Production requires ${name} to use HTTPS.`);
    }
    if (parsed.MCP_AUTH_MODE === 'development') throw new Error('Production requires MCP_AUTH_MODE=jwt or cloudflare-access.');
    if (!oauthIssuer || !oauthJwksUrl || !parsed.OAUTH_AUDIENCE) {
      throw new Error('Production authentication requires issuer, JWKS URL, and audience.');
    }
    if (parsed.MCP_AUTH_MODE === 'jwt' && (!oauthAuthorizationEndpoint || !oauthTokenEndpoint)) {
      throw new Error('Production JWT OAuth requires authorization and token endpoints.');
    }
    if (!parsed.STREAM_TOKEN_SECRET || Buffer.byteLength(parsed.STREAM_TOKEN_SECRET) < 32) {
      throw new Error('Production requires STREAM_TOKEN_SECRET with at least 32 bytes.');
    }
    if (!parsed.AGENT_DEVICE_REGISTRY_PATH || !parsed.AGENT_ENROLLMENT_TOKEN) {
      throw new Error('Production requires AGENT_DEVICE_REGISTRY_PATH and AGENT_ENROLLMENT_TOKEN.');
    }
    if (parsed.TERMINAL_MAX_SESSIONS_PER_USER === 0) {
      throw new Error('Production requires a finite per-user session quota via TERMINAL_MAX_SESSIONS_PER_USER.');
    }
    if (parsed.TERMINAL_MAX_SESSIONS_PER_AGENT === 0) {
      throw new Error('Production requires a finite per-agent session quota via TERMINAL_MAX_SESSIONS_PER_AGENT.');
    }
  }

  if (parsed.MCP_EXTENSION_ROOT && !isAbsolute(parsed.MCP_EXTENSION_ROOT)) {
    throw new Error('MCP_EXTENSION_ROOT must be an absolute administrator-controlled path.');
  }

  if (parsed.MCP_AUTH_MODE === 'development' && !parsed.MCP_DEVELOPMENT_TOKEN) {
    throw new Error('Development auth requires MCP_DEVELOPMENT_TOKEN.');
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.MCP_HOST,
    port: parsed.MCP_PORT,
    publicUrl,
    agentGatewayPath: parsed.AGENT_GATEWAY_PATH,
    agentEnrollmentPath: parsed.AGENT_ENROLLMENT_PATH,
    deviceRegistryPath: parsed.AGENT_DEVICE_REGISTRY_PATH,
    agentEnrollmentToken: parsed.AGENT_ENROLLMENT_TOKEN,
    agentAuthChallengeTtlMs: parsed.AGENT_AUTH_CHALLENGE_TTL_MS,
    allowedHosts: parsed.ALLOWED_HOSTS.length > 0 ? parsed.ALLOWED_HOSTS : (parsed.NODE_ENV === 'production' ? [publicUrl.hostname] : []),
    allowedOrigins: parsed.ALLOWED_ORIGINS,
    authMode: parsed.MCP_AUTH_MODE,
    defaultExecutionProfile: parsed.MCP_DEFAULT_EXECUTION_PROFILE,
    developmentToken: parsed.MCP_DEVELOPMENT_TOKEN,
    developmentUserId: parsed.DEVELOPMENT_USER_ID,
    oauthIssuer,
    oauthJwksUrl,
    oauthAudience: parsed.OAUTH_AUDIENCE,
    oauthAuthorizationEndpoint,
    oauthTokenEndpoint,
    oauthRegistrationEndpoint,
    requiredScopes: parsed.OAUTH_REQUIRED_SCOPES,
    advertisedScopes: parsed.OAUTH_ADVERTISED_SCOPES.length > 0 ? parsed.OAUTH_ADVERTISED_SCOPES : parsed.OAUTH_REQUIRED_SCOPES,
    oauthUserIdClaim: parsed.OAUTH_USER_ID_CLAIM,
    streamTokenSecret: (() => {
      if (parsed.STREAM_TOKEN_SECRET) return parsed.STREAM_TOKEN_SECRET;
      if (parsed.MCP_DEVELOPMENT_TOKEN) {
        if (parsed.NODE_ENV !== 'development' && parsed.NODE_ENV !== 'test') {
          console.error(JSON.stringify({ level: 'warn', event: 'config.stream_token_fallback', message: 'STREAM_TOKEN_SECRET is not set; falling back to MCP_DEVELOPMENT_TOKEN for stream signing. Set a dedicated secret for production use.' }));
        }
        return parsed.MCP_DEVELOPMENT_TOKEN;
      }
      return '';
    })(),
    streamTokenTtlSeconds: parsed.STREAM_TOKEN_TTL_SECONDS,
    maxReadBytes: parsed.TERMINAL_MAX_READ_BYTES,
    maxEventBytes: parsed.TERMINAL_MAX_EVENT_BYTES,
    bufferHighWaterBytes: parsed.TERMINAL_BUFFER_HIGH_WATER_BYTES,
    maxSessionsPerUser: parsed.TERMINAL_MAX_SESSIONS_PER_USER,
    maxSessionsPerAgent: parsed.TERMINAL_MAX_SESSIONS_PER_AGENT,
    terminalIdleTimeoutMs: parsed.TERMINAL_IDLE_TIMEOUT_MS,
    terminalMaxLifetimeMs: parsed.TERMINAL_MAX_LIFETIME_MS,
    terminalTurnLeaseMs: parsed.TERMINAL_TURN_LEASE_MS,
    closedSessionRetentionMs: parsed.TERMINAL_CLOSED_SESSION_RETENTION_MS,
    terminalSweepIntervalMs: parsed.TERMINAL_SWEEP_INTERVAL_MS,
    agentRequestTimeoutMs: parsed.AGENT_REQUEST_TIMEOUT_MS,
    requestsPerMinute: parsed.REQUESTS_PER_MINUTE,
    extensionRoot: parsed.MCP_EXTENSION_ROOT,
    extensionMaxBytes: parsed.MCP_EXTENSION_MAX_BYTES,
    auditLogPath: parsed.AUDIT_LOG_PATH,
    transcriptLogPath: parsed.TRANSCRIPT_LOG_PATH,
    transcriptRetentionDays: parsed.TRANSCRIPT_RETENTION_DAYS,
  } as const;
}
