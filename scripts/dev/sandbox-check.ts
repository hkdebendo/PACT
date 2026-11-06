// Developer check against the real PayPal sandbox: reads an authorization and optionally refunds
// part of a capture. Prints statuses only.  npx tsx scripts/dev/sandbox-check.ts <authId> [captureId refundMinor]
import { getConfig } from '@pact/db';
import { SandboxGateway } from '@pact/paypal';

const cfg = getConfig();
const gw = new SandboxGateway({ clientId: cfg.paypal.clientId, clientSecret: cfg.paypal.clientSecret });
const [authId, captureId, refund] = process.argv.slice(2);
const a = await gw.getAuthorization(authId);
console.log('authorization', a.authorizationId, a.status, a.amount, 'expires', a.expiresAt);
if (captureId && refund) {
  const r = await gw.refundCapture(captureId, { minor: Number(refund), currency: 'USD' }, 'PACT sandbox check', `check-refund-${captureId}-${refund}`);
  console.log('refund', r.refundId, r.status, r.amount);
}
