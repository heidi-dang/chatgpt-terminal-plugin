import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

const secretPatterns: RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi,
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)\s*[=:]\s*([^\s'";]+)/gi,
];

export interface AuditEvent {
  action: string;
  user_id: string;
  client_id?: string;
  chatgpt_session_id?: string;
  agent_id?: string;
  terminal_session_id?: string;
  sequence?: number;
  authorization: 'allow' | 'deny';
  input?: unknown;
  output_metadata?: unknown;
  error_code?: string;
}

export class AuditLogger {
  private readonly fileTails = new Map<string, Promise<void>>();
  private readonly preparedPaths = new Set<string>();

  constructor(
    private readonly auditPath?: string,
    private readonly transcriptPath?: string,
  ) {}

  async record(event: AuditEvent): Promise<void> {
    const entry = {
      event_id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...redactValue(event),
    };
    await this.enqueue(this.auditPath, () => this.write(this.auditPath, entry));
  }

  async transcript(event: {
    user_id: string;
    agent_id: string;
    terminal_session_id: string;
    sequence: number;
    event_type: string;
    data: unknown;
  }): Promise<void> {
    const entry = {
      event_id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...redactValue(event),
    };
    await this.enqueue(this.transcriptPath, () => this.write(this.transcriptPath, entry));
  }

  async pruneTranscript(retentionDays: number): Promise<number> {
    if (!this.transcriptPath) return 0;
    let removed = 0;
    await this.enqueue(this.transcriptPath, async () => {
      let content: string;
      try {
        content = await readFile(this.transcriptPath!, 'utf8');
      } catch (error) {
        if (isMissingFile(error)) return;
        throw error;
      }
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60_000;
      const lines = content.split('\n').filter(Boolean);
      const retained: string[] = [];
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as { timestamp?: unknown };
          const timestamp = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : Number.NaN;
          if (Number.isFinite(timestamp) && timestamp < cutoff) {
            removed += 1;
            continue;
          }
        } catch {
          // Preserve malformed historical entries rather than silently deleting evidence.
        }
        retained.push(line);
      }
      if (removed > 0) {
        await writeFile(this.transcriptPath!, retained.length > 0 ? `${retained.join('\n')}\n` : '', { encoding: 'utf8', mode: 0o600 });
        await chmod(this.transcriptPath!, 0o600);
      }
    });
    return removed;
  }

  async flush(): Promise<void> {
    await Promise.all(this.fileTails.values());
  }

  private enqueue(path: string | undefined, operation: () => Promise<void>): Promise<void> {
    const key = path ?? '<stdout>';
    const tail = this.fileTails.get(key) ?? Promise.resolve();
    const current = tail.then(operation, operation);
    this.fileTails.set(key, current.then(() => undefined, () => undefined));
    return current;
  }

  private async write(path: string | undefined, entry: unknown): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    if (path) {
      if (!this.preparedPaths.has(path)) {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
        await chmod(path, 0o600);
        this.preparedPaths.add(path);
        return;
      }
      await appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
      return;
    }
    process.stdout.write(line);
  }
}

export function redactText(value: string): string {
  let redacted = value;
  for (const pattern of secretPatterns) {
    redacted = redacted.replace(pattern, (match, prefix: string | undefined) => {
      if (prefix && /^Bearer\s+/i.test(prefix)) return `${prefix}[REDACTED]`;
      if (prefix && /key|token|password|passwd|secret/i.test(prefix)) return `${prefix}=[REDACTED]`;
      return '[REDACTED]';
    });
  }
  return redacted;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => redactValue(item)) as T;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return Object.fromEntries(entries.map(([key, item]) => [key, redactValue(item)])) as T;
  }
  return value;
}
