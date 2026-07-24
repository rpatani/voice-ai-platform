import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ISessionStore, ITenantConfigProvider } from '@platform/core';
import { TwilioMediaStreamSession, TwilioRestCallControl, TwilioTelephonyProvider } from '@platform/adapters-twilio';
import { getLogger, withSpan } from '@platform/observability';
import type { AppEnv } from './env.js';
import { ProviderRegistry } from './registry.js';
import { CallSession, type Repositories } from './call-session.js';

const logger = getLogger({ component: 'server' });

export interface ServerDeps {
  env: AppEnv;
  tenants: ITenantConfigProvider;
  repositories: Repositories;
  sessionStore: ISessionStore;
}

/**
 * The HTTP + WebSocket front door:
 *  - `POST /twilio/voice`  Twilio inbound-call webhook -> TwiML pointing the
 *    media stream at `/media` (signature-validated when credentials are set).
 *  - `GET  /media`         WebSocket upgrade for Twilio Media Streams.
 *  - `GET  /healthz`       liveness probe.
 */
export function createServer(deps: ServerDeps): Server {
  const telephonyProvider = new TwilioTelephonyProvider();
  const registry = new ProviderRegistry(deps.env);
  const callControl =
    deps.env.twilioAccountSid && deps.env.twilioAuthToken
      ? new TwilioRestCallControl(deps.env.twilioAccountSid, deps.env.twilioAuthToken)
      : undefined;

  const server = createHttpServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if (req.method === 'GET' && url.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/twilio/voice') {
        await handleVoiceWebhook(req, res, url);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    })().catch((err) => {
      logger.error({ err, url: req.url }, 'request handling failed');
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  async function handleVoiceWebhook(
    req: IncomingMessage,
    res: import('node:http').ServerResponse,
    url: URL,
  ): Promise<void> {
    await withSpan('http.twilio.voice', async () => {
      const body = await readBody(req);
      const params = Object.fromEntries(new URLSearchParams(body));

      if (deps.env.twilioAuthToken) {
        const signature = req.headers['x-twilio-signature'];
        const publicUrl = `https://${deps.env.publicHost}${url.pathname}`;
        const valid =
          typeof signature === 'string' &&
          telephonyProvider.validateSignature(deps.env.twilioAuthToken, signature, publicUrl, params);
        if (!valid) {
          logger.warn({ url: url.pathname }, 'rejected webhook with invalid Twilio signature');
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('invalid signature');
          return;
        }
      }

      const call = telephonyProvider.parseInboundCall(params);
      const tenant = await deps.tenants.resolveTenantByPhoneNumber(call.toNumber);
      if (!tenant) {
        logger.warn({ toNumber: call.toNumber }, 'no tenant configured for dialed number');
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('unknown number');
        return;
      }

      const streamParams = new URLSearchParams({
        tenantId: tenant.tenantId,
        from: call.fromNumber,
        to: call.toNumber,
      });
      const streamUrl = `wss://${deps.env.publicHost}/media?${streamParams.toString()}`;
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(telephonyProvider.buildStreamResponse(streamUrl));
      logger.info({ callId: call.callId, tenantId: tenant.tenantId }, 'inbound call accepted');
    });
  }

  const wss = new WebSocketServer({ server, path: '/media' });
  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    void handleMediaConnection(socket, req).catch((err) => {
      logger.error({ err }, 'media connection setup failed');
      socket.close();
    });
  });

  async function handleMediaConnection(socket: WebSocket, req: IncomingMessage): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const tenantId = url.searchParams.get('tenantId');
    const fromNumber = url.searchParams.get('from') ?? 'unknown';
    const toNumber = url.searchParams.get('to') ?? 'unknown';
    if (!tenantId) {
      logger.warn('media connection without tenantId; closing');
      socket.close();
      return;
    }
    const tenant = await deps.tenants.getTenantConfig(tenantId);

    const mediaSession = new TwilioMediaStreamSession(
      { send: (data) => socket.send(data), close: () => socket.close() },
      callControl,
    );
    socket.on('message', (raw) => mediaSession.handleMessage(raw.toString()));
    socket.on('close', () => mediaSession.handleSocketClosed());

    mediaSession.onStart(() => {
      const ttsOptions = {
        voiceId: tenant.providerOptions['elevenlabs']?.['voiceId'] as string | undefined,
      };
      const callSession = new CallSession({
        telephony: mediaSession,
        stt: registry.stt(tenant),
        llm: registry.llm(tenant),
        tts: registry.tts(tenant),
        calendar: registry.calendar(tenant),
        tenant,
        repositories: deps.repositories,
        sessionStore: deps.sessionStore,
        fromNumber,
        toNumber,
        ttsOptions,
      });
      void callSession.start().catch((err) => {
        logger.error({ err, tenantId }, 'call session failed to start');
        void mediaSession.hangup().catch(() => {});
      });
      void callSession.waitForClose().then(() => socket.close());
    });
  }

  return server;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
