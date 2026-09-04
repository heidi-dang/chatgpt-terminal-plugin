import './styles.css';

export * from './protocol.js';
export * from './text.js';
export * from './bridge.js';
export * from './viewer.js';

import { ChatGptMcpBridge } from './bridge.js';
import { TerminalViewer } from './viewer.js';

export async function bootTerminalApp(): Promise<TerminalViewer> {
  const bridge = new ChatGptMcpBridge();
  const viewer = new TerminalViewer(bridge);
  viewer.bind();
  try {
    await bridge.connect();
    viewer.markBridgeReady();
  } catch (error) {
    console.error('[terminal-app] bridge connection failed', error);
    viewer.showBridgeFailure(error);
  }
  return viewer;
}

if (document.querySelector('[data-terminal-static-shell]')) {
  void bootTerminalApp();
}