import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { deviceEnrollmentOutputSchema, gatewayChallengePayload, type GatewayAuthChallenge } from '@terminal/protocol';
import { parseEnrollmentUrl } from './transport-security.js';

const identitySchema = z.object({
  version: z.literal(1),
  device_id: z.string().min(1),
  agent_id: z.string().min(1),
  public_key: z.string().min(32),
  private_key: z.string().min(32),
  created_at: z.string().datetime(),
  rotated_at: z.string().datetime().optional(),
});

export type DeviceIdentityData = z.infer<typeof identitySchema>;

const preparedRotationSchema = z.object({
  version: z.literal(1),
  base_public_key: z.string().min(32),
  identity: identitySchema,
});

export class DeviceIdentity {
  constructor(
    private readonly path: string,
    private data: DeviceIdentityData,
    private readonly preparedRotation?: { path: string; basePublicKey: string },
  ) {}

  static async loadOrCreate(path: string, rotate = false): Promise<DeviceIdentity> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let data: DeviceIdentityData | undefined;
    try {
      data = identitySchema.parse(JSON.parse(await readFile(path, 'utf8')));
      await chmod(path, 0o600);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }

    if (!data) {
      data = createIdentity();
      await writeIdentity(path, data);
    } else if (rotate) {
      const rotated = createKeyMaterial();
      data = {
        ...data,
        public_key: rotated.publicKey,
        private_key: rotated.privateKey,
        rotated_at: new Date().toISOString(),
      };
      await writeIdentity(path, data);
    }

    return new DeviceIdentity(path, data);
  }

  static async prepareRotation(path: string): Promise<DeviceIdentity> {
    const current = await DeviceIdentity.loadOrCreate(path);
    const preparedPath = `${path}.rotation`;
    try {
      const prepared = preparedRotationSchema.parse(JSON.parse(await readFile(preparedPath, 'utf8')));
      await chmod(preparedPath, 0o600);
      if (prepared.identity.device_id !== current.deviceId || prepared.identity.agent_id !== current.agentId) {
        throw new Error('Prepared device rotation does not match the active device identity.');
      }
      if (prepared.base_public_key !== current.publicKey) {
        throw new Error('Prepared device rotation is stale because the active device key changed.');
      }
      return new DeviceIdentity(path, prepared.identity, { path: preparedPath, basePublicKey: prepared.base_public_key });
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }

    const rotated = createKeyMaterial();
    const data: DeviceIdentityData = {
      ...current.data,
      public_key: rotated.publicKey,
      private_key: rotated.privateKey,
      rotated_at: new Date().toISOString(),
    };
    await writePreparedRotation(preparedPath, current.publicKey, data);
    return new DeviceIdentity(path, data, { path: preparedPath, basePublicKey: current.publicKey });
  }

  async commitPreparedRotation(): Promise<void> {
    if (!this.preparedRotation) throw new Error('Device identity is not a prepared rotation.');
    const current = await DeviceIdentity.loadOrCreate(this.path);
    if (current.deviceId !== this.deviceId || current.agentId !== this.agentId) {
      throw new Error('Active device identity changed before the prepared rotation could be committed.');
    }
    if (current.publicKey !== this.preparedRotation.basePublicKey) {
      throw new Error('Active device key changed before the prepared rotation could be committed.');
    }
    await writeIdentity(this.path, this.data);
    await rm(this.preparedRotation.path, { force: true });
  }

  get deviceId(): string { return this.data.device_id; }
  get agentId(): string { return this.data.agent_id; }
  get publicKey(): string { return this.data.public_key; }
  get identityPath(): string { return this.path; }

  signChallenge(challenge: GatewayAuthChallenge): string {
    const payload = gatewayChallengePayload(this.deviceId, challenge.nonce, challenge.issued_at);
    return sign(null, Buffer.from(payload, 'utf8'), this.data.private_key).toString('base64url');
  }
}

export async function enrollDevice(options: {
  identity: DeviceIdentity;
  enrollmentUrl: string;
  enrollmentToken: string;
  ownerId: string;
  displayName?: string;
}): Promise<'enrolled' | 'rotated'> {
  const enrollmentUrl = parseEnrollmentUrl(options.enrollmentUrl);
  const response = await fetch(enrollmentUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-terminal-enrollment-token': options.enrollmentToken,
    },
    body: JSON.stringify({
      device_id: options.identity.deviceId,
      agent_id: options.identity.agentId,
      owner_id: options.ownerId,
      public_key: options.identity.publicKey,
      ...(options.displayName ? { display_name: options.displayName } : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(`Device enrollment failed with HTTP ${response.status}.`);
  }
  return deviceEnrollmentOutputSchema.parse(await response.json()).status;
}

function createIdentity(): DeviceIdentityData {
  const keys = createKeyMaterial();
  const now = new Date().toISOString();
  const deviceId = `device-${randomUUID()}`;
  return {
    version: 1,
    device_id: deviceId,
    agent_id: `agent-${deviceId.slice('device-'.length)}`,
    public_key: keys.publicKey,
    private_key: keys.privateKey,
    created_at: now,
  };
}

function createKeyMaterial(): { publicKey: string; privateKey: string } {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { publicKey, privateKey };
}

async function writeIdentity(path: string, data: DeviceIdentityData): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function writePreparedRotation(path: string, basePublicKey: string, identity: DeviceIdentityData): Promise<void> {
  const temporary = `${path}.tmp`;
  const payload = { version: 1 as const, base_public_key: basePublicKey, identity };
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
