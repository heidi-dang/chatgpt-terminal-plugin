import { randomUUID } from 'node:crypto';
import { McpServer, type CallToolResult, type ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  TerminalProtocolError,
  executionProfileSchema,
  terminalListAgentsOutputSchema,
  codeCancelOutputSchema,
  codeExecuteOutputSchema,
  lspRequestOutputSchema,
  lspStartOutputSchema,
  lspStopOutputSchema,
  terminalCancelCodeToolSchema,
  terminalExecuteCodeBlockToolSchema,
  terminalLspRequestSchema,
  terminalLspStartSchema,
  terminalLspStopSchema,
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
  terminalWorkspaceRootsInputSchema,
  terminalWorkspaceRootMutationInputSchema,
  terminalWorkspaceRootsOutputSchema,
  terminalWriteInputSchema,
  terminalReadFileInputSchema,
  terminalReadFileOutputSchema,
  terminalListFilesInputSchema,
  terminalListFilesOutputSchema,
  terminalWriteFileInputSchema,
  terminalWriteFileOutputSchema,
  terminalDeleteFileInputSchema,
  terminalDeleteFileOutputSchema,
  terminalRenameFileInputSchema,
  terminalRenameFileOutputSchema,
  terminalSearchFilesInputSchema,
  terminalSearchFilesOutputSchema,
  terminalTranscriptInputSchema,
  terminalTranscriptOutputSchema,
  terminalReloadAgentInputSchema,
  terminalReloadAgentOutputSchema,
} from '@terminal/protocol';
import type { AuditLogger } from './audit.js';
import type { ServerConfig } from './config.js';
import type { AgentGateway } from './gateway.js';
import type { TerminalService, RequestIdentity } from './service.js';
import type { StreamTokenService } from './stream-token.js';
import type { TerminalTurnRegistry, TerminalTurnState } from './turn-registry.js';
import { TrustedExtensionLoader, createTrustedExtensionRegistrar } from './trusted-extension-loader.js';
import { readTerminalUiDocument } from './ui-runtime.js';
import {
  DEFAULT_MCP_CODE_OUTPUT_CHARACTERS,
  MAX_MCP_CODE_OUTPUT_CHARACTERS,
  MIN_MCP_CODE_OUTPUT_CHARACTERS,
  boundOutputText,
  createProgressChunkLimiter,
} from './output-bounds.js';

export const TERMINAL_UI_URI = 'ui://terminal/v13.html';
export const TERMINAL_UI_MIME = 'text/html;profile=mcp-app';

const terminalSurfaceInputSchema = z.object({});
const terminalSurfaceCloseInputSchema = z.object({ surface_id: z.string().uuid().optional() });
const terminalSurfaceStatusInputSchema = z.object({ surface_id: z.string().uuid(), session_id: z.string().nullable().optional() });
const terminalStartViewInputSchema = terminalStartInputSchema.extend({ surface_id: z.string().uuid().optional() });
const terminalSurfaceOutputSchema = z.object({
  surface_id: z.string().nullable(),
  surface_open: z.boolean(),
  surface_active: z.boolean(),
  session_id: z.string().nullable(),
  status: z.string().optional(),
  cursor: z.number().int().nonnegative().optional(),
  initial_output: z.string().optional(),
  agent_id: z.string().optional(),
  agent_name: z.string().optional(),
  cwd: z.string().optional(),
  shell: z.string().optional(),
  exit_code: z.number().int().nullable().optional(),
});

const terminalYieldInputSchema = z.object({});
const terminalYieldOutputSchema = z.object({
  continue_current_turn: z.literal(true),
  host_reentry_scheduled: z.literal(false),
  message: z.string(),
});

const terminalExecuteCodeBlockMcpInputSchema = terminalExecuteCodeBlockToolSchema.extend({
  max_output_chars: z.number().int()
    .min(MIN_MCP_CODE_OUTPUT_CHARACTERS)
    .max(MAX_MCP_CODE_OUTPUT_CHARACTERS)
    .default(DEFAULT_MCP_CODE_OUTPUT_CHARACTERS),
});

const terminalExecuteCodeBlockMcpOutputSchema = codeExecuteOutputSchema.extend({
  stdout_truncated: z.boolean(),
  stderr_truncated: z.boolean(),
  stdout_original_characters: z.number().int().nonnegative(),
  stderr_original_characters: z.number().int().nonnegative(),
  stdout_omitted_characters: z.number().int().nonnegative(),
  stderr_omitted_characters: z.number().int().nonnegative(),
});

const terminalStartViewOutputSchema = terminalStartOutputSchema.extend({
  surface_id: z.string().uuid(),
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
  turnRegistry: TerminalTurnRegistry;
  audit: AuditLogger;
}

export function createTerminalMcpServer(deps: McpServerDependencies): McpServer {
  const server = new McpServer({ name: 'chatgpt-terminal-plugin', version: '0.13.0' });

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
    'terminal_surface',
    {
      title: 'Open terminal surface',
      description: 'Call exactly once before any other terminal tool in each assistant turn. Opens the single Terminal UI for this turn and closes any stale PTY from the previous turn. Do not call it again within the same turn.',
      inputSchema: terminalSurfaceInputSchema,
      outputSchema: terminalSurfaceOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: {
        ui: { resourceUri: TERMINAL_UI_URI },
        'openai/outputTemplate': TERMINAL_UI_URI,
      },
    },
    async (_input, ctx) => resultFrom(async () => terminalSurfaceOutputSchema.parse(await deps.turnRegistry.begin(identityFromContext(ctx)))),
  );

  server.registerTool(
    'terminal_surface_status',
    {
      title: 'Read terminal surface state',
      description: 'App-only state sync for the single Terminal UI. Returns the current PTY attached to this exact surface without rendering another UI.',
      inputSchema: terminalSurfaceStatusInputSchema,
      outputSchema: terminalSurfaceOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true },
    },
    async (input, ctx) => resultFrom(async () => {
      const identity = identityFromContext(ctx);
      await deps.turnRegistry.recover(identity, input.surface_id);
      const state = deps.turnRegistry.status(identity, input.surface_id);
      return terminalSurfaceOutputSchema.parse(state.session_id === input.session_id ? state : await terminalSurfaceView(deps, identity, state));
    }),
  );

  server.registerTool(
    'terminal_turn_close',
    {
      title: 'Close terminal turn',
      description: 'Required final Terminal action before the assistant finishes a terminal-using turn. Kills the active PTY and closes this turn surface. Pass surface_id from terminal_surface when available so cleanup can recover safely after an MCP restart.',
      inputSchema: terminalSurfaceCloseInputSchema,
      outputSchema: terminalSurfaceOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ['model'] } },
    },
    async (input, ctx) => resultFrom(async () => {
      const identity = identityFromContext(ctx);
      await deps.turnRegistry.recover(identity, input.surface_id);
      return terminalSurfaceOutputSchema.parse(await deps.turnRegistry.end(identity));
    }),
  );

  server.registerTool(
    'terminal_start',
    {
      title: 'Start terminal session',
      description: 'Start a fresh PTY inside the already-open terminal_surface for this assistant turn. Pass surface_id from terminal_surface when available so the same surface can be recovered after an MCP restart. If another PTY is active in this turn, it is killed first and the same Terminal UI switches to this new stream. Never renders another Terminal UI.',
      inputSchema: terminalStartViewInputSchema,
      outputSchema: terminalStartViewOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (input, ctx) => {
      try {
        const identity = identityFromContext(ctx);
        const { surface_id: surfaceId, ...startInput } = input;
        if (!deps.turnRegistry.current(identity).surface_open) await deps.turnRegistry.recover(identity, surfaceId);
        if (!deps.turnRegistry.current(identity).surface_open) {
          throw new TerminalProtocolError('INVALID_ARGUMENT', 'Call terminal_surface exactly once before terminal_start in each assistant turn.');
        }
        await deps.turnRegistry.clearActive(identity);
        const started = await deps.service.start(identity, startInput);
        const turn = await deps.turnRegistry.activate(identity, started.session_id);
        const record = deps.gateway.getSessionForUser(identity.userId, started.session_id);
        if (!record.session) throw new TerminalProtocolError('SESSION_NOT_FOUND', 'Terminal session metadata was not found.');
        const agent = deps.gateway.listAgents(identity.userId).find((candidate) => candidate.agent_id === record.session!.agent_id);
        const stream = deps.streamTokens.issue(identity.userId, started.session_id);
        const streamUrl = new URL(`/terminal/${encodeURIComponent(started.session_id)}/events`, deps.config.publicUrl);
        streamUrl.searchParams.set('token', stream.token);
        streamUrl.searchParams.set('after', String(started.cursor));
        const output = terminalStartViewOutputSchema.parse({
          ...started,
          surface_id: turn.surface_id,
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
    async (input, ctx) => resultFrom(async () => {
      const identity = identityFromContext(ctx);
      const result = await deps.service.close(identity, input.session_id);
      deps.turnRegistry.deactivate(identity, input.session_id);
      return result;
    }),
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
    'terminal_delete_file',
    {
      title: 'Delete a file',
      description: 'Delete a file within the workspace of an active terminal session. Paths outside configured workspace roots or pointing to symbolic links/directories are rejected.',
      inputSchema: terminalDeleteFileInputSchema,
      outputSchema: terminalDeleteFileOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input, ctx) => resultFrom(async () => {
      const result = await deps.service.deleteFile(identityFromContext(ctx), input);
      return terminalDeleteFileOutputSchema.parse(result);
    }),
  );

  server.registerTool(
    'terminal_rename_file',
    {
      title: 'Rename or move a file',
      description: 'Rename or move a file within the workspace of an active terminal session. Both source and destination paths must be within configured workspace roots.',
      inputSchema: terminalRenameFileInputSchema,
      outputSchema: terminalRenameFileOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input, ctx) => resultFrom(async () => {
      const result = await deps.service.renameFile(identityFromContext(ctx), input);
      return terminalRenameFileOutputSchema.parse(result);
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

  server.registerTool(
    'terminal_workspace_roots',
    {
      title: 'List agent workspace roots',
      description: 'List the persisted workspace roots currently authorized on a selected local agent.',
      inputSchema: terminalWorkspaceRootsInputSchema,
      outputSchema: terminalWorkspaceRootsOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input, ctx) => resultFrom(() => deps.service.getWorkspaceRoots(identityFromContext(ctx), input)),
  );

  server.registerTool(
    'terminal_workspace_root_add',
    {
      title: 'Add agent workspace root',
      description: 'Authorize and persist an additional local workspace root for future terminal, code, and LSP operations.',
      inputSchema: terminalWorkspaceRootMutationInputSchema,
      outputSchema: terminalWorkspaceRootsOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input, ctx) => resultFrom(() => deps.service.addWorkspaceRoot(identityFromContext(ctx), input)),
  );

  server.registerTool(
    'terminal_workspace_root_remove',
    {
      title: 'Remove agent workspace root',
      description: 'Remove and persist a local workspace authorization. Removal is rejected while an active terminal session is using that root.',
      inputSchema: terminalWorkspaceRootMutationInputSchema,
      outputSchema: terminalWorkspaceRootsOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input, ctx) => resultFrom(() => deps.service.removeWorkspaceRoot(identityFromContext(ctx), input)),
  );

  server.registerTool(
    'terminal_execute_code_block',
    {
      title: 'Execute code block',
      description: 'Execute code through a strict runtime allowlist on a selected local agent. Execution is confined to configured workspace roots and requires a non-read-only profile. Final stdout/stderr are returned as explicit bounded head/tail excerpts; max_output_chars controls the per-stream MCP context bound.',
      inputSchema: terminalExecuteCodeBlockMcpInputSchema,
      outputSchema: terminalExecuteCodeBlockMcpOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (input, ctx) => resultFrom(async () => {
      const identity = identityFromContext(ctx);
      const { max_output_chars: maxOutputCharacters, ...serviceInput } = input;
      const executionId = serviceInput.execution_id ?? randomUUID();
      const executeInput = { ...serviceInput, execution_id: executionId };
      if (ctx.mcpReq.signal.aborted) throw new TerminalProtocolError('REQUEST_CANCELLED', 'Code execution request was cancelled.');
      const onAbort = (): void => {
        void deps.service.cancelCode(identity, { agent_id: serviceInput.agent_id, execution_id: executionId }).catch(() => undefined);
      };
      ctx.mcpReq.signal.addEventListener('abort', onAbort, { once: true });
      let progress = 0;
      let notificationTail: Promise<void> = Promise.resolve();
      const progressToken = ctx.mcpReq._meta?.progressToken;
      const limitProgressChunk = createProgressChunkLimiter(maxOutputCharacters);
      const onChunk = progressToken === undefined ? undefined : (stream: 'stdout' | 'stderr', chunk: string): void => {
        const limited = limitProgressChunk(chunk);
        if (!limited) return;
        progress += 1;
        notificationTail = notificationTail
          .then(() => ctx.mcpReq.notify({
            method: 'notifications/progress',
            params: {
              progressToken,
              progress,
              message: JSON.stringify({
                execution_id: executionId,
                stream,
                chunk: limited.chunk,
                ...(limited.truncated ? { truncated: true } : {}),
              }),
            },
          }))
          .catch(() => undefined);
      };
      try {
        const output = await deps.service.executeCode(identity, executeInput, onChunk);
        const stdout = boundOutputText(output.stdout, maxOutputCharacters);
        const stderr = boundOutputText(output.stderr, maxOutputCharacters);
        await notificationTail;
        return terminalExecuteCodeBlockMcpOutputSchema.parse({
          ...output,
          stdout: stdout.text,
          stderr: stderr.text,
          stdout_truncated: stdout.truncated,
          stderr_truncated: stderr.truncated,
          stdout_original_characters: stdout.originalCharacters,
          stderr_original_characters: stderr.originalCharacters,
          stdout_omitted_characters: stdout.omittedCharacters,
          stderr_omitted_characters: stderr.omittedCharacters,
        });
      } finally {
        ctx.mcpReq.signal.removeEventListener('abort', onAbort);
      }
    }),
  );

  server.registerTool(
    'terminal_cancel_code',
    {
      title: 'Cancel code execution',
      description: 'Cancel a bounded code execution owned by the authenticated user on the selected local agent.',
      inputSchema: terminalCancelCodeToolSchema,
      outputSchema: codeCancelOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input, ctx) => resultFrom(() => deps.service.cancelCode(identityFromContext(ctx), input)),
  );

  server.registerTool(
    'terminal_continue_task',
    {
      title: 'Continue approved task',
      description: 'Return a continuation checkpoint for a user-approved long-running task while the current model turn remains active. This is a hint only: it does not schedule background work, extend host execution, bypass authorization or safety requirements, or suppress confirmations that are otherwise required.',
      inputSchema: terminalYieldInputSchema,
      outputSchema: terminalYieldOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    () => resultFrom(() => Promise.resolve(terminalYieldOutputSchema.parse({
      continue_current_turn: true,
      host_reentry_scheduled: false,
      message: 'Continue with the next already-authorized step while this turn remains active. Stop if the user cancels or if a required authorization or confirmation boundary is reached.',
    }))),
  );

  server.registerTool(
    'terminal_lsp_start',
    {
      title: 'Start configured LSP server',
      description: 'Start an administrator-configured language server on a selected local agent within an allowed workspace root.',
      inputSchema: terminalLspStartSchema,
      outputSchema: lspStartOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input, ctx) => resultFrom(() => deps.service.startLsp(identityFromContext(ctx), input)),
  );

  server.registerTool(
    'terminal_lsp_request',
    {
      title: 'Send LSP request',
      description: 'Send one bounded JSON-RPC request or client notification to an owned LSP process on the selected local agent. Standard LSP notification methods are auto-detected; set notification=true for custom notifications.',
      inputSchema: terminalLspRequestSchema,
      outputSchema: lspRequestOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input, ctx) => resultFrom(() => deps.service.requestLsp(identityFromContext(ctx), input)),
  );

  server.registerTool(
    'terminal_lsp_stop',
    {
      title: 'Stop LSP server',
      description: 'Stop an owned LSP process on the selected local agent.',
      inputSchema: terminalLspStopSchema,
      outputSchema: lspStopOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input, ctx) => resultFrom(() => deps.service.stopLsp(identityFromContext(ctx), input)),
  );

  if (deps.config.extensionRoot) {
    const extensionLoader = new TrustedExtensionLoader(
      deps.config.extensionRoot,
      deps.config.extensionMaxBytes,
      createTrustedExtensionRegistrar(server),
      deps.audit,
    );
    server.registerTool(
      'terminal_reload_agent',
      {
        title: 'Reload trusted server extension',
        description: 'Reload an administrator-installed trusted MCP extension by strict extension id. Arbitrary paths are not accepted.',
        inputSchema: terminalReloadAgentInputSchema,
        outputSchema: terminalReloadAgentOutputSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      async (input, ctx) => resultFrom(() => extensionLoader.reload(identityFromContext(ctx), input.extension_id)),
    );
  }

  return server;
}


async function terminalSurfaceView(
  deps: McpServerDependencies,
  identity: RequestIdentity,
  state: TerminalTurnState,
): Promise<Record<string, unknown>> {
  if (!state.surface_open || !state.session_id) return { ...state };
  try {
    const status = await deps.service.status(identity, state.session_id);
    const read = await deps.service.read(identity, {
      session_id: state.session_id,
      after: 0,
      max_bytes: deps.config.maxReadBytes,
      wait_ms: 0,
    });
    const agent = deps.gateway.listAgents(identity.userId).find((candidate) => candidate.agent_id === status.agent_id);
    return {
      ...state,
      status: status.status,
      cursor: read.next_cursor,
      initial_output: read.output,
      agent_id: status.agent_id,
      agent_name: agent?.display_name ?? status.agent_id,
      cwd: status.cwd,
      shell: status.shell,
      exit_code: status.exit_code,
    };
  } catch (error) {
    if (error instanceof TerminalProtocolError && (error.code === 'SESSION_CLOSED' || error.code === 'SESSION_NOT_FOUND')) {
      return { ...deps.turnRegistry.deactivate(identity, state.session_id) };
    }
    throw error;
  }
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
    ...(ctx.sessionId ? { mcpSessionId: ctx.sessionId } : {}),
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
