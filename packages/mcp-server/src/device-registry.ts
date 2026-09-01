import { createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { TerminalProtocolError, deviceEnrollmentRequestSchema, type DeviceEnrollmentRequest } from '@terminal/protocol';

const deviceRecordSchema = z.object({
  device_id: z.string().min(1),
  agent_id: z.string().min(1),
  owner_id: z.string().min(1),
  public_key: z.string().min(32),
  display_name: z.string().min(1).optional(),
  status: z.enum(['active', 'revoked']),
  key_version: z.number().int().positive(),
  enrolled_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  last_seen_at: z.string().datetime().optional(),
  revoked_at: z.string().datetime().optional(),
});
export type DeviceRecord = z.infer<typeof deviceRecordSchema>;

const legacyDeviceRecordSchema = deviceRecordSchema.omit({ agent_id: true });
const registrySchema = z.union([
  z.object({ version: z.literal(1), devices: z.array(legacyDeviceRecordSchema) }),
  z.object({ version: z.literal(2), devices: z.array(deviceRecordSchema) }),
]);

export class DeviceRegistry {
  private readonly devices = new Map<string, DeviceRecord>();

  private constructor(
    private readonly path: string | undefined,
    private readonly enrollmentToken: string | undefined,
  ) {}

  static async load(path?: string, enrollmentToken?: string): Promise<DeviceRegistry> {
    const registry = new DeviceRegistry(path, enrollmentToken);
    if (!path) return registry;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      const parsed = registrySchema.parse(JSON.parse(await readFile(path, 'utf8')));
      if (parsed.version === 1) {
        for (const record of parsed.devices) {
          registry.devices.set(record.device_id, { ...record, agent_id: legacyAgentId(record.device_id) });
        }
        await registry.persist();
      } else {
        for (const record of parsed.devices) registry.devices.set(record.device_id, record);
      }
      await chmod(path, 0o600);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      await registry.persist();
    }
    return registry;
  }

  get(deviceId: string): DeviceRecord | undefined {
    const record = this.devices.get(deviceId);
    return record ? { ...record } : undefined;
  }

  requireActive(deviceId: string): DeviceRecord {
    const record = this.devices.get(deviceId);
    if (!record || record.status !== 'active') {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'Device is not enrolled or has been revoked.');
    }
    return record;
  }

  async enroll(raw: DeviceEnrollmentRequest, presentedToken: string | undefined): Promise<{ record: DeviceRecord; status: 'enrolled' | 'rotated' }> {
    this.assertEnrollmentToken(presentedToken);
    return this.upsertValidated(raw);
  }

  async enrollLocalAdmin(raw: DeviceEnrollmentRequest): Promise<{ record: DeviceRecord; status: 'enrolled' | 'rotated' }> {
    return this.upsertValidated(raw);
  }

  private async upsertValidated(raw: DeviceEnrollmentRequest): Promise<{ record: DeviceRecord; status: 'enrolled' | 'rotated' }> {
    const input = deviceEnrollmentRequestSchema.parse(raw);
    createPublicKey(input.public_key);
    const existing = this.devices.get(input.device_id);
    if (existing && existing.owner_id !== input.owner_id) {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'Device ownership cannot be changed by enrollment.');
    }
    if (existing && existing.agent_id !== input.agent_id) {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'Device agent identity cannot be changed by enrollment.');
    }

    const now = new Date().toISOString();
    const status = existing ? 'rotated' : 'enrolled';
    const record: DeviceRecord = {
      device_id: input.device_id,
      agent_id: input.agent_id,
      owner_id: input.owner_id,
      public_key: input.public_key,
      ...(input.display_name ? { display_name: input.display_name } : existing?.display_name ? { display_name: existing.display_name } : {}),
      status: 'active',
      key_version: (existing?.key_version ?? 0) + 1,
      enrolled_at: existing?.enrolled_at ?? now,
      updated_at: now,
      ...(existing?.last_seen_at ? { last_seen_at: existing.last_seen_at } : {}),
    };
    this.devices.set(record.device_id, record);
    await this.persist();
    return { record: { ...record }, status };
  }

  async revoke(deviceId: string, presentedToken: string | undefined): Promise<void> {
    this.assertEnrollmentToken(presentedToken);
    const current = this.devices.get(deviceId);
    if (!current) return;
    const now = new Date().toISOString();
    this.devices.set(deviceId, { ...current, status: 'revoked', revoked_at: now, updated_at: now });
    await this.persist();
  }

  async markSeen(deviceId: string): Promise<void> {
    const current = this.devices.get(deviceId);
    if (!current || current.status !== 'active') return;
    const now = new Date().toISOString();
    this.devices.set(deviceId, { ...current, last_seen_at: now, updated_at: now });
    await this.persist();
  }

  verifyProof(deviceId: string, payload: string, signatureBase64Url: string): DeviceRecord {
    const record = this.requireActive(deviceId);
    let signature: Buffer;
    try {
      signature = Buffer.from(signatureBase64Url, 'base64url');
    } catch {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'Device signature is malformed.');
    }
    const valid = verify(null, Buffer.from(payload, 'utf8'), createPublicKey(record.public_key), signature);
    if (!valid) throw new TerminalProtocolError('PERMISSION_DENIED', 'Device signature verification failed.');
    return record;
  }

  private assertEnrollmentToken(presented: string | undefined): void {
    if (!this.enrollmentToken) throw new TerminalProtocolError('PERMISSION_DENIED', 'Device enrollment is disabled.');
    if (!presented) throw new TerminalProtocolError('PERMISSION_DENIED', 'Device enrollment token is required.');
    const expected = Buffer.from(this.enrollmentToken);
    const actual = Buffer.from(presented);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new TerminalProtocolError('PERMISSION_DENIED', 'Device enrollment token is invalid.');
    }
  }

  private async persist(): Promise<void> {
    if (!this.path) return;
    const temporary = `${this.path}.tmp`;
    const payload = registrySchema.parse({ version: 2, devices: [...this.devices.values()] });
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }
}

function legacyAgentId(deviceId: string): string {
  return deviceId.startsWith('device-') ? `agent-${deviceId.slice('device-'.length)}` : `agent-${deviceId}`;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
