// Developer check of PayPal reauthorization, which is only allowed from day 4 to day 29 of an
// authorization (after the 3-day honor period).
//   npx tsx scripts/dev/reauth-check.ts create          → creates + approves + authorizes a 5.00 USD order, prints the authorization id
//   npx tsx scripts/dev/reauth-check.ts reauth <authId> → reauthorizes it (run 4+ days later), then voids both
import { randomUUID } from 'node:crypto';
import { getConfig } from '@pact/db';
import { SandboxGateway } from '@pact/paypal';
import { approveSandboxOrder } from '../lib/sandbox-approval';

const cfg = getConfig();
const gw = new SandboxGateway({ clientId: cfg.paypal.clientId, clientSecret: cfg.paypal.clientSecret });
const [cmd, authId] = process.argv.slice(2);
const usd = (minor: number) => ({ minor, currency: 'USD' });

if (cmd === 'create') {
  const order = await gw.createAuthorizeOrder({
    pactId: 'reauth-check',
    description: 'PACT reauthorization check (sandbox)',
    amount: usd(500),
    returnUrl: `${cfg.app.baseUrl}/?paypal=approved`,
    cancelUrl: `${cfg.app.baseUrl}/?paypal=cancelled`,
    requestId: `reauth-check-order-${randomUUID()}`,
  });
  await approveSandboxOrder(order.approvalUrl!, { headless: !process.argv.includes('--headed') });
  const auth = await gw.authorizeOrder(order.orderId, `reauth-check-auth-${order.orderId}`);
  console.log('authorization', auth.authorizationId, auth.status, 'created', new Date().toISOString(), 'expires', auth.expiresAt);
} else if (cmd === 'reauth' && authId) {
  const before = await gw.getAuthorization(authId);
  console.log('before', before.status, 'expires', before.expiresAt);
  const re = await gw.reauthorize(authId, usd(500), `reauth-check-reauth-${authId}`);
  console.log('reauthorized', re.authorizationId, re.status, 'expires', re.expiresAt);
  // A reauthorization cannot be voided: void the original, which voids both.
  await gw.voidAuthorization(authId, `reauth-check-void-${authId}`);
  console.log('voided the original authorization and its reauthorization (cleanup)');
} else {
  console.log('usage: create | reauth <authorizationId>');
}
process.exit(0);
