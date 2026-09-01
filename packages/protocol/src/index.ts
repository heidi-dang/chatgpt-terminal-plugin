import { z } from 'zod';

export const terminalSessionStatusSchema = z.enum([
  'creating',
  'running',
  'waiting',
  'closing',
  'disconnected',
  'exited',
  'closed',
  'failed',
]);
export type TerminalSessionStatus = z.infer<typeof terminalSessionStatusSchema>;

export const executionProfileSchema = z.enum(['read-only', 'developer', 'owner-full']);
export type ExecutionProfile = z.infer<typeof executionProfileSchema>;

export const agentCapabilitiesSchema = z.object({
  pty: z.boolean().default(true),
  resize: z.boolean().default(true),
  signals: z.array(z.string()).default(['SIGINT']),
  shells: z.array(z.string()).default([]),
  resume: z.boolean().default(false),
});
export type AgentCapabilities = z.infer<typeof agentCapabilitiesSchema>;

export const agentSchema = z.object({
  agent_id: z.string().min(1),
  execution_profile: executionProfileSchema,
  hostname: z.string().min(1),
  display_name: z.string().min(1),
  platform: z.string().min(1),
  architecture: z.string().min(1),
  online: z.boolean(),
  capabilities: agentCapabilitiesSchema,
  connected_at: z.string().datetime(),
  last_seen: z.string().datetime(),
});
export type Agent = z.infer<typeof agentSchema>;

export const terminalSessionSchema = z.object({
  session_id: z.string().min(1),
  agent_id: z.string().min(1),
  user_id: z.string().min(1),
  execution_profile: executionProfileSchema,
  cwd: z.string().min(1),
  shell: z.string().min(1),
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(300),
  status: terminalSessionStatusSchema,
  created_at: z.string().datetime(),
  last_activity_at: z.string().datetime(),
  exit_code: z.number().int().nullable(),
});
export type TerminalSession = z.infer<typeof terminalSessionSchema>;

export const terminalEventTypeSchema = z.enum([
  'session.started',
  'session.closed',
  'command.input',
  'terminal.stdout',
  'terminal.stderr',
  'terminal.resize',
  'terminal.signal',
  'cwd.changed',
  'process.exit',
  'agent.connected',
  'agent.disconnected',
  'error',
]);
export type TerminalEventType = z.infer<typeof terminalEventTypeSchema>;

export const terminalEventActorSchema = z.enum(['chatgpt', 'user', 'agent', 'system']);
export type TerminalEventActor = z.infer<typeof terminalEventActorSchema>;

export const terminalEventSchema = z.object({
  event_id: z.string().min(1),
  session_id: z.string().min(1),
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime(),
  actor: terminalEventActorSchema,
  event_type: terminalEventTypeSchema,
  data: z.record(z.string(), z.unknown()),
});
export type TerminalEvent = z.infer<typeof terminalEventSchema>;

export const terminalErrorCodeSchema = z.enum([
  'AGENT_OFFLINE',
  'SESSION_NOT_FOUND',
  'SESSION_CLOSED',
  'INVALID_CURSOR',
  'PATH_NOT_ALLOWED',
  'PERMISSION_DENIED',
  'PTY_CREATE_FAILED',
  'AGENT_TIMEOUT',
  'OUTPUT_LIMIT_REACHED',
  'STREAM_TOKEN_EXPIRED',
  'SESSION_LIMIT_REACHED',
  'INVALID_ARGUMENT',
  'FILE_NOT_FOUND',
  'FILE_TOO_LARGE',
]);
export type TerminalErrorCode = z.infer<typeof terminalErrorCodeSchema>;

export const terminalErrorSchema = z.object({
  code: terminalErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean().default(false),
});
export type TerminalErrorPayload = z.infer<typeof terminalErrorSchema>;

export class TerminalProtocolError extends Error {
  readonly code: TerminalErrorCode;
  readonly retryable: boolean;

  constructor(code: TerminalErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'TerminalProtocolError';
    this.code = code;
    this.retryable = retryable;
  }

  toPayload(): TerminalErrorPayload {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

export const terminalStartInputSchema = z.object({
  agent_id: z.string().min(1),
  cwd: z.string().min(1).optional(),
  shell: z.string().min(1).optional(),
  command: z.string().max(65_536).optional(),
  cols: z.number().int().min(20).max(500).default(120),
  rows: z.number().int().min(5).max(300).default(30),
});
export type TerminalStartInput = z.infer<typeof terminalStartInputSchema>;

export const terminalStartOutputSchema = z.object({
  session_id: z.string(),
  status: terminalSessionStatusSchema,
  cursor: z.number().int().nonnegative(),
  initial_output: z.string(),
});
export type TerminalStartOutput = z.infer<typeof terminalStartOutputSchema>;

export const terminalReadInputSchema = z.object({
  session_id: z.string().min(1),
  after: z.number().int().nonnegative().default(0),
  max_bytes: z.number().int().positive().max(262_144).optional(),
  wait_ms: z.number().int().nonnegative().max(30_000).optional(),
});
export type TerminalReadInput = z.infer<typeof terminalReadInputSchema>;

export const terminalReadOutputSchema = z.object({
  output: z.string(),
  events: z.array(terminalEventSchema),
  next_cursor: z.number().int().nonnegative(),
  has_more: z.boolean(),
  status: terminalSessionStatusSchema,
  exit_code: z.number().int().nullable(),
});
export type TerminalReadOutput = z.infer<typeof terminalReadOutputSchema>;

export const terminalWriteInputSchema = z.object({
  session_id: z.string().min(1),
  text: z.string().min(1).max(65_536),
});
export type TerminalWriteInput = z.infer<typeof terminalWriteInputSchema>;

export const terminalResizeInputSchema = z.object({
  session_id: z.string().min(1),
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(300),
});
export type TerminalResizeInput = z.infer<typeof terminalResizeInputSchema>;

export const terminalSessionIdInputSchema = z.object({ session_id: z.string().min(1) });
export type TerminalSessionIdInput = z.infer<typeof terminalSessionIdInputSchema>;

export const terminalMutationOutputSchema = z.object({
  session_id: z.string(),
  status: terminalSessionStatusSchema,
  cursor: z.number().int().nonnegative(),
});
export type TerminalMutationOutput = z.infer<typeof terminalMutationOutputSchema>;

export const terminalStatusOutputSchema = terminalSessionSchema.extend({
  agent_online: z.boolean(),
  cursor: z.number().int().nonnegative(),
  uptime_seconds: z.number().nonnegative().optional(),
  total_events: z.number().int().nonnegative().optional(),
  total_output_bytes: z.number().int().nonnegative().optional(),
  command_count: z.number().int().nonnegative().optional(),
});
export type TerminalStatusOutput = z.infer<typeof terminalStatusOutputSchema>;

export const terminalListAgentsOutputSchema = z.object({ agents: z.array(agentSchema) });
export type TerminalListAgentsOutput = z.infer<typeof terminalListAgentsOutputSchema>;

export const agentSessionSnapshotSchema = z.object({
  session: terminalSessionSchema,
  cursor: z.number().int().nonnegative(),
  earliestCursor: z.number().int().nonnegative(),
});
export type AgentSessionSnapshot = z.infer<typeof agentSessionSnapshotSchema>;

// --- File operation schemas ---

export const terminalReadFileInputSchema = z.object({
  session_id: z.string().min(1),
  path: z.string().min(1).max(4096),
  max_bytes: z.number().int().positive().max(262_144).default(65_536),
});
export type TerminalReadFileInput = z.infer<typeof terminalReadFileInputSchema>;

export const terminalReadFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
  size: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type TerminalReadFileOutput = z.infer<typeof terminalReadFileOutputSchema>;

export const terminalListFilesInputSchema = z.object({
  session_id: z.string().min(1),
  path: z.string().min(1).max(4096).default('.'),
  max_entries: z.number().int().positive().max(500).default(100),
});
export type TerminalListFilesInput = z.infer<typeof terminalListFilesInputSchema>;

export const terminalFileEntrySchema = z.object({
  name: z.string(),
  type: z.enum(['file', 'directory', 'symlink', 'other']),
  size: z.number().int().nonnegative(),
  modified_at: z.string().datetime(),
});
export type TerminalFileEntry = z.infer<typeof terminalFileEntrySchema>;

export const terminalListFilesOutputSchema = z.object({
  path: z.string(),
  entries: z.array(terminalFileEntrySchema),
  truncated: z.boolean(),
});
export type TerminalListFilesOutput = z.infer<typeof terminalListFilesOutputSchema>;

export const terminalWriteFileInputSchema = z.object({
  session_id: z.string().min(1),
  path: z.string().min(1).max(4096),
  content: z.string().max(262_144),
  create_directories: z.boolean().default(false),
});
export type TerminalWriteFileInput = z.infer<typeof terminalWriteFileInputSchema>;

export const terminalWriteFileOutputSchema = z.object({
  path: z.string(),
  bytes_written: z.number().int().nonnegative(),
});
export type TerminalWriteFileOutput = z.infer<typeof terminalWriteFileOutputSchema>;

export const agentCommandSchema = z.discriminatedUnion('action', [
  z.object({
    type: z.literal('request'),
    request_id: z.string().min(1),
    action: z.literal('terminal.start'),
    user_id: z.string().min(1),
    execution_profile: executionProfileSchema,
    input: terminalStartInputSchema,
  }),
  z.object({
    type: z.literal('request'),
    request_id: z.string().min(1),
    action: z.literal('terminal.write'),
    input: terminalWriteInputSchema,
  }),
  z.object({
    type: z.literal('request'),
    request_id: z.string().min(1),
    action: z.literal('terminal.resize'),
    input: terminalResizeInputSchema,
  }),
  z.object({
    type: z.literal('request'),
    request_id: z.string().min(1),
    action: z.literal('terminal.interrupt'),
    input: terminalSessionIdInputSchema,
  }),
  z.object({
    type: z.literal('request'),
    request_id: z.string().min(1),
    action: z.literal('terminal.close'),
    input: terminalSessionIdInputSchema,
  }),
  z.object({
    type: z.literal('request'),
    request_id: z.string().min(1),
    action: z.literal('terminal.status'),
    input: terminalSessionIdInputSchema,
  }),
  z.object({
    type: z.literal('request'),
    request_id: z.string().min(1),
    action: z.literal('file.read'),
    input: terminalReadFileInputSchema,
  }),
  z.object({
    type: z.literal('request'),
    request_id: z.string().min(1),
    action: z.literal('file.list'),
    input: terminalListFilesInputSchema,
  }),
  z.object({
    type: z.literal('request'),
    request_id: z.string().min(1),
    action: z.literal('file.write'),
    input: terminalWriteFileInputSchema,
  }),
]);
export type AgentCommand = z.infer<typeof agentCommandSchema>;

export const agentResponseSchema = z.object({
  type: z.literal('response'),
  request_id: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: terminalErrorSchema.optional(),
});
export type AgentResponse = z.infer<typeof agentResponseSchema>;

export const gatewayAuthChallengeSchema = z.object({
  type: z.literal('auth.challenge'),
  nonce: z.string().uuid(),
  issued_at: z.string().datetime(),
  expires_at: z.string().datetime(),
});
export type GatewayAuthChallenge = z.infer<typeof gatewayAuthChallengeSchema>;

export function gatewayChallengePayload(deviceId: string, nonce: string, issuedAt: string): string {
  return `terminal-gateway-v1\n${deviceId}\n${nonce}\n${issuedAt}`;
}

export const gatewayAuthProofSchema = z.object({
  type: z.literal('auth.proof'),
  device_id: z.string().min(1),
  nonce: z.string().uuid(),
  issued_at: z.string().datetime(),
  signature: z.string().min(32).max(512),
});
export type GatewayAuthProof = z.infer<typeof gatewayAuthProofSchema>;

export const gatewayResumeAckSchema = z.object({
  type: z.literal('agent.resume.ack'),
  sequences: z.record(z.string(), z.number().int().nonnegative()),
});
export type GatewayResumeAck = z.infer<typeof gatewayResumeAckSchema>;

export const gatewayMessageSchema = z.union([
  gatewayAuthChallengeSchema,
  gatewayAuthProofSchema,
  z.object({ type: z.literal('auth.accepted'), server_time: z.string().datetime() }),
  z.object({ type: z.literal('heartbeat'), timestamp: z.string().datetime() }),
  z.object({ type: z.literal('event'), event: terminalEventSchema }),
  z.object({ type: z.literal('ack'), session_id: z.string(), sequence: z.number().int().nonnegative() }),
  z.object({ type: z.literal('agent.register'), agent: agentSchema, device_id: z.string().min(1) }),
  z.object({ type: z.literal('agent.resume'), agent_id: z.string(), sessions: z.array(agentSessionSnapshotSchema) }),
  gatewayResumeAckSchema,
  agentCommandSchema,
  agentResponseSchema,
]);
export type GatewayMessage = z.infer<typeof gatewayMessageSchema>;

export const deviceEnrollmentRequestSchema = z.object({
  device_id: z.string().min(1),
  agent_id: z.string().min(1),
  owner_id: z.string().min(1),
  public_key: z.string().min(32),
  display_name: z.string().min(1).optional(),
});
export type DeviceEnrollmentRequest = z.infer<typeof deviceEnrollmentRequestSchema>;

export const deviceEnrollmentOutputSchema = z.object({
  device_id: z.string(),
  agent_id: z.string(),
  owner_id: z.string(),
  status: z.enum(['enrolled', 'rotated']),
  enrolled_at: z.string().datetime(),
});
export type DeviceEnrollmentOutput = z.infer<typeof deviceEnrollmentOutputSchema>;

export const terminalStreamRefreshInputSchema = z.object({
  session_id: z.string().min(1),
  after: z.number().int().nonnegative().default(0),
});
export type TerminalStreamRefreshInput = z.infer<typeof terminalStreamRefreshInputSchema>;

export const terminalStreamRefreshOutputSchema = z.object({
  session_id: z.string().min(1),
  expires_at: z.string().datetime(),
});
export type TerminalStreamRefreshOutput = z.infer<typeof terminalStreamRefreshOutputSchema>;


