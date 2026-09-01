import { loadConfig } from './config.js';
import { createTerminalHttpRuntime } from './http.js';

const config = loadConfig();
const runtime = await createTerminalHttpRuntime(config);

runtime.httpServer.listen(config.port, config.host, () => {
  console.log(JSON.stringify({
    level: 'info',
    event: 'server.started',
    host: config.host,
    port: config.port,
    public_url: config.publicUrl.href,
    agent_gateway_path: config.agentGatewayPath,
  }));
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: 'info', event: 'server.stopping', signal }));
  try {
    await runtime.close();
    process.exitCode = 0;
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', event: 'server.stop_failed', error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
