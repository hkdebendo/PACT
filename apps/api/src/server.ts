import { buildApp } from './app';
import { createContext } from './context';

const ctx = createContext();
const { app, jobs } = await buildApp(ctx, { logger: true });

jobs.start();
const port = ctx.config.app.apiPort;
await app.listen({ port, host: '127.0.0.1' });

// Startup banner: modes only, never secrets.
const lines = [
  `PACT API on http://localhost:${port}  (OpenAPI: /openapi.json, MCP: /mcp, SSE: /api/events)`,
  `PayPal: ${ctx.gateway.mode === 'sandbox' ? 'REAL sandbox (api-m.sandbox.paypal.com)' : 'SIMULATED adapter — not real PayPal (' + (ctx.config.paypal.requestedMode === 'simulated' ? 'PAYPAL_ENV=simulated' : 'sandbox credentials not set') + ')'}`,
  `LLM: ${ctx.llm.model} via ${ctx.config.llm.baseUrl} — mode ${ctx.llm.mode}${ctx.llm.mode === 'live' && !ctx.llm.liveAvailable ? ' (META_API_KEY not set: AI calls will fail; use LLM_MODE=replay)' : ''}`,
  `MCP agents configured: ${ctx.config.app.agentKeys.length}`,
];
for (const l of lines) console.log(l);

const shutdown = async () => {
  jobs.stop();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
