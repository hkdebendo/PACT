// Loads the repo-root `.env.local` once (every app and script shares one env file) and exposes a
// typed, validated config. Values are never logged; `describeConfig()` reports set / not set only.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';

export function findRepoRoot(start = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    const pkg = resolve(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf8')).name === 'pact') return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

export const repoRoot = findRepoRoot();
let loaded = false;

export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  // Already-exported variables win, like Next.js. quiet: dotenv must not print anything.
  loadDotenv({ path: resolve(repoRoot, '.env.local'), quiet: true });
}

const str = (name: string, fallback = ''): string => (process.env[name] ?? '').trim() || fallback;

export function getConfig() {
  loadEnv();
  const paypalClientId = str('PAYPAL_CLIENT_ID');
  const paypalSecret = str('PAYPAL_CLIENT_SECRET');
  const requestedPaypalEnv = str('PAYPAL_ENV', 'sandbox');
  const llmMode = str('LLM_MODE', 'live') === 'replay' ? 'replay' : 'live';
  return {
    paypal: {
      // Without credentials PACT falls back to the SIMULATED adapter and says so everywhere.
      mode: (requestedPaypalEnv === 'simulated' || !paypalClientId || !paypalSecret ? 'simulated' : 'sandbox') as
        | 'sandbox'
        | 'simulated',
      requestedMode: requestedPaypalEnv,
      clientId: paypalClientId,
      clientSecret: paypalSecret,
      webhookId: str('PAYPAL_WEBHOOK_ID'),
      baseUrl: 'https://api-m.sandbox.paypal.com',
    },
    llm: {
      mode: llmMode as 'live' | 'replay',
      apiKey: str('META_API_KEY'),
      baseUrl: str('META_BASE_URL', 'https://api.meta.ai/v1'),
      model: str('MUSE_MODEL', 'muse-spark-1.3'),
      reasoningEffort: str('MUSE_REASONING_EFFORT', 'medium'),
    },
    app: {
      baseUrl: str('APP_BASE_URL', 'http://localhost:3000'),
      apiPort: Number(str('API_PORT', '4000')),
      databaseUrl: str('DATABASE_URL', 'file:./data/pact.db'),
      agentKeys: str('AGENT_API_KEYS')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
        .map((pair) => {
          const i = pair.indexOf(':');
          return i > 0 ? { name: pair.slice(0, i), key: pair.slice(i + 1) } : { name: `agent-${pair.slice(0, 4)}`, key: pair };
        }),
    },
    agStudioLicenseSet: !!str('AG_STUDIO_LICENSE_KEY'),
  };
}

export type AppConfig = ReturnType<typeof getConfig>;

export function databasePath(cfg = getConfig()): string {
  const url = cfg.app.databaseUrl;
  if (url === ':memory:' || url === 'file::memory:') return ':memory:';
  return resolve(repoRoot, url.replace(/^file:/, ''));
}
