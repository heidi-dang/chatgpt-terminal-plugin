import { createServer, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import { getOAuthProtectedResourceMetadataUrl, hostHeaderValidation, localhostHostValidation, mcpAuthMetadataRouter, requireBearerAuth } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { isInitializeRequest, type McpServer } from '@modelcontextprotocol/server';
import { TerminalProtocolError, deviceEnrollmentOutputSchema, deviceEnrollmentRequestSchema, type TerminalEvent } from '@terminal/protocol';
import { createOAuthMetadata, createTokenVerifier } from './auth.js';
import { AuditLogger } from './audit.js';
import type { ServerConfig } from './config.js';
import { DeviceRegistry } from './device-registry.js';
import { AgentGateway } from './gateway.js';
import { createTerminalMcpServer } from './mcp.js';
import { TerminalService } from './service.js';
import { StreamTokenService } from './stream-token.js';
import { TerminalTurnRegistry } from './turn-registry.js';
import { readTerminalUiStyles, watchTerminalUiStyles } from './ui-runtime.js';

interface McpSession {
  transport: NodeStreamableHTTPServerTransport;
  server: McpServer;
  userId: string;
  clientId: string;
  lastActivityAt: number;
  activeRequests: number;
}

export interface TerminalHttpRuntime {
  httpServer: HttpServer;
  gateway: AgentGateway;
  deviceRegistry: DeviceRegistry;
  close(): Promise<void>;
}

export async function createTerminalHttpRuntime(config: ServerConfig): Promise<TerminalHttpRuntime> {
  const allowedHosts = config.nodeEnv === 'production'
    ? [...new Set([...config.allowedHosts, '127.0.0.1', 'localhost', '::1'])]
    : config.allowedHosts;
  const app = express();
  app.use(express.json({ limit: '512kb' }));
  if (allowedHosts.length > 0) app.use(hostHeaderValidation(allowedHosts));
  else if (isLoopbackHost(config.host)) app.use(localhostHostValidation());
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (!origin) {
      next();
      return;
    }
    const widgetRoute = isWidgetBrowserRoute(req.path);
    const allowed = isConfiguredBrowserOrigin(origin, config.allowedOrigins)
      || (widgetRoute && isOpenAiWidgetOrigin(origin));
    if (!allowed) {
      res.status(403).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: `Invalid Origin: ${origin}` },
        id: null,
      });
      return;
    }
    if (widgetRoute) setWidgetCorsHeaders(origin, res);
    next();
  });
  const audit = new AuditLogger(config.auditLogPath, config.transcriptLogPath);
  await audit.pruneTranscript(config.transcriptRetentionDays);
  const transcriptRetentionTimer = setInterval(() => {
    void audit.pruneTranscript(config.transcriptRetentionDays).catch((error) => {
      console.error(JSON.stringify({ level: 'error', event: 'transcript.retention_failed', error: errorMessage(error) }));
    });
  }, 6 * 60 * 60_000);
  transcriptRetentionTimer.unref();
  const deviceRegistry = await DeviceRegistry.load(config.deviceRegistryPath, config.agentEnrollmentToken);
  const gateway = new AgentGateway({
    requestTimeoutMs: config.agentRequestTimeoutMs,
    maxRetainedBytesPerSession: config.bufferHighWaterBytes,
    closedSessionRetentionMs: config.closedSessionRetentionMs,
    sessionSweepIntervalMs: config.terminalSweepIntervalMs,
    deviceRegistry,
    authChallengeTtlMs: config.agentAuthChallengeTtlMs,
    onTerminalEvent: (ownerId, agentId, event) => {
      void audit.transcript({
        user_id: ownerId,
        agent_id: agentId,
        terminal_session_id: event.session_id,
        sequence: event.sequence,
        event_type: event.event_type,
        data: event.data,
      }).catch((error) => {
        console.error(JSON.stringify({ level: 'error', event: 'transcript.write_failed', error: errorMessage(error) }));
      });
    },
  });
  const service = new TerminalService(gateway, config, audit);
  const streamTokens = new StreamTokenService(config.streamTokenSecret, config.streamTokenTtlSeconds);
  const turnRegistry = await TerminalTurnRegistry.load(
    async (identity, sessionId) => service.close(identity, sessionId).then(() => undefined),
    config.terminalTurnLeaseMs,
    config.terminalTurnStatePath,
    config.terminalSurfaceRetentionMs,
  );
  const verifier = createTokenVerifier(config);
  const oauthMetadata = createOAuthMetadata(config);
  const sessions = new Map<string, McpSession>();
  let mcpInitializingSessions = 0;
  const mcpSessionSweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
      if (session.activeRequests > 0 || now - session.lastActivityAt < config.mcpSessionIdleMs) continue;
      sessions.delete(sessionId);
      void session.server.close().catch((error) => {
        console.error(JSON.stringify({
          level: 'error',
          event: 'mcp.session_expiry_failed',
          session_id: sessionId,
          error: errorMessage(error),
        }));
      });
    }
  }, config.mcpSessionSweepIntervalMs);
  mcpSessionSweepTimer.unref();
  const uiReloadClients = new Set<Response>();
  const terminalStreamClients = new Set<Response>();
  const terminalStreamCounts = new Map<string, number>();
  let terminalUiStyleVersion = (await readTerminalUiStyles()).version;
  const stopUiWatcher = watchTerminalUiStyles((version) => {
    if (version === terminalUiStyleVersion) return;
    terminalUiStyleVersion = version;
    const payload = `data: ${JSON.stringify({ version, kind: 'styles' })}\n\n`;
    for (const client of uiReloadClients) {
      if (!client.writableEnded && !client.destroyed) client.write(payload);
    }
  });
  const enrollmentRateLimiter = createRateLimiter(
    config.requestsPerMinute,
    (req) => `enrollment:${clientAddress(req)}`,
    config.rateLimitMaxBuckets,
  );

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const requestId = req.get('x-request-id') ?? randomUUID();
    res.setHeader('x-request-id', requestId);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      ...(config.nodeEnv === 'production' ? {} : { active_agents: gateway.activeAgentCount(), mcp_sessions: sessions.size }),
    });
  });

  app.get('/terminal-ui/styles.css', async (_req, res) => {
    try {
      const styles = await readTerminalUiStyles();
      terminalUiStyleVersion = styles.version;
      res.setHeader('content-type', 'text/css; charset=utf-8');
      res.setHeader('cache-control', 'no-store, max-age=0');
      res.setHeader('cross-origin-resource-policy', 'cross-origin');
      res.setHeader('x-content-type-options', 'nosniff');
      res.status(200).send(styles.css);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'terminal_ui.styles_failed', error: errorMessage(error) }));
      res.status(503).send('Terminal UI stylesheet is unavailable.');
    }
  });

  app.get('/terminal-ui/reload', (req, res) => {
    if (uiReloadClients.size >= config.maxUiReloadClients) {
      res.status(503).json({ error: 'ui_reload_capacity_reached' });
      return;
    }
    res.status(200);
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-store');
    res.setHeader('cross-origin-resource-policy', 'cross-origin');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders();
    uiReloadClients.add(res);
    res.write(`data: ${JSON.stringify({ version: terminalUiStyleVersion, kind: 'styles' })}\n\n`);

    const keepAlive = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': keepalive\n\n');
    }, 15_000);
    keepAlive.unref();
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(keepAlive);
      uiReloadClients.delete(res);
      if (!res.writableEnded && !res.destroyed) res.end();
    };
    res.once('close', cleanup);
    res.once('error', cleanup);
    req.once('close', cleanup);
    req.once('error', cleanup);
  });

  app.post(config.agentEnrollmentPath, enrollmentRateLimiter, async (req, res) => {
    const parsed = deviceEnrollmentRequestSchema.safeParse(req.body as unknown);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_device_enrollment' });
      return;
    }
    try {
      const enrolled = await deviceRegistry.enroll(parsed.data, req.get('x-terminal-enrollment-token') ?? undefined);
      const output = deviceEnrollmentOutputSchema.parse({
        device_id: enrolled.record.device_id,
        agent_id: enrolled.record.agent_id,
        owner_id: enrolled.record.owner_id,
        status: enrolled.status,
        enrolled_at: enrolled.record.enrolled_at,
      });
      res.status(enrolled.status === 'enrolled' ? 201 : 200).json(output);
    } catch (error) {
      if (error instanceof TerminalProtocolError) {
        res.status(error.code === 'PERMISSION_DENIED' ? 403 : 400).json(error.toPayload());
        return;
      }
      console.error(JSON.stringify({ level: 'error', event: 'device.enrollment_persist_failed', error: errorMessage(error) }));
      res.status(503).json({ error: 'device_registry_unavailable' });
    }
  });

  app.post(`${config.agentEnrollmentPath}/revoke`, enrollmentRateLimiter, async (req, res) => {
    try {
      const token = req.get('x-terminal-enrollment-token') ?? undefined;
      const deviceId = deviceIdFromBody(req.body as unknown);
      const existing = deviceRegistry.get(deviceId);
      if (!existing) {
        res.status(404).json({ error: 'device_not_found' });
        return;
      }
      await deviceRegistry.revoke(deviceId, token);
      gateway.revokeDevice(deviceId);
      res.status(200).json({ device_id: deviceId, status: 'revoked' });
    } catch (error) {
      if (error instanceof TerminalProtocolError) {
        res.status(error.code === 'PERMISSION_DENIED' ? 403 : 400).json(error.toPayload());
        return;
      }
      console.error(JSON.stringify({ level: 'error', event: 'device.revocation_persist_failed', error: errorMessage(error) }));
      res.status(503).json({ error: 'device_registry_unavailable' });
    }
  });

  if (oauthMetadata) {
    app.use(mcpAuthMetadataRouter({
      oauthMetadata,
      resourceServerUrl: config.publicUrl,
      scopesSupported: config.requiredScopes,
      resourceName: 'ChatGPT Terminal',
      dangerouslyAllowInsecureIssuerUrl: config.nodeEnv !== 'production',
    }));
  }

  const resourceMetadataUrl = oauthMetadata ? getOAuthProtectedResourceMetadataUrl(config.publicUrl) : undefined;
  const publicAuthMiddleware = config.authMode === 'cloudflare-access'
    ? createCloudflareAccessAuthMiddleware(verifier, config.requiredScopes)
    : requireBearerAuth({
        verifier,
        requiredScopes: config.requiredScopes,
        ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
      });
  const authMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    if (config.nodeEnv === 'production' && isDirectLoopbackDeploymentSmoke(req)) {
      req.auth = {
        token: 'deployment-smoke',
        clientId: 'deployment-smoke',
        scopes: [...config.requiredScopes],
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        resource: config.publicUrl,
        extra: {
          user_id: 'deployment-smoke',
          auth_mode: 'deployment-smoke',
          execution_profile: 'read-only',
        },
      };
      next();
      return;
    }
    publicAuthMiddleware(req, res, next);
  };

  const mcpHandler = async (req: Request, res: Response) => {
    let reservedInitialization = false;
    try {
      const principal = requestPrincipal(req);
      const sessionIdHeader = req.get('mcp-session-id');
      let session = sessionIdHeader ? sessions.get(sessionIdHeader) : undefined;
      if (session && (session.userId !== principal.userId || session.clientId !== principal.clientId)) {
        res.status(403).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'MCP session is not owned by the authenticated principal.' },
          id: null,
        });
        return;
      }

      if (!session) {
        if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
          res.status(sessionIdHeader ? 404 : 400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: sessionIdHeader ? 'MCP session not found.' : 'MCP initialization request required.' },
            id: null,
          });
          return;
        }
        if (sessions.size + mcpInitializingSessions >= config.maxMcpSessions) {
          res.status(503).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'MCP session capacity has been reached.' },
            id: null,
          });
          return;
        }
        mcpInitializingSessions += 1;
        reservedInitialization = true;

        const mcpServer = createTerminalMcpServer({ config, gateway, service, streamTokens, turnRegistry, audit });
        const transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sessionId) => {
            sessions.set(sessionId, createdSession);
          },
        });
        const createdSession: McpSession = {
          transport,
          server: mcpServer,
          ...principal,
          lastActivityAt: Date.now(),
          activeRequests: 0,
        };
        transport.onclose = () => {
          const sessionId = transport.sessionId;
          if (sessionId) sessions.delete(sessionId);
          void mcpServer.close();
        };
        await mcpServer.connect(transport);
        session = createdSession;
      }

      session.lastActivityAt = Date.now();
      session.activeRequests += 1;
      try {
        await session.transport.handleRequest(req, res, req.body);
      } finally {
        session.activeRequests = Math.max(0, session.activeRequests - 1);
        session.lastActivityAt = Date.now();
      }
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'mcp.request_failed', error: errorMessage(error) }));
      if (!res.headersSent) res.status(500).json({ error: 'internal_server_error' });
    } finally {
      if (reservedInitialization) mcpInitializingSessions = Math.max(0, mcpInitializingSessions - 1);
    }
  };

  // The authenticated MCP transport is deliberately not application-rate-limited here.
  // Streamable HTTP may generate host-managed POST/GET traffic that is not equivalent to
  // user terminal actions. Cloudflare Access/WAF provides the public transport boundary;
  // terminal output uses a separate capability-scoped SSE channel, and enrollment keeps
  // its own strict source limiter below.
  app.post('/mcp', authMiddleware, (req, res) => void mcpHandler(req, res));
  app.get('/mcp', authMiddleware, (req, res) => void mcpHandler(req, res));
  app.delete('/mcp', authMiddleware, (req, res) => void mcpHandler(req, res));

  app.get('/terminal/:sessionId/events', (req, res) => {
    const sessionId = req.params.sessionId;
    const token = typeof req.query.token === 'string' ? req.query.token : undefined;
    if (!token) {
      res.status(401).json({ error: 'STREAM_TOKEN_EXPIRED' });
      return;
    }

    try {
      const payload = streamTokens.verify(token, sessionId);
      const record = gateway.getSessionForUser(payload.sub, sessionId);
      turnRegistry.touchSession(payload.sub, sessionId);
      const headerCursor = req.get('last-event-id');
      const queryCursor = typeof req.query.after === 'string' ? req.query.after : undefined;
      const parsedCursor = Number.parseInt(headerCursor ?? queryCursor ?? '0', 10);
      const cursor = Number.isFinite(parsedCursor) && parsedCursor >= 0 ? parsedCursor : 0;
      if (cursor < record.earliestSequence - 1 || cursor > record.latestSequence) {
        throw new TerminalProtocolError('INVALID_CURSOR', 'SSE cursor is outside the retained terminal event range.');
      }
      const activeStreamsForSession = terminalStreamCounts.get(sessionId) ?? 0;
      if (activeStreamsForSession >= config.maxTerminalStreamsPerSession) {
        res.setHeader('retry-after', '1');
        res.status(429).json({ error: 'terminal_stream_capacity_reached' });
        return;
      }

      res.status(200);
      res.setHeader('content-type', 'text/event-stream; charset=utf-8');
      res.setHeader('cross-origin-resource-policy', 'cross-origin');
      res.setHeader('cache-control', 'no-cache, no-store');
      res.setHeader('connection', 'keep-alive');
      res.setHeader('x-accel-buffering', 'no');
      res.flushHeaders();
      terminalStreamClients.add(res);
      terminalStreamCounts.set(sessionId, activeStreamsForSession + 1);
      console.log(JSON.stringify({
        level: 'info',
        event: 'terminal.sse_connected',
        terminal_session_id: sessionId,
        user_id: payload.sub,
        after: cursor,
        active_streams: terminalStreamClients.size,
      }));

      let lastSequence = cursor;
      let replaying = true;
      let backpressured = false;
      const pendingLive: typeof record.events = [];
      const sendEvent = (event: (typeof record.events)[number]) => {
        if (event.sequence <= lastSequence || res.writableEnded || res.destroyed || backpressured) return;
        const sent = writeTerminalSseEvents([event], lastSequence, (frame) => res.write(frame));
        lastSequence = sent.lastSequence;
        if (sent.backpressured) {
          backpressured = true;
          res.end();
        }
      };
      const unsubscribe = gateway.subscribe(sessionId, (event) => {
        if (event.sequence <= lastSequence) return;
        if (replaying) {
          pendingLive.push(event);
          return;
        }
        sendEvent(event);
      });

      const replayEvents: typeof record.events = [];
      for (let index = record.eventHead; index < record.events.length; index += 1) {
        const event = record.events[index];
        if (event && event.sequence > cursor) replayEvents.push(event);
      }
      if (replayEvents.length > 0 && !res.writableEnded && !res.destroyed) {
        const replayResult = writeTerminalSseEvents(replayEvents, lastSequence, (frame) => res.write(frame));
        lastSequence = replayResult.lastSequence;
        if (replayResult.backpressured) {
          backpressured = true;
          res.end();
        }
      }
      replaying = false;
      if (!backpressured) {
        pendingLive.sort((left, right) => left.sequence - right.sequence);
        for (const event of pendingLive) sendEvent(event);
      }

      const keepAlive = setInterval(() => {
        if (!res.writableEnded && !res.destroyed) {
          turnRegistry.touchSession(payload.sub, sessionId);
          res.write(': keepalive\n\n');
        }
      }, 15_000);
      keepAlive.unref();
      const expiryTimer = setTimeout(() => res.end(), Math.max(1, payload.exp * 1000 - Date.now()));
      expiryTimer.unref();
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(keepAlive);
        clearTimeout(expiryTimer);
        unsubscribe();
        terminalStreamClients.delete(res);
        const remainingStreams = Math.max(0, (terminalStreamCounts.get(sessionId) ?? 1) - 1);
        if (remainingStreams === 0) terminalStreamCounts.delete(sessionId);
        else terminalStreamCounts.set(sessionId, remainingStreams);
        console.log(JSON.stringify({
          level: 'info',
          event: 'terminal.sse_disconnected',
          terminal_session_id: sessionId,
          user_id: payload.sub,
          active_streams: terminalStreamClients.size,
        }));
        if (!res.writableEnded && !res.destroyed) res.end();
      };
      res.once('close', cleanup);
      res.once('error', cleanup);
      req.once('close', cleanup);
      req.once('error', cleanup);
    } catch (error) {
      if (error instanceof TerminalProtocolError) {
        res.status(error.code === 'STREAM_TOKEN_EXPIRED' ? 401 : error.code === 'PERMISSION_DENIED' ? 403 : 409).json(error.toPayload());
        return;
      }
      res.status(500).json({ error: 'internal_server_error' });
    }
  });

  const httpServer = createServer(app);
  let closePromise: Promise<void> | undefined;
  httpServer.on('upgrade', (request, socket, head) => {
    if (!isAllowedUpgradeHost(request.headers.host, config.allowedHosts)) {
      socket.destroy();
      return;
    }
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== config.agentGatewayPath) {
      socket.destroy();
      return;
    }
    gateway.handleUpgrade(request, socket, head);
  });

  return {
    httpServer,
    gateway,
    deviceRegistry,
    close() {
      return closePromise ??= (async () => {
        const httpClosed = httpServer.listening
          ? new Promise<void>((resolve, reject) => {
              httpServer.close((error) => error ? reject(error) : resolve());
            })
          : Promise.resolve();
        const forceCloseTimer = setTimeout(() => httpServer.closeAllConnections(), config.shutdownGraceMs);
        forceCloseTimer.unref();
        clearInterval(transcriptRetentionTimer);
        clearInterval(mcpSessionSweepTimer);
        stopUiWatcher();
        for (const client of uiReloadClients) client.end();
        uiReloadClients.clear();
        for (const client of terminalStreamClients) client.end();
        terminalStreamClients.clear();
        terminalStreamCounts.clear();
        httpServer.closeIdleConnections();
        turnRegistry.dispose();
        gateway.closeAll();
        for (const session of sessions.values()) await session.server.close();
        sessions.clear();
        await httpClosed;
        clearTimeout(forceCloseTimer);
        await audit.flush();
      })();
    },
  };
}


function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function isWidgetBrowserRoute(pathname: string): boolean {
  return pathname === '/terminal-ui/styles.css'
    || pathname === '/terminal-ui/reload'
    || /^\/terminal\/[^/]+\/events$/.test(pathname);
}

function isOpenAiWidgetOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    const hostname = url.hostname.toLowerCase();
    return hostname === 'web-sandbox.oaiusercontent.com'
      || hostname.endsWith('.web-sandbox.oaiusercontent.com');
  } catch {
    return false;
  }
}

function isConfiguredBrowserOrigin(origin: string, allowedOrigins: readonly string[]): boolean {
  let actual: string;
  try {
    actual = new URL(origin).origin.toLowerCase();
  } catch {
    return false;
  }
  return allowedOrigins.some((allowed) => {
    try {
      return new URL(allowed).origin.toLowerCase() === actual;
    } catch {
      return false;
    }
  });
}

function setWidgetCorsHeaders(origin: string, res: Response): void {
  res.setHeader('access-control-allow-origin', origin);
  res.append('vary', 'Origin');
}

function deviceIdFromBody(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const deviceId = (body as Record<string, unknown>).device_id;
  return typeof deviceId === 'string' ? deviceId : '';
}

function createCloudflareAccessAuthMiddleware(
  verifier: ReturnType<typeof createTokenVerifier>,
  requiredScopes: readonly string[],
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const assertion = req.get('cf-access-jwt-assertion');
    if (!assertion) {
      res.status(401).json({ error: 'cloudflare_access_assertion_required' });
      return;
    }
    void verifier.verifyAccessToken(assertion).then((auth) => {
      const missingScopes = requiredScopes.filter((scope) => !auth.scopes.includes(scope));
      if (missingScopes.length > 0) {
        res.status(403).json({ error: 'insufficient_scope' });
        return;
      }
      req.auth = auth;
      next();
    }).catch(() => {
      res.status(401).json({ error: 'invalid_cloudflare_access_assertion' });
    });
  };
}

function isDirectLoopbackDeploymentSmoke(req: Request): boolean {
  if (req.get('x-terminal-deployment-smoke') !== '1') return false;
  const remoteAddress = req.socket.remoteAddress ?? '';
  const loopback = remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
  if (!loopback) return false;

  const hostHeader = req.get('host');
  if (!hostHeader) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') return false;

  const proxyHeaders = ['cf-connecting-ip', 'cf-ray', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'];
  return proxyHeaders.every((name) => !req.get(name));
}

function requestPrincipal(req: Request): { userId: string; clientId: string } {
  const auth = req.auth;
  const userId = typeof auth?.extra?.user_id === 'string' ? auth.extra.user_id : undefined;
  if (!auth || !userId) throw new TerminalProtocolError('PERMISSION_DENIED', 'Authenticated MCP principal is missing required identity claims.');
  return { userId, clientId: auth.clientId };
}

function isAllowedUpgradeHost(hostHeader: string | undefined, allowedHosts: readonly string[]): boolean {
  if (allowedHosts.length === 0) return true;
  if (!hostHeader) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedHosts.some((allowed) => allowed.toLowerCase() === hostname);
}

function formatSse(sequence: number, event: TerminalEvent): string {
  return `id: ${sequence}\ndata: {"sequence":${sequence},"event_type":${JSON.stringify(event.event_type)},"data":${JSON.stringify(event.data)}}\n\n`;
}

export function writeTerminalSseEvents(
  events: readonly TerminalEvent[],
  afterSequence: number,
  write: (frame: string) => boolean,
): { lastSequence: number; backpressured: boolean } {
  let lastSequence = afterSequence;
  for (const event of events) {
    if (event.sequence <= lastSequence) continue;
    const writable = write(formatSse(event.sequence, event));
    lastSequence = event.sequence;
    if (!writable) return { lastSequence, backpressured: true };
  }
  return { lastSequence, backpressured: false };
}

export interface RateLimitBucket {
  minute: number;
  count: number;
}

export function pruneRateLimitBuckets(buckets: Map<string, RateLimitBucket>, minute: number): void {
  for (const [bucketKey, bucket] of buckets) {
    if (bucket.minute < minute) buckets.delete(bucketKey);
  }
}

function createRateLimiter(
  limit: number,
  keyForRequest: (req: Request) => string = clientAddress,
  maxBuckets = 10_000,
) {
  const buckets = new Map<string, RateLimitBucket>();
  let lastPrunedMinute = -1;
  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyForRequest(req);
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== lastPrunedMinute) {
      pruneRateLimitBuckets(buckets, minute);
      lastPrunedMinute = minute;
    }
    const existing = buckets.get(key);
    if (!existing && buckets.size >= maxBuckets) {
      res.setHeader('retry-after', '60');
      res.status(429).json({ error: 'rate_limit_capacity_reached' });
      return;
    }
    const bucket = existing?.minute === minute ? existing : { minute, count: 0 };
    bucket.count += 1;
    buckets.set(key, bucket);
    if (bucket.count > limit) {
      res.setHeader('retry-after', '60');
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    next();
  };
}

function clientAddress(req: Request): string {
  const remoteAddress = req.socket.remoteAddress ?? '';
  const fromLoopbackProxy = remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
  const cloudflareAddress = fromLoopbackProxy ? req.get('cf-connecting-ip') : undefined;
  return (cloudflareAddress ?? req.ip ?? remoteAddress) || 'unknown';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
