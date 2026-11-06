// Developer check of the cancel → void path against the running API (real sandbox when configured):
// create a small pact, fund it (Playwright sandbox approval), capture nothing, cancel → void.
import { getConfig } from '@pact/db';
import { approveSandboxOrder } from '../lib/sandbox-approval';

const API = `http://localhost:${getConfig().app.apiPort}`;
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', 'x-pact-actor': 'dev:void-check' }, body: body ? JSON.stringify(body) : undefined });
  const j = (await r.json()) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!r.ok) throw new Error(`${path}: ${j.message}`);
  return j;
};
const d = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const contract = {
  title: 'Void check: 2 plain mugs',
  description: 'Sandbox check of the cancel and void path.',
  buyer: { name: 'Void Check Buyer', email: null },
  seller: { name: 'Void Check Seller', email: null },
  currency: 'USD',
  totalAmount: 12,
  deadline: d(5),
  milestones: [{ id: 'm1', title: 'Delivery', percent: 100, criteria: [{ id: 'c1', text: 'Two plain mugs are delivered' }], evidenceTypes: ['photo'], deadline: null }],
  subcontractors: [],
  disputePolicy: { windowHours: 24, resolution: 'ai_arbiter_with_human_appeal', notes: null },
};
const p = await call('POST', '/api/pacts', { contract, buyer: { name: 'Void Check Buyer' }, seller: { name: 'Void Check Seller' } });
await call('POST', `/api/pacts/${p.id}/propose`);
await call('POST', `/api/pacts/${p.id}/accept`);
const f = await call('POST', `/api/pacts/${p.id}/fund`);
if (f.paymentMode === 'sandbox') await approveSandboxOrder(f.approvalUrl);
else await call('POST', `/api/pacts/${p.id}/simulated-approve`);
await call('POST', `/api/pacts/${p.id}/fund/confirm`);
const c = await call('POST', `/api/pacts/${p.id}/cancel`, { reason: 'void check' });
console.log(p.id, c.status, 'held', c.heldMinor, 'voided', c.voidedMinor);
console.log(c.payments.map((x: { kind: string; status: string; amountMinor: number }) => `${x.kind}:${x.status}:${x.amountMinor}`).join(' | '));
process.exit(0);
