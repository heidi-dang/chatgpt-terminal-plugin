import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { TerminalProtocolError } from '@terminal/protocol';

const payloadSchema = z.object({
  v: z.literal(1),
  jti: z.string().uuid(),
  sub: z.string().min(1),
  sid: z.string().min(1),
  scope: z.literal('terminal.stream'),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
});

export type StreamTokenPayload = z.infer<typeof payloadSchema>;

export class StreamTokenService {
  private readonly revoked = new Map<string, number>();

  constructor(
    private readonly secret: string,
    private readonly ttlSeconds: number,
  ) {
    if (Buffer.byteLength(secret) < 16) throw new Error('Stream token secret must be at least 16 bytes.');
  }

  issue(userId: string, sessionId: string): { token: string; expiresAt: string } {
    const now = Math.floor(Date.now() / 1000);
    this.pruneRevoked(now);
    const payload: StreamTokenPayload = {
      v: 1,
      jti: randomUUID(),
      sub: userId,
      sid: sessionId,
      scope: 'terminal.stream',
      iat: now,
      exp: now + this.ttlSeconds,
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = this.sign(body);
    return {
      token: `${body}.${signature}`,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    };
  }

  verify(token: string, sessionId: string): StreamTokenPayload {
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra) throw expired();
    const expected = this.sign(body);
    const providedBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    if (providedBytes.length !== expectedBytes.length || !timingSafeEqual(providedBytes, expectedBytes)) throw expired();

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      throw expired();
    }
    const payload = payloadSchema.safeParse(parsed);
    if (!payload.success) throw expired();
    const now = Math.floor(Date.now() / 1000);
    this.pruneRevoked(now);
    if (payload.data.sid !== sessionId || payload.data.exp <= now || this.revoked.has(payload.data.jti)) {
      throw expired();
    }
    return payload.data;
  }

  revoke(token: string): void {
    const [body] = token.split('.');
    if (!body) return;
    try {
      const payload = payloadSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
      const now = Math.floor(Date.now() / 1000);
      this.pruneRevoked(now);
      if (payload.exp > now) this.revoked.set(payload.jti, payload.exp);
    } catch {
      // Invalid tokens have no active capability to revoke.
    }
  }

  private pruneRevoked(now: number): void {
    for (const [jti, expiry] of this.revoked) {
      if (expiry <= now) this.revoked.delete(jti);
    }
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }
}

function expired(): TerminalProtocolError {
  return new TerminalProtocolError('STREAM_TOKEN_EXPIRED', 'Terminal stream token is invalid or expired.');
}
