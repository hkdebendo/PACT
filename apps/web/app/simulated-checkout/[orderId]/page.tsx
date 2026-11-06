'use client';
// SIMULATED checkout: stands in for the PayPal approval page when PACT runs without sandbox
// credentials. It is deliberately styled as PACT, not as PayPal, and says so.
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import type { PactView } from '@pact/core/browser';
import { api, ApiError, useLive } from '@/lib/api';
import { Button, Card, ErrorNote, money } from '@/components/ui';

export default function SimulatedCheckout() {
  const { orderId } = useParams<{ orderId: string }>();
  const router = useRouter();
  const { data: pacts } = useLive<PactView[]>('/api/pacts', () => false);
  const pact = pacts?.find((p) => p.orderId === orderId);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const approve = async () => {
    if (!pact) return;
    setBusy(true);
    try {
      await api('POST', `/api/pacts/${pact.id}/simulated-approve`);
      router.push(`/pacts/${pact.id}`);
    } catch (e) {
      setErr(e as ApiError);
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto grid w-full max-w-lg flex-1 place-items-center px-4 py-16">
      <Card className="w-full p-8">
        <div className="rounded-lg bg-held-soft px-3 py-2 text-[12px] font-semibold text-held">SIMULATED checkout — this is not PayPal. No account, no money.</div>
        <h1 className="font-display mt-5 text-3xl">Authorize the escrow</h1>
        <p className="mt-2 text-[14px] text-ink-2">In sandbox mode this step happens on PayPal’s checkout page with a sandbox buyer account.</p>
        {pact ? (
          <div className="mt-6 rounded-xl border border-line p-4">
            <div className="text-[13px] text-muted">{pact.title}</div>
            <div className="font-display text-3xl">{money(pact.totalMinor, pact.currency)}</div>
            <div className="hash mt-1 text-muted">{orderId}</div>
          </div>
        ) : (
          <div className="hash mt-6 text-muted">{orderId}</div>
        )}
        <div className="mt-6 flex gap-3">
          <Button onClick={approve} loading={busy} disabled={!pact} size="lg">
            Approve (simulated)
          </Button>
          {pact && (
            <Button variant="ghost" onClick={() => router.push(`/pacts/${pact.id}?paypal=cancelled`)}>
              Cancel
            </Button>
          )}
        </div>
        <div className="mt-3">
          <ErrorNote error={err} />
        </div>
      </Card>
    </div>
  );
}
