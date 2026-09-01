import { stat } from 'node:fs/promises';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

const bundlePath = fileURLToPath(new URL('../packages/terminal-ui/dist/index.html', import.meta.url));
const configuredLimit = process.env.TERMINAL_UI_MAX_BUNDLE_BYTES ?? '30000';
const maxBytes = Number.parseInt(configuredLimit, 10);

if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
  throw new Error(`TERMINAL_UI_MAX_BUNDLE_BYTES must be a positive integer, received: ${configuredLimit}`);
}

const info = await stat(bundlePath);
if (info.size > maxBytes) {
  throw new Error(`Terminal UI bundle is ${info.size} bytes, exceeding the ${maxBytes}-byte mobile budget.`);
}

process.stdout.write(`Terminal UI bundle budget: ${info.size}/${maxBytes} bytes\n`);
