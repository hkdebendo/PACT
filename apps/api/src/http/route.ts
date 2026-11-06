// A tiny route registry: each route declares Zod schemas for params/query/body, which are used both
// to validate requests and to generate the committed OpenAPI 3.1 document (docs/openapi.json).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ServiceError } from '../services/errors';
import { eq, tables } from '@pact/db';
import type { AppContext } from '../context';

export interface RouteSpec<P extends z.ZodType, Q extends z.ZodType, B extends z.ZodType> {
  method: 'GET' | 'POST';
  url: string; // fastify style: /api/pacts/:id
  summary: string;
  description?: string;
  tags: string[];
  params?: P;
  query?: Q;
  body?: B;
  idempotent?: boolean; // honours the Idempotency-Key header
  response?: string; // short description of the 200 response
  handler: (input: { params: z.infer<P>; query: z.infer<Q>; body: z.infer<B>; actor: string; req: FastifyRequest; reply: FastifyReply }) => Promise<unknown> | unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const registry: RouteSpec<any, any, any>[] = [];

export function actorOf(req: FastifyRequest): string {
  const h = req.headers['x-pact-actor'];
  const raw = (Array.isArray(h) ? h[0] : h) ?? 'web:anonymous';
  return raw.replace(/[^A-Za-z0-9:_@.\- ]/g, '').slice(0, 80) || 'web:anonymous';
}

export function defineRoute<P extends z.ZodType = z.ZodObject<{}>, Q extends z.ZodType = z.ZodObject<{}>, B extends z.ZodType = z.ZodObject<{}>>(
  app: FastifyInstance,
  ctx: AppContext,
  spec: RouteSpec<P, Q, B>,
) {
  registry.push(spec);
  app.route({
    method: spec.method,
    url: spec.url,
    handler: async (req, reply) => {
      const parse = <T extends z.ZodType>(schema: T | undefined, value: unknown, where: string): z.infer<T> => {
        if (!schema) return {} as z.infer<T>;
        const r = schema.safeParse(value ?? {});
        if (!r.success) throw new ServiceError('VALIDATION_ERROR', `Invalid ${where}: ${z.prettifyError(r.error)}`, 400, r.error.issues);
        return r.data;
      };
      const params = parse(spec.params, req.params, 'path parameters');
      const query = parse(spec.query, req.query, 'query');
      const isMultipart = req.isMultipart?.() ?? false;
      const body = isMultipart ? ({} as z.infer<B>) : parse(spec.body, req.body, 'body');
      const actor = actorOf(req);

      const key = spec.idempotent ? (req.headers['idempotency-key'] as string | undefined) : undefined;
      const scope = `${spec.method} ${req.url}`;
      if (key) {
        const hit = ctx.db.select().from(tables.idempotency).where(eq(tables.idempotency.key, `${scope}#${key}`)).get();
        if (hit) {
          reply.header('Idempotent-Replay', 'true');
          return reply.code(hit.statusCode).send(JSON.parse(hit.responseJson));
        }
      }
      const result = await spec.handler({ params, query, body, actor, req, reply });
      if (reply.sent) return reply;
      if (key) {
        ctx.db
          .insert(tables.idempotency)
          .values({ key: `${scope}#${key}`, scope, statusCode: reply.statusCode, responseJson: JSON.stringify(result ?? null), createdAt: new Date().toISOString() })
          .onConflictDoNothing()
          .run();
      }
      return result;
    },
  });
}

// --- OpenAPI 3.1 --------------------------------------------------------------------------

const toJson = (s: z.ZodType) => {
  const j = z.toJSONSchema(s, { target: 'draft-2020-12', unrepresentable: 'any' }) as Record<string, unknown>;
  delete j.$schema;
  return j;
};

export function buildOpenApi(serverUrl = 'http://localhost:4000') {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of registry) {
    const path = r.url.replace(/:([A-Za-z]+)/g, '{$1}');
    const params: unknown[] = [];
    if (r.params) {
      const props = (toJson(r.params).properties ?? {}) as Record<string, unknown>;
      for (const [name, schema] of Object.entries(props)) params.push({ name, in: 'path', required: true, schema });
    }
    if (r.query) {
      const j = toJson(r.query);
      const req = new Set((j.required as string[]) ?? []);
      for (const [name, schema] of Object.entries((j.properties ?? {}) as Record<string, unknown>)) params.push({ name, in: 'query', required: req.has(name), schema });
    }
    if (r.idempotent) params.push({ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' }, description: 'Replays the stored response for a repeated key' });
    params.push({ name: 'x-pact-actor', in: 'header', required: false, schema: { type: 'string' }, description: 'Who is acting, e.g. buyer:Ada (demo identity, not authentication)' });
    (paths[path] ??= {})[r.method.toLowerCase()] = {
      summary: r.summary,
      ...(r.description && { description: r.description }),
      tags: r.tags,
      parameters: params,
      ...(r.body && { requestBody: { required: true, content: { 'application/json': { schema: toJson(r.body) } } } }),
      responses: {
        '200': { description: r.response ?? 'OK', content: { 'application/json': { schema: {} } } },
        '4XX': { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'PACT API',
      version: '0.1.0',
      description: 'Programmable escrow for the agent economy: natural-language contracts, PayPal-held funds, AI-verified milestones, hash-chained audit.',
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: serverUrl }],
    paths,
    components: {
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' }, details: {} }, required: ['error', 'message'] },
      },
    },
  };
}
