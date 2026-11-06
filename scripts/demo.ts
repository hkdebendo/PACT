// npm run demo — plays the demo scenario against the running PACT API (start `npm run dev` first).
//
//   1. Two Muse agents (buyer, seller) negotiate and execute a pact over MCP.
//   2. The buyer's PayPal approval: Playwright in sandbox mode (DEMO_BUYER_EMAIL/PASSWORD),
//      the SIMULATED approval endpoint in simulated mode.
//   3. A short dispute variant (REST): contested delivery → Arbiter decision → refund/void.
//
// With LLM_MODE=replay every model answer comes from fixtures/llm-cache/ (no Meta key needed).
// Flags: --no-agents (drive the main scenario over REST instead), --no-dispute, --api=http://...
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getConfig, repoRoot } from '@pact/db';
import { LlmClient, parseContract } from '@pact/llm';
import { runScenario, DEMO_DEAL, DEMO_TODAY, type AgentEvent } from '@pact/agents';
import { approveSandboxOrder } from './lib/sandbox-approval';

const args = new Set(process.argv.slice(2));
const API = [...args].find((a) => a.startsWith('--api='))?.slice(6) ?? `http://localhost:${getConfig().app.apiPort}`;
const cfg = getConfig();

const c = { dim: '\x1b[2m', cyan: '\x1b[36m', magenta: '\x1b[35m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', reset: '\x1b[0m', bold: '\x1b[1m' };
const log = (s: string) => console.log(s);

async function api<T = any>(method: 'GET' | 'POST', path: string, body?: unknown, actor = 'demo:script'): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-pact-actor': actor },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.error ?? ''}: ${json.message ?? ''}`);
  return json as T;
}

async function approve(approvalUrl: string, pactId: string) {
  const status = await api('GET', '/api/status');
  if (status.paymentMode === 'simulated') {
    log(`${c.yellow}  [SIMULATED] buyer approval (no real PayPal checkout in simulated mode)${c.reset}`);
    await api('POST', `/api/pacts/${pactId}/simulated-approve`, undefined, 'buyer:Ada');
    return;
  }
  log(`${c.yellow}  Opening PayPal sandbox checkout with the sandbox buyer test account…${c.reset}`);
  await approveSandboxOrder(approvalUrl, { headless: !args.has('--headed') });
  log(`${c.green}  Buyer approved in PayPal sandbox.${c.reset}`);
}

function printEvent(e: AgentEvent) {
  const who = e.agent === 'buyer-agent' ? `${c.cyan}buyer ${c.reset}` : `${c.magenta}seller${c.reset}`;
  if (e.kind === 'tool_call') log(`${who} → ${c.bold}${e.tool}${c.reset} ${c.dim}${JSON.stringify(e.args).slice(0, 140)}${c.reset}`);
  else if (e.kind === 'tool_result') {
    const short = e.text.replace(/\s+/g, ' ').slice(0, 160);
    log(`${who}   ${c.dim}${short}${c.reset}`);
  } else if (e.kind === 'thought' || e.kind === 'done') {
    if (e.text) log(`${who} 💬 ${e.text.replace(/\s+/g, ' ').slice(0, 220)}`);
  } else log(`${who} ${c.red}${e.text}${c.reset}`);
}

async function restScenario(llm: LlmClient) {
  // Same story without agents: useful to record the Verifier/Arbiter cache deterministically.
  const parsed = await parseContract(llm, { text: DEMO_DEAL, today: DEMO_TODAY, buyerName: 'Ada (buyer agent)', sellerName: 'Kofi Textiles' });
  if (!parsed.value.contract) throw new Error(`Parser asked: ${parsed.value.questions.join(' ')}`);
  const pact = await api('POST', '/api/pacts', { contract: parsed.value.contract, sourceText: DEMO_DEAL, buyer: { name: 'Ada (buyer agent)', kind: 'agent' }, seller: { name: 'Kofi Textiles', kind: 'agent' } }, 'agent:buyer-agent');
  await api('POST', `/api/pacts/${pact.id}/propose`, undefined, 'agent:buyer-agent');
  await api('POST', `/api/pacts/${pact.id}/accept`, undefined, 'agent:seller-agent');
  const fund = await api('POST', `/api/pacts/${pact.id}/fund`, undefined, 'agent:buyer-agent');
  await approve(fund.approvalUrl, pact.id);
  await api('POST', `/api/pacts/${pact.id}/fund/confirm`, undefined, 'agent:buyer-agent');
  const [m1, m2] = pact.milestones.map((m: { id: string }) => m.id);
  for (const [mid, file, type] of [
    [m1, 'order_wrong_item.jpg', 'photo'],
    [m1, 'order_conforming.jpg', 'photo'],
    [m2, 'tracking_valid.png', 'tracking'],
  ] as const) {
    await submit(pact.id, mid, file, type);
    const v = await api('POST', `/api/pacts/${pact.id}/milestones/${mid}/verify`, {}, 'agent:seller-agent');
    log(`  ${mid} ${file}: ${v.verdict.status} (${v.verdict.confidence}) ${c.dim}${v.verdict.reasoning.slice(0, 120)}${c.reset}`);
  }
  return { pactId: pact.id as string };
}

async function submit(pactId: string, mid: string, file: string, type: string) {
  const bytes = readFileSync(resolve(repoRoot, 'fixtures', 'evidence', file));
  return api('POST', `/api/pacts/${pactId}/milestones/${mid}/evidence`, { filename: file, contentBase64: bytes.toString('base64'), type }, 'agent:seller-agent');
}

async function disputeVariant(llm: LlmClient) {
  log(`\n${c.bold}Dispute variant${c.reset}`);
  const text = 'Logo-free tote bags: 20 plain canvas tote bags, 200 USD, 100% on delivery within 5 days. Delivery must show 20 bags.';
  const parsed = await parseContract(llm, { text, today: DEMO_TODAY, buyerName: 'Bea (buyer)', sellerName: 'Nia Crafts' });
  if (!parsed.value.contract) throw new Error('parser needs clarification for dispute deal');
  const pact = await api('POST', '/api/pacts', { contract: parsed.value.contract, sourceText: text, buyer: { name: 'Bea (buyer)' }, seller: { name: 'Nia Crafts' } }, 'buyer:Bea');
  await api('POST', `/api/pacts/${pact.id}/propose`, undefined, 'buyer:Bea');
  await api('POST', `/api/pacts/${pact.id}/accept`, undefined, 'seller:Nia');
  const fund = await api('POST', `/api/pacts/${pact.id}/fund`, undefined, 'buyer:Bea');
  await approve(fund.approvalUrl, pact.id);
  await api('POST', `/api/pacts/${pact.id}/fund/confirm`, undefined, 'buyer:Bea');
  const mid = pact.milestones[0].id;
  await submit(pact.id, mid, 'delivery_partial.jpg', 'photo');
  const v = await api('POST', `/api/pacts/${pact.id}/milestones/${mid}/verify`, {}, 'seller:Nia');
  log(`  Verifier: ${v.verdict.status} — ${c.dim}${v.verdict.reasoning.slice(0, 140)}${c.reset}`);
  await api('POST', `/api/pacts/${pact.id}/milestones/${mid}/dispute`, { party: 'seller', statement: 'All 20 bags were delivered; some are folded behind the others in the photo.' }, 'seller:Nia');
  await api('POST', `/api/pacts/${pact.id}/milestones/${mid}/statement`, { party: 'buyer', statement: 'I counted 12 bags in the box. 8 are missing.' }, 'buyer:Bea');
  const arb = await api('POST', `/api/pacts/${pact.id}/milestones/${mid}/arbitrate`, undefined, 'buyer:Bea');
  log(`  Arbiter: ${c.bold}${arb.verdict.status}${c.reset} (${arb.verdict.arbiter?.releasePercent}% to seller) — ${c.dim}${arb.verdict.reasoning.slice(0, 160)}${c.reset}`);
  log(`  Money: ${JSON.stringify(arb.money)}`);
  return { pactId: pact.id as string, verdictId: arb.verdict.id as string };
}

async function main() {
  const status = await api('GET', '/api/status').catch(() => {
    throw new Error(`PACT API is not reachable at ${API}. Start it first: npm run dev`);
  });
  log(`${c.bold}PACT demo${c.reset}  API ${API}`);
  log(`  PayPal: ${status.paymentMode === 'sandbox' ? c.green + 'REAL sandbox' : c.yellow + 'SIMULATED (not real PayPal)'}${c.reset}   LLM: ${status.llmModel} ${status.llmMode === 'replay' ? c.yellow + '(replay: recorded responses)' : c.green + '(live)'}${c.reset}`);
  // The demo script itself also calls the parser (REST paths); it shares the API's cache directory.
  const llm = new LlmClient({ mode: cfg.llm.mode, apiKey: cfg.llm.apiKey, baseUrl: cfg.llm.baseUrl, model: cfg.llm.model, reasoningEffort: cfg.llm.reasoningEffort, cacheDir: resolve(repoRoot, 'fixtures', 'llm-cache') });

  let main: { pactId: string };
  if (args.has('--no-agents')) {
    main = await restScenario(llm);
  } else {
    const keys = cfg.app.agentKeys.length ? cfg.app.agentKeys : null;
    const buyerKey = keys?.find((k) => k.name === 'buyer-agent')?.key ?? 'local-demo-buyer';
    const sellerKey = keys?.find((k) => k.name === 'seller-agent')?.key ?? 'local-demo-seller';
    main = await runScenario({ llm, mcpUrl: `${API}/mcp`, buyerKey, sellerKey, approveFunding: approve, onEvent: printEvent });
  }
  const pact = await api('GET', `/api/pacts/${main.pactId}`);
  log(`\n${c.green}Main pact ${pact.id}: ${pact.status}. Released ${pact.releasedMinor / 100} ${pact.currency}, held ${pact.heldMinor / 100}.${c.reset}`);
  if (!args.has('--no-dispute')) await disputeVariant(llm);
  const chain = await api('GET', '/api/audit/verify');
  log(`\nAudit chain: ${chain.ok ? c.green + 'verified' : c.red + 'BROKEN'}${c.reset} (${chain.count} entries, head ${chain.headHash.slice(0, 16)}…)`);
  log(`Open the Control Tower: ${cfg.app.baseUrl}/control-tower`);
}

main().catch((e) => {
  console.error(`${c.red}${(e as Error).message}${c.reset}`);
  process.exit(1);
});
