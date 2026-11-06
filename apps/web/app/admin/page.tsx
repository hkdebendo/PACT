'use client';
import { useState } from 'react';
import { api, useLive } from '@/lib/api';
import { ChainBadge } from '@/components/pact-parts';
import type { RuntimeStatus } from '@/components/shell';
import { Badge, Button, Card, SectionTitle } from '@/components/ui';

interface Usage {
  model: string;
  mode: string;
  totals: { calls: number; liveCalls: number; costUsd: number; inputTokens: number; outputTokens: number; reasoningTokens: number };
  byRole: Record<string, { calls: number; costUsd: number; inputTokens: number; outputTokens: number; cacheHits: number }>;
  recent: { id: string; role: string; model: string; mode: string; cacheHit: boolean; inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number; createdAt: string }[];
}
interface Job {
  id: string;
  type: string;
  status: string;
  runAt: string;
  attempts: number;
  lastError: string | null;
}
interface Call {
  at: string;
  operation: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  debugId: string | null;
}

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

export default function AdminPage() {
  const { data: status } = useLive<RuntimeStatus & { mcpAgents: string[] }>('/api/status', () => false);
  const { data: usage } = useLive<Usage>('/api/admin/usage', (e) => e.type === 'audit.appended');
  const { data: jobs, reload: reloadJobs } = useLive<Job[]>('/api/admin/jobs', (e) => e.type === 'audit.appended');
  const { data: calls } = useLive<Call[]>('/api/admin/paypal-calls', (e) => e.type === 'payment.updated');
  const [recon, setRecon] = useState<string | null>(null);
  return (
    <div className="mx-auto w-full max-w-7xl space-y-8 px-4 py-10 sm:px-6">
      <div>
        <div className="text-[11px] font-semibold tracking-[0.18em] text-muted uppercase">Operations</div>
        <h1 className="font-display mt-1 text-4xl">Admin</h1>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        {[
          ['PayPal', status?.paymentMode === 'sandbox' ? 'Real sandbox' : 'SIMULATED', status?.paymentMode === 'sandbox'],
          ['AI', `${status?.llmModel ?? ''} · ${status?.llmMode ?? ''}`, status?.llmMode === 'live' && status?.llmLiveAvailable],
          ['AG Studio licence', status?.agStudioLicense ? 'Set' : 'Not set (watermark)', status?.agStudioLicense],
          ['Webhook verification', status?.webhookVerification ? 'PAYPAL_WEBHOOK_ID set' : 'Poller only (no public URL)', status?.webhookVerification],
        ].map(([k, v, ok]) => (
          <Card key={k as string} className="p-4">
            <div className="text-[12px] text-muted">{k as string}</div>
            <div className="mt-1 flex items-center gap-2 font-semibold">
              <span className={`size-2 rounded-full ${ok ? 'bg-released' : 'bg-held'}`} />
              {v as string}
            </div>
          </Card>
        ))}
      </div>

      <Card className="p-6">
        <SectionTitle eyebrow="Meta Model API" title="Muse usage and cost" action={<Badge tone="navy">{usage ? usd(usage.totals.costUsd) : '—'} spent</Badge>} />
        {usage && (
          <>
            <div className="grid gap-4 text-[13px] sm:grid-cols-4">
              <div>Calls <b className="hash block text-xl">{usage.totals.calls}</b></div>
              <div>Live (billed) <b className="hash block text-xl">{usage.totals.liveCalls}</b></div>
              <div>Input tokens <b className="hash block text-xl">{usage.totals.inputTokens.toLocaleString()}</b></div>
              <div>Output tokens <b className="hash block text-xl">{usage.totals.outputTokens.toLocaleString()}</b></div>
            </div>
            <table className="mt-5 w-full text-left text-[13px]">
              <thead className="text-muted">
                <tr><th className="py-1">Role</th><th>Calls</th><th>Replayed</th><th>In</th><th>Out</th><th>Cost</th></tr>
              </thead>
              <tbody>
                {Object.entries(usage.byRole).map(([role, r]) => (
                  <tr key={role} className="border-t border-line-2">
                    <td className="py-1.5 font-medium">{role}</td><td className="hash">{r.calls}</td><td className="hash">{r.cacheHits}</td><td className="hash">{r.inputTokens}</td><td className="hash">{r.outputTokens}</td><td className="hash">{usd(r.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-[12px] text-muted">Priced at Meta’s published rates for {usage.model} (USD per 1M tokens: 1.25 input, 0.15 cached input, 4.25 output). Replayed calls cost nothing.</p>
          </>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-6">
          <SectionTitle
            eyebrow="Jobs"
            title="Scheduler & reconciliation"
            action={
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => api('POST', '/api/admin/jobs/run').then(reloadJobs)}>Run due jobs</Button>
                <Button size="sm" onClick={() => api<Record<string, number>>('POST', '/api/admin/reconcile').then((r) => setRecon(JSON.stringify(r)))}>Reconcile now</Button>
              </div>
            }
          />
          {recon && <div className="hash mb-3 rounded-lg bg-paper-2 p-2 text-ink-2">{recon}</div>}
          <ul className="max-h-80 space-y-1 overflow-auto text-[13px]">
            {jobs?.length === 0 && <li className="text-muted">No jobs yet (re-authorization and expiry jobs are created when a pact is funded).</li>}
            {jobs?.map((j) => (
              <li key={j.id} className="flex gap-3 border-b border-line-2 py-1.5">
                <span className="w-24 font-medium">{j.type}</span>
                <Badge tone={j.status === 'done' ? 'released' : j.status === 'failed' ? 'refund' : 'held'}>{j.status}</Badge>
                <span className="text-muted">{new Date(j.runAt).toLocaleString()}</span>
                {j.lastError && <span className="truncate text-refund">{j.lastError}</span>}
              </li>
            ))}
          </ul>
        </Card>
        <Card className="p-6">
          <SectionTitle eyebrow="PayPal" title="Recent sandbox API calls" action={<ChainBadge />} />
          {status?.paymentMode !== 'sandbox' && <p className="text-[13px] text-muted">Simulated mode: no PayPal calls are made.</p>}
          <ul className="max-h-80 space-y-1 overflow-auto text-[12px]">
            {calls?.map((c, i) => (
              <li key={i} className="grid grid-cols-[70px_1fr_50px_60px] gap-2 border-b border-line-2 py-1">
                <span className="text-muted">{new Date(c.at).toLocaleTimeString()}</span>
                <span className="hash truncate">{c.method} {c.path.split('?')[0]}</span>
                <span className={c.status < 400 ? 'text-released' : 'text-refund'}>{c.status}</span>
                <span className="text-muted">{c.ms} ms</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
