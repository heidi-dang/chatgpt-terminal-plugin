import { homedir } from 'node:os';
import { join } from 'node:path';
import { LocalTerminalAgent } from './index.js';
import { AgentGatewayClient } from './gateway-client.js';
import { DeviceIdentity, enrollDevice } from './device-identity.js';
import { executionProfileSchema, lspServerDefinitionsSchema } from '@terminal/protocol';

function csv(value: string | undefined): string[] {
  return value?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
}

function intEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

const gatewayUrl = process.env.AGENT_GATEWAY_URL;
if (!gatewayUrl) throw new Error('AGENT_GATEWAY_URL is required.');
const parsedGatewayUrl = new URL(gatewayUrl);
if (parsedGatewayUrl.protocol !== 'ws:' && parsedGatewayUrl.protocol !== 'wss:') {
  throw new Error('AGENT_GATEWAY_URL must use ws:// or wss://.');
}

const roots = csv(process.env.ALLOWED_WORKSPACE_ROOTS);
const shells = csv(process.env.AGENT_SHELLS);
const profile = executionProfileSchema.parse(process.env.EXECUTION_PROFILE ?? 'developer');
const lspServers = lspServerDefinitionsSchema.parse(
  process.env.TERMINAL_LSP_SERVERS_JSON ? JSON.parse(process.env.TERMINAL_LSP_SERVERS_JSON) : {},
);
if (profile === 'developer' && roots.length === 0) {
  throw new Error('ALLOWED_WORKSPACE_ROOTS is required when EXECUTION_PROFILE=developer.');
}
const identityPath = process.env.AGENT_IDENTITY_PATH ?? join(homedir(), '.config', 'chatgpt-terminal-plugin', 'device.json');
const identity = await DeviceIdentity.loadOrCreate(identityPath, process.env.AGENT_ROTATE_KEY === '1');

if (process.env.AGENT_ENROLLMENT_URL || process.env.AGENT_ENROLLMENT_TOKEN || process.env.AGENT_OWNER_ID) {
  if (!process.env.AGENT_ENROLLMENT_URL || !process.env.AGENT_ENROLLMENT_TOKEN || !process.env.AGENT_OWNER_ID) {
    throw new Error('AGENT_ENROLLMENT_URL, AGENT_ENROLLMENT_TOKEN, and AGENT_OWNER_ID must be configured together.');
  }
  const status = await enrollDevice({
    identity,
    enrollmentUrl: process.env.AGENT_ENROLLMENT_URL,
    enrollmentToken: process.env.AGENT_ENROLLMENT_TOKEN,
    ownerId: process.env.AGENT_OWNER_ID,
    ...(process.env.AGENT_DISPLAY_NAME ? { displayName: process.env.AGENT_DISPLAY_NAME } : {}),
  });
  console.log(JSON.stringify({ level: 'info', event: 'agent.device_enrollment', status, device_id: identity.deviceId }));
  delete process.env.AGENT_ENROLLMENT_TOKEN;
}

const agent = new LocalTerminalAgent({
  agentId: identity.agentId,
  ...(process.env.AGENT_DISPLAY_NAME ? { displayName: process.env.AGENT_DISPLAY_NAME } : {}),
  allowedWorkspaceRoots: roots,
  executionProfile: profile,
  lspServers,
  ...(shells.length > 0 ? { shells } : {}),
  bufferHighWaterBytes: intEnv('TERMINAL_BUFFER_HIGH_WATER_BYTES', 1024 * 1024),
  maxEventBytes: intEnv('TERMINAL_MAX_EVENT_BYTES', 64 * 1024),
  idleTimeoutMs: intEnv('TERMINAL_IDLE_TIMEOUT_MS', 30 * 60_000),
  maxLifetimeMs: intEnv('TERMINAL_MAX_LIFETIME_MS', 8 * 60 * 60_000),
  closedSessionRetentionMs: intEnv('TERMINAL_CLOSED_SESSION_RETENTION_MS', 15 * 60_000),
  sweepIntervalMs: intEnv('TERMINAL_SWEEP_INTERVAL_MS', 30_000),
  ...(process.env.AGENT_AUDIT_LOG_PATH ? { auditLogPath: process.env.AGENT_AUDIT_LOG_PATH } : {}),
});

// AGENT_CONTROL_QUEUE_LIMIT is documented in the example environment but is not yet consumed
// by the AgentGatewayClient (GatewayClientOptions has no controlQueueLimit field in this version).
if (process.env.AGENT_CONTROL_QUEUE_LIMIT) {
  console.warn(JSON.stringify({ level: 'warn', event: 'agent.config', message: 'AGENT_CONTROL_QUEUE_LIMIT is set but not yet consumed by this version.' }));
}

const client = new AgentGatewayClient(agent, {
  url: parsedGatewayUrl.href,
  identity,
  heartbeatMs: intEnv('AGENT_HEARTBEAT_MS', 15_000),
  reconnectMaxMs: intEnv('AGENT_RECONNECT_MAX_MS', 30_000),
  outboundHighWaterBytes: intEnv('TERMINAL_BUFFER_HIGH_WATER_BYTES', 1024 * 1024),
  maxInflightEvents: intEnv('AGENT_MAX_INFLIGHT_EVENTS', 128),
});

const shutdown = () => client.stop();
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await client.start();
