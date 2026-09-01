import { readFile } from 'node:fs/promises';
import { stdin } from 'node:process';
import { DeviceRegistry } from './device-registry.js';
import type { DeviceEnrollmentRequest } from '@terminal/protocol';

async function readInput(path: string): Promise<DeviceEnrollmentRequest> {
  const text = path === '-'
    ? await new Promise<string>((resolve, reject) => {
        let data = '';
        stdin.setEncoding('utf8');
        stdin.on('data', (chunk: string) => { data += chunk; });
        stdin.once('end', () => resolve(data));
        stdin.once('error', reject);
      })
    : await readFile(path, 'utf8');
  return JSON.parse(text) as DeviceEnrollmentRequest;
}

const [command, registryPath, inputPath] = process.argv.slice(2);
if (command !== 'enroll' || !registryPath || !inputPath) {
  console.error('Usage: node dist/admin.js enroll <device-registry-path> <record-json-path|->');
  process.exitCode = 2;
} else {
  const registry = await DeviceRegistry.load(registryPath);
  const result = await registry.enrollLocalAdmin(await readInput(inputPath));
  console.log(JSON.stringify({
    status: result.status,
    device_id: result.record.device_id,
    agent_id: result.record.agent_id,
    owner_id: result.record.owner_id,
    display_name: result.record.display_name,
    key_version: result.record.key_version,
  }));
}
