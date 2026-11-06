'use client';
// Buyer funding step. Sandbox: PayPal JS SDK buttons (intent=authorize) on the order PACT created,
// plus the redirect approval link. Simulated: a clearly labelled stand-in approval.
import { PayPalButtons, PayPalScriptProvider } from '@paypal/react-paypal-js';
import { useState } from 'react';
import type { PactView } from '@pact/core/browser';
import { api, ApiError } from '@/lib/api';
import { Button, ErrorNote, money } from '@/components/ui';

export function Funding({ pact, paypalClientId }: { pact: PactView; paypalClientId: string | null }) {
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const createOrder = async () => {
    const r = await api<{ orderId: string; approvalUrl: string | null }>('POST', `/api/pacts/${pact.id}/fund`, undefined, { idempotencyKey: `fund-${pact.id}` });
    return r.orderId;
  };
  const confirm = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api('POST', `/api/pacts/${pact.id}/fund/confirm`);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  const simulated = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (!pact.orderId) await createOrder();
      await api('POST', `/api/pacts/${pact.id}/simulated-approve`);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-held/30 bg-held-soft/40 p-5">
      <h3 className="font-display text-xl text-ink">Secure {money(pact.totalMinor, pact.currency)} with PayPal</h3>
      <p className="mt-1 text-[14px] text-ink-2">
        PayPal <b>authorizes</b> the payment: the money is held, not charged. PACT captures each milestone’s share only when the Verifier approves it. Whatever is never released is voided.
      </p>
      <div className="mt-4">
        {pact.paymentMode === 'sandbox' && paypalClientId ? (
          <div className="max-w-sm">
            <PayPalScriptProvider options={{ clientId: paypalClientId, intent: 'authorize', currency: pact.currency, components: 'buttons' }}>
              <PayPalButtons style={{ layout: 'horizontal', shape: 'pill', label: 'paypal', tagline: false }} createOrder={createOrder} onApprove={confirm} onError={(e) => setErr(new ApiError(0, 'PAYPAL_SDK', String((e as unknown as Error)?.message ?? e)))} />
            </PayPalScriptProvider>
            <p className="mt-2 text-[12px] text-muted">
              Sandbox only. Or {pact.approvalUrl ? <a className="underline" href={pact.approvalUrl}>open the PayPal approval page</a> : <button className="underline" onClick={() => createOrder().then(() => location.reload())}>create the approval link</button>} and come back.
            </p>
          </div>
        ) : pact.paymentMode === 'sandbox' ? (
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => createOrder().then(() => location.reload())}>Create PayPal order</Button>
            {pact.approvalUrl && (
              <a href={pact.approvalUrl} className="inline-flex h-10 items-center rounded-full border border-line bg-surface px-4 text-sm">
                Approve in PayPal sandbox →
              </a>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={simulated} loading={busy}>
              Approve (SIMULATED PayPal)
            </Button>
            <span className="text-[12px] text-muted">Simulated mode: no PayPal account is involved. Set PAYPAL_CLIENT_ID/SECRET for the real sandbox.</span>
          </div>
        )}
        {pact.orderId && (
          <div className="mt-3 flex items-center gap-3 text-[12px] text-muted">
            <span className="hash">order {pact.orderId}</span>
            <Button size="sm" variant="ghost" onClick={confirm} loading={busy}>
              I approved — check now
            </Button>
          </div>
        )}
      </div>
      <ErrorNote error={err} />
    </div>
  );
}
