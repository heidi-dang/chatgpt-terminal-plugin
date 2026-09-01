import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  TerminalLspStartSchema,
  TerminalLspRequestSchema,
  TerminalLspStopSchema,
} from '../../protocol/dist/lsp.js';

// We assume AgentGateway has some sendLspMessage method or similar.
// We declare an interface for what we need to avoid coupling strictly to gateway.ts.
export interface LspAgentGateway {
  sendLspMessage(userId: string, agentId: string, message: any): Promise<any>;
}

export function registerLspTools(
  server: McpServer,
  gateway: LspAgentGateway,
  getContextIdentity: (ctx: any) => { userId: string }
) {
  server.registerTool(
    'terminal_lsp_start',
    {
      title: 'Start LSP Server',
      description: 'Start a Language Server Protocol process on the local agent.',
      inputSchema: TerminalLspStartSchema,
    },
    async (input, ctx) => {
      try {
        const identity = getContextIdentity(ctx);
        const agents = (gateway as any).listAgents(identity.userId);
        if (!agents.length) throw new Error('No active agents found');
        const agentId = agents[0].agent_id;
        const result = await gateway.sendLspMessage(identity.userId, agentId, {
          type: 'lsp_start_request',
          requestId: crypto.randomUUID(),
          command: input.command,
          args: input.args,
          rootUri: input.rootUri,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error: any) {
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    }
  );

  server.registerTool(
    'terminal_lsp_request',
    {
      title: 'LSP Request',
      description: 'Send a JSON-RPC request to a running LSP server.',
      inputSchema: TerminalLspRequestSchema,
    },
    async (input, ctx) => {
      try {
        const identity = getContextIdentity(ctx);
        const agents = (gateway as any).listAgents(identity.userId);
        if (!agents.length) throw new Error('No active agents found');
        const agentId = agents[0].agent_id;
        const result = await gateway.sendLspMessage(identity.userId, agentId, {
          type: 'lsp_rpc_request',
          requestId: crypto.randomUUID(),
          lspId: input.id,
          method: input.method,
          params: input.params,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error: any) {
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    }
  );

  server.registerTool(
    'terminal_lsp_stop',
    {
      title: 'Stop LSP Server',
      description: 'Stop a running LSP server.',
      inputSchema: TerminalLspStopSchema,
    },
    async (input, ctx) => {
      try {
        const identity = getContextIdentity(ctx);
        const agents = (gateway as any).listAgents(identity.userId);
        if (!agents.length) throw new Error('No active agents found');
        const agentId = agents[0].agent_id;
        const result = await gateway.sendLspMessage(identity.userId, agentId, {
          type: 'lsp_stop_request',
          requestId: crypto.randomUUID(),
          lspId: input.id,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error: any) {
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    }
  );
}
