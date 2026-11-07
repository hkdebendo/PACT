// Developer check: sends a 1.00 USD sandbox payout from the merchant app to the sandbox buyer test
// account (DEMO_BUYER_EMAIL) and reads the batch back. Prints statuses only, never the email.
import { getConfig, loadEnv } from '@pact/db';
import { SandboxGateway } from '@pact/paypal';

loadEnv();
const cfg = getConfig();
const email = process.env.DEMO_BUYER_EMAIL;
if (!email) throw new Error('DEMO_BUYER_EMAIL is not set');
const gw = new SandboxGateway({ clientId: cfg.paypal.clientId, clientSecret: cfg.paypal.clientSecret });
const batchId = `pact-payout-check-${Date.now()}`;
const created = await gw.createPayout(batchId, [{ receiverEmail: email, amount: { minor: 100, currency: 'USD' }, note: 'PACT sandbox payout check', senderItemId: 'item-1' }], 'PACT sandbox payout check');
console.log('payout batch', created.batchId, created.status);
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const p = await gw.getPayout(created.batchId);
  console.log('batch status', p.status, 'items', p.items.map((x) => x.status).join(','));
  if (p.status !== 'PENDING' && p.status !== 'PROCESSING') break;
}
