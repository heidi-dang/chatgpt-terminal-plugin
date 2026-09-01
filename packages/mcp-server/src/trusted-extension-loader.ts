import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/server';
import { TerminalProtocolError } from '@terminal/protocol';
import type { AuditLogger } from './audit.js';
import type { RequestIdentity } from './service.js';

const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const EXTENSION_SUFFIXES = ['.mjs', '.js'] as const;

export interface TrustedExtensionRegistration {
  remove(): void;
}

export interface TrustedExtensionRegistrar {
  registerTool(name: string, config: unknown, handler: unknown): TrustedExtensionRegistration;
  registerPrompt(name: string, config: unknown, handler: unknown): TrustedExtensionRegistration;
  registerResource(name: string, uriOrTemplate: unknown, config: unknown, handler: unknown): TrustedExtensionRegistration;
}

interface LoadedExtension {
  registrations: TrustedExtensionRegistration[];
}

interface ExtensionModule {
  default: (registrar: TrustedExtensionRegistrar) => unknown;
}

export class TrustedExtensionLoader {
  private readonly loaded = new Map<string, LoadedExtension>();
  private readonly reloadTails = new Map<string, Promise<void>>();

  constructor(
    private readonly root: string,
    private readonly maxBytes: number,
    private readonly registrar: TrustedExtensionRegistrar,
    private readonly audit: AuditLogger,
  ) {
    if (!isAbsolute(root)) throw new Error('Trusted extension root must be absolute.');
  }

  async reload(identity: RequestIdentity, extensionId: string): Promise<{
    extension_id: string;
    status: 'loaded';
    registration_count: number;
  }> {
    if (identity.executionProfile !== 'owner-full') {
      const error = new TerminalProtocolError('PERMISSION_DENIED', 'Trusted extension reload requires owner-full execution.');
      await this.record(identity, extensionId, 'deny', error.code);
      throw error;
    }

    if (!EXTENSION_ID_PATTERN.test(extensionId)) {
      const error = new TerminalProtocolError('INVALID_ARGUMENT', 'Extension id must contain only lowercase letters, digits, hyphens, and underscores.');
      await this.record(identity, extensionId, 'deny', error.code);
      throw error;
    }

    return this.enqueueReload(extensionId, async () => {
      try {
        const extensionPath = await this.resolveExtensionPath(extensionId);
      const moduleValue: unknown = await import(`${pathToFileURL(extensionPath).href}?reload=${randomUUID()}`);
      const module = this.parseModule(moduleValue, extensionId);

      const previous = this.loaded.get(extensionId);
      if (previous) removeRegistrations(previous.registrations);

      const nextRegistrations: TrustedExtensionRegistration[] = [];
      const transaction = createRegistrationTransaction(this.registrar, nextRegistrations);
      try {
        await module.default(transaction.registrar);
      } catch {
        removeRegistrations(nextRegistrations);
        this.loaded.delete(extensionId);
        throw new TerminalProtocolError('INVALID_ARGUMENT', `Trusted extension '${extensionId}' failed during registration.`);
      } finally {
        transaction.seal();
      }

      this.loaded.set(extensionId, { registrations: nextRegistrations });
      const output = {
        extension_id: extensionId,
        status: 'loaded' as const,
        registration_count: nextRegistrations.length,
      };
      await this.audit.record({
        ...auditIdentity(identity),
        action: 'terminal_reload_agent',
        authorization: 'allow',
        input: { extension_id: extensionId },
        output_metadata: { registration_count: nextRegistrations.length },
      });
        return output;
      } catch (error) {
        const normalized = normalizeExtensionError(error, extensionId);
        await this.record(identity, extensionId, 'deny', normalized.code);
        throw normalized;
      }
    });
  }

  private async enqueueReload<T>(extensionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.reloadTails.get(extensionId) ?? Promise.resolve();
    const current = previous.then(operation);
    const tail = current.then(() => undefined, () => undefined);
    this.reloadTails.set(extensionId, tail);
    try {
      return await current;
    } finally {
      if (this.reloadTails.get(extensionId) === tail) this.reloadTails.delete(extensionId);
    }
  }

  private async resolveExtensionPath(extensionId: string): Promise<string> {
    let rootStat;
    try {
      rootStat = await lstat(this.root);
    } catch {
      throw new TerminalProtocolError('INVALID_ARGUMENT', 'Configured trusted extension root is unavailable.');
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new TerminalProtocolError('PATH_NOT_ALLOWED', 'Configured trusted extension root must be a regular directory, not a symlink.');
    }
    const canonicalRoot = await realpath(this.root);
    const matches: Array<{ path: string; size: number }> = [];

    for (const suffix of EXTENSION_SUFFIXES) {
      const candidate = join(this.root, `${extensionId}${suffix}`);
      try {
        const stat = await lstat(candidate);
        if (stat.isSymbolicLink()) {
          throw new TerminalProtocolError('PATH_NOT_ALLOWED', 'Trusted extension files must not be symbolic links.');
        }
        if (!stat.isFile()) {
          throw new TerminalProtocolError('PATH_NOT_ALLOWED', 'Trusted extension must be a regular file.');
        }
        matches.push({ path: candidate, size: stat.size });
      } catch (error) {
        if (isMissingFile(error)) continue;
        throw error;
      }
    }

    if (matches.length === 0) throw new TerminalProtocolError('FILE_NOT_FOUND', `Trusted extension '${extensionId}' was not found.`);
    if (matches.length > 1) throw new TerminalProtocolError('INVALID_ARGUMENT', `Trusted extension '${extensionId}' is ambiguous because both .js and .mjs files exist.`);
    const match = matches[0];
    if (!match) throw new TerminalProtocolError('FILE_NOT_FOUND', `Trusted extension '${extensionId}' was not found.`);
    if (match.size > this.maxBytes) throw new TerminalProtocolError('FILE_TOO_LARGE', `Trusted extension '${extensionId}' exceeds the configured byte limit.`);

    const canonicalPath = await realpath(match.path);
    const fromRoot = relative(canonicalRoot, canonicalPath);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new TerminalProtocolError('PATH_NOT_ALLOWED', 'Trusted extension resolved outside the configured root.');
    }
    return canonicalPath;
  }

  private parseModule(value: unknown, extensionId: string): ExtensionModule {
    if (!value || typeof value !== 'object' || !('default' in value)) {
      throw new TerminalProtocolError('INVALID_ARGUMENT', `Trusted extension '${extensionId}' must default-export a registration function.`);
    }
    const registration = (value as { default?: unknown }).default;
    if (typeof registration !== 'function') {
      throw new TerminalProtocolError('INVALID_ARGUMENT', `Trusted extension '${extensionId}' must default-export a registration function.`);
    }
    return { default: registration as ExtensionModule['default'] };
  }

  private async record(
    identity: RequestIdentity,
    extensionId: string,
    authorization: 'allow' | 'deny',
    errorCode?: string,
  ): Promise<void> {
    await this.audit.record({
      ...auditIdentity(identity),
      action: 'terminal_reload_agent',
      authorization,
      input: { extension_id: extensionId },
      ...(errorCode ? { error_code: errorCode } : {}),
    });
  }
}

export function createTrustedExtensionRegistrar(server: McpServer): TrustedExtensionRegistrar {
  const registerTool = server.registerTool.bind(server);
  const registerPrompt = server.registerPrompt.bind(server);
  const registerResource = server.registerResource.bind(server);
  return {
    registerTool: (name, config, handler) => Reflect.apply(registerTool, undefined, [name, config, handler]) as TrustedExtensionRegistration,
    registerPrompt: (name, config, handler) => Reflect.apply(registerPrompt, undefined, [name, config, handler]) as TrustedExtensionRegistration,
    registerResource: (name, uriOrTemplate, config, handler) => Reflect.apply(registerResource, undefined, [name, uriOrTemplate, config, handler]) as TrustedExtensionRegistration,
  };
}

function createRegistrationTransaction(
  registrar: TrustedExtensionRegistrar,
  registrations: TrustedExtensionRegistration[],
): { registrar: TrustedExtensionRegistrar; seal(): void } {
  let active = true;
  const track = (register: () => TrustedExtensionRegistration): TrustedExtensionRegistration => {
    if (!active) throw new TerminalProtocolError('PERMISSION_DENIED', 'Trusted extension registration window is closed.');
    const registration = register();
    registrations.push(registration);
    return registration;
  };
  return {
    registrar: {
      registerTool: (name, config, handler) => track(() => registrar.registerTool(name, config, handler)),
      registerPrompt: (name, config, handler) => track(() => registrar.registerPrompt(name, config, handler)),
      registerResource: (name, uriOrTemplate, config, handler) => track(() => registrar.registerResource(name, uriOrTemplate, config, handler)),
    },
    seal: () => { active = false; },
  };
}

function removeRegistrations(registrations: TrustedExtensionRegistration[]): void {
  for (const registration of [...registrations].reverse()) registration.remove();
}

function normalizeExtensionError(error: unknown, extensionId: string): TerminalProtocolError {
  if (error instanceof TerminalProtocolError) return error;
  return new TerminalProtocolError('INVALID_ARGUMENT', `Trusted extension '${extensionId}' could not be loaded.`);
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function auditIdentity(identity: RequestIdentity): {
  user_id: string;
  client_id?: string;
  chatgpt_session_id?: string;
} {
  return {
    user_id: identity.userId,
    ...(identity.clientId ? { client_id: identity.clientId } : {}),
    ...(identity.chatgptSessionId ? { chatgpt_session_id: identity.chatgptSessionId } : {}),
  };
}
