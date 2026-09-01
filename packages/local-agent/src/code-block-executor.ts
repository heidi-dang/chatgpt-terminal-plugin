import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';

export interface ExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export class CodeBlockExecutor {
  /**
   * Executes a code block securely by writing it to a temporary file and running it.
   */
  static async execute(
    code: string,
    language: string,
    cwd?: string
  ): Promise<ExecuteResult> {
    const tmpDir = os.tmpdir();
    const id = randomBytes(16).toString('hex');
    
    // Determine extension and command based on language
    let ext = '.txt';
    let cmd = '';
    let args: string[] = [];

    const lang = language.toLowerCase();
    
    if (['bash', 'sh', 'shell'].includes(lang)) {
      ext = '.sh';
      cmd = 'bash';
    } else if (['python', 'python3', 'py'].includes(lang)) {
      ext = '.py';
      cmd = 'python3';
    } else if (['javascript', 'js', 'node'].includes(lang)) {
      ext = '.js';
      cmd = 'node';
    } else if (['typescript', 'ts'].includes(lang)) {
      ext = '.ts';
      cmd = 'npx';
      args.push('tsx');
    } else {
      // Fallback to bash
      ext = '.sh';
      cmd = 'bash';
    }

    const scriptPath = path.join(tmpDir, `script-${id}${ext}`);

    try {
      // Write with restrictive permissions (read/write/execute for owner only)
      await fs.writeFile(scriptPath, code, { mode: 0o700, encoding: 'utf-8' });

      return await new Promise<ExecuteResult>((resolve, reject) => {
        let stdoutData = '';
        let stderrData = '';

        const childArgs = [...args, scriptPath];

        const child = spawn(cmd, childArgs, {
          cwd: cwd || process.cwd(),
          env: process.env,
        });

        child.stdout.on('data', (chunk) => {
          stdoutData += chunk.toString();
        });

        child.stderr.on('data', (chunk) => {
          stderrData += chunk.toString();
        });

        child.on('error', (err) => {
          reject(err);
        });

        child.on('close', (code) => {
          resolve({
            stdout: stdoutData,
            stderr: stderrData,
            exitCode: code,
          });
        });
      });
    } finally {
      // Clean up temporary file
      try {
        await fs.unlink(scriptPath);
      } catch (err) {
        // Ignore errors during cleanup
      }
    }
  }
}
