import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import type { PactEventMessage } from '@pact/core';
import { PayPalError } from '@pact/paypal';
import type { AppContext } from './context';
import { buildOpenApi, registry } from './http/route';
import { registerRoutes } from './http/routes';
import { registerMcp } from './mcp';
import { ServiceError } from './services/errors';
import { JobRunner } from './services/jobs';
import { PactService } from './services/pacts';

export interface BuiltApp {
  app: FastifyInstance;
  pacts: PactService;
  jobs: JobRunner;
}

export async function buildApp(ctx: AppContext, opts: { logger?: boolean } = {}): Promise<BuiltApp> {
  registry.length = 0;
  const app = Fastify({
    logger: opts.logger
      ? {
          level: 'info',
          // Never log headers or bodies: they can carry agent keys or evidence.
          serializers: { req: (r) => ({ method: r.method, url: r.url }), res: (r) => ({ statusCode: r.statusCode }) },
        }
      : false,
    bodyLimit: 16 * 1024 * 1024,
  });

  // Keep the raw JSON body (needed to verify PayPal webhook signatures byte-for-byte).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (e) {
      done(Object.assign(e as Error, { statusCode: 400 }), undefined);
    }
  });

  await app.register(cors, {
    origin: [ctx.config.app.baseUrl, 'http://localhost:3000', 'http://127.0.0.1:3000'],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['content-type', 'idempotency-key', 'x-pact-actor', 'authorization', 'mcp-session-id', 'mcp-protocol-version'],
    exposedHeaders: ['idempotent-replay', 'mcp-session-id'],
  });
  await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((error, req, reply) => {
    const err = error as Error & { statusCode?: number };
    if (err instanceof ServiceError) return reply.code(err.status).send({ error: err.code, message: err.message, details: err.details ?? null });
    if (err instanceof PayPalError) return reply.code(502).send({ error: 'PAYPAL_ERROR', message: err.message, details: err.toJSON() });
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error({ err: { message: err.message, stack: err.stack } }, 'unhandled error');
    return reply.code(status).send({ error: status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST', message: err.message });
  });

  const pacts = new PactService(ctx);
  const jobs = new JobRunner(ctx, pacts);

  app.get('/health', async () => ({ ok: true }));
  app.get('/openapi.json', async () => buildOpenApi(`http://localhost:${ctx.config.app.apiPort}`));

  // Server-Sent Events: the real-time feed for the pact UI and the AG Studio dashboard.
  app.get('/api/events', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': (req.headers.origin as string) ?? '*',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(`event: hello\ndata: ${JSON.stringify({ at: ctx.now().toISOString(), paymentMode: ctx.gateway.mode, llmMode: ctx.llm.mode })}\n\n`);
    const send = (msg: PactEventMessage) => reply.raw.write(`event: ${msg.type}\ndata: ${JSON.stringify(msg)}\n\n`);
    const ping = setInterval(() => reply.raw.write(`: ping\n\n`), 15_000);
    ctx.bus.on('event', send);
    req.raw.on('close', () => {
      clearInterval(ping);
      ctx.bus.off('event', send);
    });
    reply.hijack();
  });

  registerRoutes(app, ctx, pacts, jobs);
  registerMcp(app, ctx, pacts);
  return { app, pacts, jobs };
}
