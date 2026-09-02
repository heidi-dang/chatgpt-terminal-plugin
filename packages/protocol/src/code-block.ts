import { z } from 'zod';

export const codeRuntimeSchema = z.enum(['bash', 'python3', 'node', 'typescript']);
export type CodeRuntime = z.infer<typeof codeRuntimeSchema>;

export const terminalExecuteCodeBlockToolSchema = z.object({
  agent_id: z.string().min(1),
  execution_id: z.string().uuid().optional(),
  runtime: codeRuntimeSchema,
  code: z.string().min(1).max(262_144),
  stdin: z.string().max(262_144).optional(),
  cwd: z.string().min(1).max(4096).optional(),
  timeout_ms: z.number().int().positive().max(120_000).optional(),
});
export type TerminalExecuteCodeBlockToolArgs = z.infer<typeof terminalExecuteCodeBlockToolSchema>;

export const terminalCancelCodeToolSchema = z.object({
  agent_id: z.string().min(1),
  execution_id: z.string().uuid(),
});
export type TerminalCancelCodeToolArgs = z.infer<typeof terminalCancelCodeToolSchema>;

export const codeExecuteInputSchema = terminalExecuteCodeBlockToolSchema.omit({ agent_id: true }).extend({
  execution_id: z.string().uuid(),
});
export type CodeExecuteInput = z.infer<typeof codeExecuteInputSchema>;

export const codeCancelInputSchema = z.object({
  execution_id: z.string().uuid(),
});
export type CodeCancelInput = z.infer<typeof codeCancelInputSchema>;

export const codeExecuteOutputSchema = z.object({
  execution_id: z.string().uuid(),
  stdout: z.string(),
  stderr: z.string(),
  exit_code: z.number().int().nullable(),
  timed_out: z.boolean(),
  duration_ms: z.number().int().nonnegative(),
});
export type CodeExecuteOutput = z.infer<typeof codeExecuteOutputSchema>;

export const codeCancelOutputSchema = z.object({
  execution_id: z.string().uuid(),
  cancelled: z.boolean(),
});
export type CodeCancelOutput = z.infer<typeof codeCancelOutputSchema>;
