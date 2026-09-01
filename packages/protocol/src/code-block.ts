import { z } from 'zod';

export const terminalExecuteCodeBlockToolSchema = z.object({
  code: z.string().describe('The code to execute'),
  language: z.string().describe('The programming language (e.g., bash, python, javascript)'),
  cwd: z.string().optional().describe('Optional working directory for the execution'),
});

export type TerminalExecuteCodeBlockToolArgs = z.infer<typeof terminalExecuteCodeBlockToolSchema>;

export const gatewayExecuteCodeBlockRequestSchema = z.object({
  type: z.literal('execute_code_block'),
  code: z.string(),
  language: z.string(),
  cwd: z.string().optional(),
});

export type GatewayExecuteCodeBlockRequest = z.infer<typeof gatewayExecuteCodeBlockRequestSchema>;

export const gatewayExecuteCodeBlockResponseSchema = z.object({
  type: z.literal('execute_code_block_response'),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().nullable(),
});

export type GatewayExecuteCodeBlockResponse = z.infer<typeof gatewayExecuteCodeBlockResponseSchema>;
