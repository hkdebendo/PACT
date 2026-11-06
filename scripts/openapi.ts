// npm run openapi — writes docs/openapi.json (OpenAPI 3.1 generated from the routes' Zod schemas)
// and docs/pact.postman_collection.json (a Postman v2.1 collection derived from it).
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getConfig, openDb, repoRoot } from '@pact/db';
import { SimulatedGateway } from '@pact/paypal';
import { buildApp } from '../apps/api/src/app';
import { createContext } from '../apps/api/src/context';
import { buildOpenApi } from '../apps/api/src/http/route';

const sim = new SimulatedGateway();
const ctx = createContext({ db: openDb(':memory:'), gateway: sim, simulated: sim, config: getConfig() });
await buildApp(ctx); // registers the routes
const doc = buildOpenApi('http://localhost:4000');
writeFileSync(resolve(repoRoot, 'docs', 'openapi.json'), JSON.stringify(doc, null, 2) + '\n');

type Op = { summary: string; tags: string[]; requestBody?: { content: { 'application/json': { schema: unknown } } } };
const items: Record<string, unknown[]> = {};
for (const [path, methods] of Object.entries(doc.paths)) {
  for (const [method, op] of Object.entries(methods as Record<string, Op>)) {
    const tag = op.tags[0] ?? 'misc';
    (items[tag] ??= []).push({
      name: op.summary,
      request: {
        method: method.toUpperCase(),
        header: [
          { key: 'Content-Type', value: 'application/json' },
          { key: 'x-pact-actor', value: 'postman:you' },
        ],
        url: { raw: `{{baseUrl}}${path.replace(/\{(\w+)\}/g, ':$1')}`, host: ['{{baseUrl}}'], path: path.replace(/\{(\w+)\}/g, ':$1').split('/').filter(Boolean) },
        ...(op.requestBody && { body: { mode: 'raw', raw: '{}', options: { raw: { language: 'json' } } } }),
      },
    });
  }
}
const collection = {
  info: { name: 'PACT API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', description: 'Generated from docs/openapi.json by npm run openapi.' },
  variable: [{ key: 'baseUrl', value: 'http://localhost:4000' }],
  item: Object.entries(items).map(([name, item]) => ({ name, item })),
};
writeFileSync(resolve(repoRoot, 'docs', 'pact.postman_collection.json'), JSON.stringify(collection, null, 2) + '\n');
console.log(`Wrote docs/openapi.json (${Object.keys(doc.paths).length} paths) and docs/pact.postman_collection.json`);
process.exit(0);
