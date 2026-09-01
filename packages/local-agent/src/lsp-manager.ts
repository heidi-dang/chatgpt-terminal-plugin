import { spawn, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

interface LspProcess {
  id: string;
  process: ChildProcess;
  buffer: Buffer;
  contentLength: number | null;
}

export class LspManager extends EventEmitter {
  private processes: Map<string, LspProcess> = new Map();
  private requestCallbacks: Map<string, { resolve: (val: any) => void, reject: (err: any) => void }> = new Map();
  private nextRpcId = 1;

  public start(command: string, args: string[]): string {
    const id = randomUUID();
    const lspProcess = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const lspObj: LspProcess = {
      id,
      process: lspProcess,
      buffer: Buffer.alloc(0),
      contentLength: null,
    };

    this.processes.set(id, lspObj);

    lspProcess.stdout?.on('data', (chunk: Buffer) => {
      this.handleData(lspObj, chunk);
    });

    lspProcess.stderr?.on('data', (chunk: Buffer) => {
      // Typically log stderr or emit as telemetry
      // console.error(`[LSP ${id} stderr]: ${chunk.toString('utf-8')}`);
    });

    lspProcess.on('exit', () => {
      this.processes.delete(id);
      this.emit('exit', id);
    });

    lspProcess.on('error', (err) => {
      console.error(`Failed to start LSP process ${id}:`, err);
      this.processes.delete(id);
      this.emit('error', id, err);
    });

    return id;
  }

  private handleData(lspObj: LspProcess, chunk: Buffer) {
    lspObj.buffer = Buffer.concat([lspObj.buffer, chunk]);

    while (lspObj.buffer.length > 0) {
      if (lspObj.contentLength === null) {
        const headerEnd = lspObj.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
          break; // Need more data for headers
        }

        const headers = lspObj.buffer.subarray(0, headerEnd).toString('ascii');
        const match = headers.match(/Content-Length:\s*(\d+)/i);
        if (match) {
          lspObj.contentLength = parseInt(String(match[1]), 10);
        } else {
          // In a strict LSP implementation, absence of Content-Length is a fatal error.
          // We will clear the buffer to prevent getting stuck.
          console.error('Invalid LSP header: no Content-Length');
          lspObj.buffer = Buffer.alloc(0);
          break;
        }

        lspObj.buffer = lspObj.buffer.subarray(headerEnd + 4);
      }

      if (lspObj.contentLength !== null) {
        if (lspObj.buffer.length >= lspObj.contentLength) {
          const content = lspObj.buffer.subarray(0, lspObj.contentLength).toString('utf-8');
          lspObj.buffer = lspObj.buffer.subarray(lspObj.contentLength);
          lspObj.contentLength = null;

          try {
            const message = JSON.parse(content);
            this.handleMessage(lspObj.id, message);
          } catch (e) {
            console.error('Failed to parse LSP message', e);
          }
        } else {
          break; // Need more data for content
        }
      }
    }
  }

  private handleMessage(lspId: string, message: any) {
    if (typeof message !== 'object' || message === null) return;

    if ('id' in message && ('result' in message || 'error' in message)) {
      // Response to a request we sent
      const callback = this.requestCallbacks.get(String(message.id));
      if (callback) {
        if ('error' in message) {
          callback.reject(message.error);
        } else {
          callback.resolve(message.result);
        }
        this.requestCallbacks.delete(String(message.id));
      }
    } else {
      // Notification or request from server
      this.emit('event', {
        lspId,
        method: message.method,
        params: message.params,
      });
    }
  }

  public async request(lspId: string, method: string, params?: any): Promise<any> {
    const lspObj = this.processes.get(lspId);
    if (!lspObj || !lspObj.process.stdin || lspObj.process.killed) {
      throw new Error(`LSP process ${lspId} not found or not writable`);
    }

    const rpcId = this.nextRpcId++;
    const message = {
      jsonrpc: '2.0',
      id: rpcId,
      method,
      params,
    };

    const content = JSON.stringify(message);
    const payload = `Content-Length: ${Buffer.byteLength(content, 'utf-8')}\r\n\r\n${content}`;

    return new Promise((resolve, reject) => {
      this.requestCallbacks.set(String(rpcId), { resolve, reject });
      lspObj.process.stdin!.write(payload, 'utf-8', (error) => {
        if (error) {
          this.requestCallbacks.delete(String(rpcId));
          reject(error);
        }
      });
    });
  }

  public stop(lspId: string): boolean {
    const lspObj = this.processes.get(lspId);
    if (lspObj) {
      lspObj.process.kill();
      this.processes.delete(lspId);
      return true;
    }
    return false;
  }
}
