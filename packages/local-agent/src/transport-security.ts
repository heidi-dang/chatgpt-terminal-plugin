import { isIP } from 'node:net';

export function parseGatewayUrl(value: string): URL {
  const url = parseUrl(value, 'AGENT_GATEWAY_URL');
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('AGENT_GATEWAY_URL must use ws:// or wss://.');
  }
  if (url.protocol === 'ws:' && !isLoopbackHostname(url.hostname)) {
    throw new Error('AGENT_GATEWAY_URL must use wss:// unless it targets loopback.');
  }
  return url;
}

export function parseEnrollmentUrl(value: string): URL {
  const url = parseUrl(value, 'AGENT_ENROLLMENT_URL');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('AGENT_ENROLLMENT_URL must use http:// or https://.');
  }
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    throw new Error('AGENT_ENROLLMENT_URL must use https:// unless it targets loopback.');
  }
  return url;
}

function parseUrl(value: string, name: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1).toLowerCase()
    : hostname.toLowerCase();
  if (normalized === 'localhost') return true;
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return normalized.split('.')[0] === '127';
  if (ipVersion === 6) return normalized === '::1';
  return false;
}
