import { appendFile } from 'node:fs/promises';

export class AuditLogger {
  private readonly path: string | undefined;

  constructor(path?: string) {
    this.path = path;
  }

  log(record: Record<string, unknown>): void {
    if (!this.path) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
    // Fire-and-forget: audit writes must not block the main path
    appendFile(this.path, line, 'utf8').catch((error) => {
      console.error(JSON.stringify({ level: 'error', event: 'audit.write_failed', error: error instanceof Error ? error.message : String(error) }));
    });
  }
}
