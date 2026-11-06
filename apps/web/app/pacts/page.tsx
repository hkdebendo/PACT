'use client';
import Link from 'next/link';
import type { PactView } from '@pact/core/browser';
import { useLive } from '@/lib/api';
import { EscrowBar } from '@/components/pact-parts';
import { Badge, Card, ErrorNote, PACT_TONE, Skeleton, label, money } from '@/components/ui';

export default function PactsPage() {
  const { data, error, loading } = useLive<PactView[]>('/api/pacts', (e) => e.type === 'pact.updated' || e.type === 'payment.updated');
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <div className="text-[11px] font-semibold tracking-[0.18em] text-muted uppercase">Ledger</div>
          <h1 className="font-display mt-1 text-4xl">Pacts</h1>
        </div>
        <Link href="/pacts/new" className="inline-flex h-10 items-center rounded-full bg-navy px-4 text-sm font-medium text-paper">
          New pact
        </Link>
      </div>
      <ErrorNote error={error} />
      {loading && <Skeleton className="h-40" />}
      {data && data.length === 0 && (
        <Card className="p-10 text-center text-ink-2">
          No pacts yet. <Link className="underline" href="/pacts/new">Write the first one</Link>, run <span className="hash">npm run demo</span>, or seed history with <span className="hash">npm run seed</span>.
        </Card>
      )}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data?.map((p) => (
          <Link key={p.id} href={`/pacts/${p.id}`} className="group">
            <Card className="h-full p-5 transition-transform group-hover:-translate-y-0.5">
              <div className="flex items-start justify-between gap-3">
                <h2 className="font-display text-xl leading-tight text-ink">{p.title}</h2>
                <Badge tone={PACT_TONE[p.status]} dot>
                  {label(p.status)}
                </Badge>
              </div>
              <div className="mt-1 text-[13px] text-muted">
                {p.buyer.name} → {p.seller.name}
              </div>
              <div className="font-display mt-4 text-2xl">{money(p.totalMinor, p.currency)}</div>
              <div className="mt-3">
                <EscrowBar pact={p} compact />
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {p.milestones.map((m) => (
                  <span key={m.id} className="text-[12px] text-ink-2">
                    {m.title} <span className="text-muted">· {label(m.status)}</span>
                  </span>
                ))}
              </div>
              {p.paymentMode === 'simulated' && <div className="mt-3 text-[11px] text-held">SIMULATED PayPal</div>}
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
