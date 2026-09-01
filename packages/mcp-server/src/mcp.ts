import { McpServer, type CallToolResult, type ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  TerminalProtocolError,
  executionProfileSchema,
  terminalListAgentsOutputSchema,
  terminalMutationOutputSchema,
  terminalReadInputSchema,
  terminalReadOutputSchema,
  terminalResizeInputSchema,
  terminalSessionIdInputSchema,
  terminalStartInputSchema,
  terminalStartOutputSchema,
  terminalStatusOutputSchema,
  terminalStreamRefreshInputSchema,
  terminalStreamRefreshOutputSchema,
  terminalWriteInputSchema,
  terminalReadFileInputSchema,
  terminalReadFileOutputSchema,
  terminalListFilesInputSchema,
  terminalListFilesOutputSchema,
  terminalWriteFileInputSchema,
  terminalWriteFileOutputSchema,
  terminalSearchFilesInputSchema,
  terminalSearchFilesOutputSchema,
  terminalTranscriptInputSchema,
  terminalTranscriptOutputSchema,
} from '@terminal/protocol';
import type { ServerConfig } from './config.js';
import type { AgentGateway } from './gateway.js';
import type { TerminalService, RequestIdentity } from './service.js';
import type { StreamTokenService } from './stream-token.js';
import { readTerminalUiDocument } from './ui-runtime.js';

export const TERMINAL_UI_URI = 'ui://terminal/v7.html';
export const TERMINAL_UI_MIME = 'text/html;profile=mcp-app';

const terminalStartViewOutputSchema = terminalStartOutputSchema.extend({
  agent_id: z.string(),
  agent_name: z.string(),
  cwd: z.string(),
  shell: z.string(),
  exit_code: z.number().int().nullable(),
});

export interface McpServerDependencies {
  config: ServerConfig;
  gateway: AgentGateway;
  service: TerminalService;
  streamTokens: StreamTokenService;
}

export function createTerminalMcpServer(deps: McpServerDependencies): McpServer {
  const server = new McpServer({ name: 'chatgpt-terminal-plugin', version: '0.7.0' });

  server.registerResource(
    'Live terminal',
    TERMINAL_UI_URI,
    {
      title: 'Live Terminal',
      description: 'Static-first live terminal viewer for an authenticated local-agent PTY session.',
      mimeType: TERMINAL_UI_MIME,
    },
    async () => ({
      contents: [{
        uri: TERMINAL_UI_URI,
        mimeType: TERMINAL_UI_MIME,
        text: (await readTerminalUiDocument()).html,
        _meta: {
          ui: {
            prefersBorder: true,
            domain: deps.config.publicUrl.origin,
            csp: { connectDomains: [deps.config.publicUrl.origin] },
          },
          'openai/widgetCSP': {
            connect_domains: [deps.config.publicUrl.origin],
            resource_domains: [],
          },
          'openai/widgetDomain': deps.config.publicUrl.origin,
        },
      }],
    }),
  );

  server.registerTool(
    'terminal_list_agents',
    {
      title: 'List terminal computers',
      description: 'List local computers currently connected to this authenticated user.',
      outputSchema: terminalListAgentsOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (ctx) => resultFrom(() => deps.service.listAgents(identityFromContext(ctx))),
  );

  server.registerTool(
    'terminal_start',
    {
      title: 'Start terminal session',
      description: 'Create a persistent PTY terminal on a selected local computer. An optional initial command may execute immediately.',
      inputSchema: terminalStartInputSchema,
      outputSchema: terminalStartViewOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: {
        ui: { resourceUri: TERMINAL_UI_URI },
        'openai/outputTemplate': TERMINAL_UI_URI,
      },
    },
    async (input, ctx) => {
      try {
        const identity = identityFromContext(ctx);
        const started = await deps.service.start(identity, input);
        const record = deps.gateway.getSessionForUser(identity.userId, started.session_id);
        if (!record.session) throw new TerminalProtocolError('SESSION_NOT_FOUND', 'Terminal session metadata was not found.');
        const agent = deps.gateway.listAgents(identity.userId).find((candidate) => candidate.agent_id === record.session!.agent_id);
        const stream = deps.streamTokens.issue(identity.userId, started.session_id);
        const streamUrl = new URL(`/terminal/${encodeURIComponent(started.session_id)}/events`, deps.config.publicUrl);
        streamUrl.searchParams.set('token', stream.token);
        streamUrl.searchParams.set('after', String(started.cursor));
        const output = terminalStartViewOutputSchema.parse({
          ...started,
          agent_id: record.session.agent_id,
          agent_name: agent?.display_name ?? record.session.agent_id,
          cwd: record.session.cwd,
          shell: record.session.shell,
          exit_code: record.session.exit_code,
        });
        return successResult(output, {
          terminal_stream: { url: streamUrl.href, expires_at: stream.expiresAt },
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'terminal_read',
    {
      title: 'Read terminal output',
      description: 'Read bounded terminal events after a monotonic cursor. Use repeatedly for long-running commands.',
      inputSchema: terminalReadInputSchema,
      outputSchema: terminalReadOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ['model', 'app'] }, 'openai/widgetAccessible': true },
    },
    async (input, ctx) => resultFrom(() => deps.service.read(identityFromContext(ctx), input)),
  );

  server.registerTool(
    'terminal_write',
    {
      title: 'Write terminal input',
      description: 'Write text or commands to an existing PTY. Input can mutate the local computer and interact with external systems.',
      inputSchema: terminalWriteInputSchema,
      outputSchema: terminalMutationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (input, ctx) => resultFrom(() => deps.service.write(identityFromContext(ctx), input)),
  );

  server.registerTool(
    'terminal_resize',
    {
      title: 'Resize terminal',
      description: 'Change PTY terminal rows and columns.',
      inputSchema: terminalResizeInputSchema,
      outputSchema: terminalMutationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input, ctx) => resultFrom(() => deps.service.resize(identityFromContext(ctx), input)),
  );

  server.registerTool(
    'terminal_interrupt',
    {
      title: 'Interrupt terminal process',
      description: 'Send Ctrl+C/SIGINT to the foreground process in a terminal session.',
      inputSchema: terminalSessionIdInputSchema,
      outputSchema: terminalMutationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input, ctx) => resultFrom(() => deps.service.interrupt(identityFromContext(ctx), input.session_id)),
  );

  server.registerTool(
    'terminal_status',
    {
      title: 'Get terminal status',
      description: 'Return terminal session metadata and current agent connection state.',
      inputSchema: terminalSessionIdInputSchema,
      outputSchema: terminalStatusOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ['model', 'app'] }, 'openai/widgetAccessible': true },
    },
    async (input, ctx) => resultFrom(() => deps.service.status(identityFromContext(ctx), input.session_id)),
  );

  server.registerTool(
    'terminal_stream_refresh',
    {
      title: 'Refresh terminal stream',
      description: 'Issue a new short-lived, read-only stream capability for an existing terminal session.',
      inputSchema: terminalStreamRefreshInputSchema,
      outputSchema: terminalStreamRefreshOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true },
    },
    (input, ctx) => {
      try {
        const identity = identityFromContext(ctx);
        const record = deps.gateway.getSessionForUser(identity.userId, input.session_id);
        if (!record.session) throw new TerminalProtocolError('SESSION_NOT_FOUND', 'Terminal session metadata was not found.');
        const stream = deps.streamTokens.issue(identity.userId, input.session_id);
        const streamUrl = new URL(`/terminal/${encodeURIComponent(input.session_id)}/events`, deps.config.publicUrl);
        streamUrl.searchParams.set('token', stream.token);
        if (input.after < record.earliestSequence - 1 || input.after > record.latestSequence) {
          throw new TerminalProtocolError('INVALID_CURSOR', 'Stream refresh cursor is outside the retained event range.');
        }
        streamUrl.searchParams.set('after', String(input.after));
        const output = terminalStreamRefreshOutputSchema.parse({ session_id: input.session_id, expires_at: stream.expiresAt });
        return successResult(output, { terminal_stream: { url: streamUrl.href, expires_at: stream.expiresAt } });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'terminal_close',
    {
      title: 'Close terminal session',
      description: 'Terminate and dispose a persistent PTY terminal session.',
      inputSchema: terminalSessionIdInputSchema,
      outputSchema: terminalMutationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input, ctx) => resultFrom(() => deps.service.close(identityFromContext(ctx), input.session_id)),
  );

  server.registerTool(
    'terminal_session_transcript',
    {
      title: 'Get session transcript',
      description: 'Return a structured chronological transcript of a terminal session: commands sent, terminal output, errors, and status changes. Use this to understand what happened in a session without re-reading raw terminal output. Supports pagination via after_sequence for long sessions. Set include_output to false to get only commands and status events.',
      inputSchema: terminalTranscriptInputSchema,
      outputSchema: terminalTranscriptOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input, ctx) => resultFrom(async () => {
      const result = await deps.service.transcript(identityFromContext(ctx), input);
      return terminalTranscriptOutputSchema.parse(result);
    }),
  );

  // --- File operation tools ---

  server.registerTool(
    'terminal_read_file',
    {
      title: 'Read a file',
      description: 'Read the contents of a file within the workspace of an active terminal session. The file path is resolved relative to the session current working directory. Paths outside configured workspace roots are rejected.',
      inputSchema: terminalReadFileInputSchema,
      outputSchema: terminalReadFileOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input, ctx) => resultFrom(async () => {
      const result = await deps.service.readFile(identityFromContext(ctx), input);
      return terminalReadFileOutputSchema.parse(result);
    }),
  );

  server.registerTool(
    'terminal_list_files',
    {
      title: 'List directory contents',
      description: 'List files and directories at a path within the workspace of an active terminal session. Returns name, type (file/directory/symlink), size, and modification timestamp for each entry.',
      inputSchema: terminalListFilesInputSchema,
      outputSchema: terminalListFilesOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input, ctx) => resultFrom(async () => {
      const result = await deps.service.listFiles(identityFromContext(ctx), input);
      return terminalListFilesOutputSchema.parse(result);
    }),
  );

  server.registerTool(
    'terminal_write_file',
    {
      title: 'Write a file',
      description: 'Write content to a file within the workspace of an active terminal session. The file path is resolved relative to the session current working directory. Requires a non-read-only execution profile. Optionally creates parent directories.',
      inputSchema: terminalWriteFileInputSchema,
      outputSchema: terminalWriteFileOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input, ctx) => resultFrom(async () => {
      const result = await deps.service.writeFile(identityFromContext(ctx), input);
      return terminalWriteFileOutputSchema.parse(result);
    }),
  );

  server.registerTool(
    'terminal_search_files',
    {
      title: 'Search files',
      description: 'Search for a regex pattern across files in the workspace of an active terminal session. Returns matching lines with file paths and line numbers. Supports file type filtering (e.g. include: "*.ts") and optional context lines around each match. Much faster than running grep through the terminal and returns structured results.',
      inputSchema: terminalSearchFilesInputSchema,
      outputSchema: terminalSearchFilesOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input, ctx) => resultFrom(async () => {
      const result = await deps.service.searchFiles(identityFromContext(ctx), { ...input, ...(input.include === undefined ? {} : { include: input.include }) });
      return terminalSearchFilesOutputSchema.parse(result);
    }),
  );

  return server;
}

function identityFromContext(ctx: ServerContext): RequestIdentity {
  const auth = ctx.http?.authInfo;
  if (!auth) throw new TerminalProtocolError('PERMISSION_DENIED', 'Authenticated MCP context is required.');
  const userId = typeof auth.extra?.user_id === 'string' ? auth.extra.user_id : undefined;
  if (!userId) throw new TerminalProtocolError('PERMISSION_DENIED', 'Access token is missing a user identity.');
  const executionProfile = executionProfileSchema.safeParse(auth.extra?.execution_profile);
  if (!executionProfile.success) {
    throw new TerminalProtocolError('PERMISSION_DENIED', 'Access token is missing a valid execution profile.');
  }
  const chatgptSessionId = typeof auth.extra?.chatgpt_session_id === 'string' ? auth.extra.chatgpt_session_id : undefined;
  return {
    userId,
    clientId: auth.clientId,
    executionProfile: executionProfile.data,
    ...(chatgptSessionId ? { chatgptSessionId } : {}),
  };
}

async function resultFrom<T extends Record<string, unknown>>(operation: () => Promise<T>): Promise<CallToolResult> {
  try {
    return successResult(await operation());
  } catch (error) {
    return errorResult(error);
  }
}

function successResult<T extends Record<string, unknown>>(output: T, meta?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(output) }],
    structuredContent: output,
    ...(meta ? { _meta: meta } : {}),
  };
}

function errorResult(error: unknown): CallToolResult {
  if (error instanceof TerminalProtocolError) {
    const payload = error.toPayload();
    return {
      isError: true,
      content: [{ type: 'text', text: `${payload.code}: ${payload.message}` }],
      _meta: { terminal_error: payload },
    };
  }
  return {
    isError: true,
    content: [{ type: 'text', text: 'INTERNAL_ERROR: Unexpected terminal server error.' }],
  };
}
