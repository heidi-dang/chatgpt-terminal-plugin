export interface CallToolResult {
  content?: unknown[];
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  isError?: boolean;
}

export interface TerminalViewState {
  session_id: string;
  agent_id?: string;
  agent_name?: string;
  cwd?: string;
  shell?: string;
  status: string;
  cursor: number;
  initial_output?: string;
  exit_code?: number | null;
}

export interface TerminalSurfaceState {
  surface_id: string | null;
  surface_open: boolean;
  surface_active: boolean;
  session_id: string | null;
}

export interface TerminalStreamMeta {
  url: string;
  expires_at: string;
}

export interface TerminalEvent {
  sequence: number;
  event_type: string;
  data: Record<string, unknown>;
}

export interface TerminalReadResult {
  output: string;
  events: TerminalEvent[] | null;
  next_cursor: number;
  has_more: boolean;
  status: string;
  exit_code: number | null;
}

export type StreamState = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'failed';
export type JsonRpcId = number | string;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function parseViewState(result: CallToolResult | null): TerminalViewState | null {
  if (!result) return null;
  const value = structuredPayload(result);
  if (!value || typeof value.session_id !== 'string' || typeof value.status !== 'string') return null;
  return {
    session_id: value.session_id,
    ...(typeof value.agent_id === 'string' ? { agent_id: value.agent_id } : {}),
    ...(typeof value.agent_name === 'string' ? { agent_name: value.agent_name } : {}),
    ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
    ...(typeof value.shell === 'string' ? { shell: value.shell } : {}),
    status: value.status,
    cursor: typeof value.cursor === 'number' ? value.cursor : 0,
    ...(typeof value.initial_output === 'string' ? { initial_output: value.initial_output } : {}),
    ...(typeof value.exit_code === 'number' || value.exit_code === null ? { exit_code: value.exit_code } : {}),
  };
}

export function parseStreamMeta(result: CallToolResult | null): TerminalStreamMeta | null {
  const terminalStream = result?._meta?.terminal_stream;
  if (!isRecord(terminalStream)) return null;
  return typeof terminalStream.url === 'string' && typeof terminalStream.expires_at === 'string'
    ? { url: terminalStream.url, expires_at: terminalStream.expires_at }
    : null;
}

export function parseSurfaceId(result: CallToolResult | null): string | null {
  if (!result) return null;
  const value = structuredPayload(result);
  return value && typeof value.surface_id === 'string' ? value.surface_id : null;
}

export function parseSurfaceState(result: CallToolResult | null): TerminalSurfaceState | null {
  if (!result) return null;
  const value = structuredPayload(result);
  if (!value || typeof value.surface_open !== 'boolean' || typeof value.surface_active !== 'boolean') return null;
  const surfaceId = value.surface_id;
  const sessionId = value.session_id;
  if (surfaceId !== null && typeof surfaceId !== 'string') return null;
  if (sessionId !== null && typeof sessionId !== 'string') return null;
  return {
    surface_id: surfaceId,
    surface_open: value.surface_open,
    surface_active: value.surface_active,
    session_id: sessionId,
  };
}

export function mergeViewState(previous: TerminalViewState | null, next: TerminalViewState): TerminalViewState {
  if (!previous || previous.session_id !== next.session_id) return next;
  return { ...previous, ...next };
}

export function classifySequence(lastSequence: number, incomingSequence: number): 'stale' | 'next' | 'gap' {
  if (!Number.isInteger(incomingSequence) || incomingSequence <= 0) return 'gap';
  if (incomingSequence <= lastSequence) return 'stale';
  return incomingSequence === lastSequence + 1 ? 'next' : 'gap';
}

export function parseTerminalEvent(raw: string): TerminalEvent {
  return parseTerminalEventValue(JSON.parse(raw));
}

export function parseTerminalReadResult(result: CallToolResult): TerminalReadResult | null {
  const value = structuredPayload(result);
  if (!value) return null;
  const output = value.output;
  const nextCursor = value.next_cursor;
  const hasMore = value.has_more;
  const status = value.status;
  const exitCode = value.exit_code;
  if (typeof output !== 'string') return null;
  if (!Number.isInteger(nextCursor) || typeof nextCursor !== 'number' || nextCursor < 0) return null;
  if (typeof hasMore !== 'boolean' || typeof status !== 'string') return null;
  if (exitCode !== undefined && exitCode !== null && typeof exitCode !== 'number') return null;

  let events: TerminalEvent[] | null = null;
  if (Array.isArray(value.events)) {
    try {
      events = value.events.map(parseTerminalEventValue);
    } catch {
      events = null;
    }
  }
  return {
    output,
    events,
    next_cursor: nextCursor,
    has_more: hasMore,
    status,
    exit_code: typeof exitCode === 'number' ? exitCode : null,
  };
}

export function isFinalStatus(status: string | undefined): boolean {
  return status === 'closed' || status === 'exited' || status === 'failed';
}

export function terminalErrorCode(result: CallToolResult): string | undefined {
  const terminalError = result._meta?.terminal_error;
  if (isRecord(terminalError) && typeof terminalError.code === 'string') return terminalError.code;
  const text = firstTextContent(result);
  return text?.match(/^([A-Z][A-Z0-9_]+):/)?.[1];
}

export function normalizeCompatCallToolResult(value: unknown): CallToolResult | null {
  return normalizeCallToolResult(value) ?? (isRecord(value) ? { structuredContent: value } : null);
}

export function normalizeCallToolResult(value: unknown): CallToolResult | null {
  if (!isRecord(value)) return null;
  let candidate = value;
  if (!hasCallToolResultFields(candidate) && isRecord(candidate.result)) candidate = candidate.result;

  const content = Array.isArray(candidate.content) ? candidate.content : undefined;
  const structuredContent = isRecord(candidate.structuredContent)
    ? candidate.structuredContent
    : isRecord(candidate.structured_content)
      ? candidate.structured_content
      : undefined;
  const meta = isRecord(candidate._meta) ? candidate._meta : undefined;
  const isError = typeof candidate.isError === 'boolean'
    ? candidate.isError
    : typeof candidate.is_error === 'boolean'
      ? candidate.is_error
      : undefined;

  if (!content && !structuredContent && !meta && isError === undefined) return null;
  return {
    ...(content ? { content } : {}),
    ...(structuredContent ? { structuredContent } : {}),
    ...(meta ? { _meta: meta } : {}),
    ...(isError !== undefined ? { isError } : {}),
  };
}

export function firstTextContent(result: CallToolResult): string | undefined {
  for (const item of result.content ?? []) {
    if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') return item.text;
  }
  return undefined;
}

export function structuredPayload(result: CallToolResult): Record<string, unknown> | null {
  if (isRecord(result.structuredContent)) return result.structuredContent;
  const text = firstTextContent(result);
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseTerminalEventValue(parsed: unknown): TerminalEvent {
  if (!isRecord(parsed)) throw new Error('Terminal event must be an object.');
  const sequence = parsed.sequence;
  const eventType = parsed.event_type;
  const data = parsed.data;
  if (!Number.isInteger(sequence) || typeof sequence !== 'number' || sequence <= 0) throw new Error('Terminal event has an invalid sequence.');
  if (typeof eventType !== 'string') throw new Error('Terminal event has an invalid event type.');
  if (!isRecord(data)) throw new Error('Terminal event has invalid data.');
  return { sequence, event_type: eventType, data };
}

function hasCallToolResultFields(value: Record<string, unknown>): boolean {
  return 'content' in value || 'structuredContent' in value || 'structured_content' in value || '_meta' in value || 'isError' in value || 'is_error' in value;
}