import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import type { AgentGateway } from './gateway.js';
import type { RequestIdentity } from './service.js';
import {
  terminalExecuteCodeBlockToolSchema,
  type TerminalExecuteCodeBlockToolArgs,
  type GatewayExecuteCodeBlockRequest,
} from '../../protocol/src/code-block.js';

export function registerCodeBlockTool(
  server: McpServer,
  gateway: AgentGateway,
  getIdentity: (ctx: ServerContext) => RequestIdentity
) {
  server.registerTool(
    'terminal_execute_code_block',
    {
      title: 'Execute Code Block',
      description: 'Executes a code block on the local terminal agent securely.',
      inputSchema: terminalExecuteCodeBlockToolSchema,
    },
    async (input: TerminalExecuteCodeBlockToolArgs, ctx: ServerContext) => {
      try {
        const identity = getIdentity(ctx);
        // Execute on the first available agent for the given user identity
        const agents = gateway.listAgents(identity.userId);
        if (agents.length === 0) {
          throw new Error('No active agents found for user.');
        }
        const targetAgent = agents[0];
        if (!targetAgent) {
           throw new Error('No active agents found for user.');
        }
        
        // Assume gateway has a way to get the connection internally.
        // We bypass private modifiers here to mock the internal behavior if this file were integrated.
        const anyGateway = gateway as any;
        const connection = typeof anyGateway.requireAgent === 'function' 
          ? anyGateway.requireAgent(identity.userId, targetAgent.agent_id) 
          : undefined;
        
        if (!connection) {
           throw new Error('Agent connection could not be established or requireAgent method not available.');
        }

        const request: GatewayExecuteCodeBlockRequest = {
          type: 'execute_code_block',
          code: input.code,
          language: input.language,
          cwd: input.cwd,
        };

        const response = await anyGateway.request(connection, {
          ...request,
          request_id: crypto.randomUUID()
        });

        return {
          content: [
            { type: 'text', text: JSON.stringify(response, null, 2) }
          ]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error?.message || String(error)}` }],
          isError: true
        };
      }
    }
  );
}
