'use client';
// Agent mandates: the limits a human owner sets for each MCP agent, the approvals the agent is
// waiting for, a dry-run tester and the log of mandate decisions. Enforcement itself is server-side
// (apps/api/src/services/mandates.ts); this page only shows and edits it.
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { MANDATE_CATEGORY_NAMES, type Mandate, type MandateCategory } from '@pact/core/browser';
import { api, ApiError, useLive } from '@/lib/api';
import { Badge, Button, Card, cx, ErrorNote, money, SectionTitle, Skeleton, type Tone } from '@/components/ui';

interface AgentRow {
  agent: string;
  mandate: Mandate | null;
  openMinor: number;
  openPacts: { id: string; title: string; status: string; totalMinor: number }[];
}
interface Approval {
  id: string;
  agent: string;
  pactId: string;
  pactTitle: string | null;
  totalMinor: number;
  currency: string;
  reasons: string[];
  status: 'pending' | 'approved' | 'denied';
  createdAt: string;
  decidedBy: string | null;
}
interface Decision {
  seq: number;
  ts: string;
  type: string;
  actor: string;
  pactId: string | null;
  data: Record<string, unknown>;
}
interface Overview {
  agents: AgentRow[];
  approvals: Approval[];
  decisions: Decision[];
}
interface Check {
  outcome: 'allowed' | 'needs_approval' | 'denied';
  reasons: string[];
  categories: string[];
  openMinor: number;
  owner: string | null;
}

const OUTCOME: Record<Check['outcome'], { tone: Tone; label: string }> = {
  allowed: { tone: 'released', label: 'Allowed' },
  needs_approval: { tone: 'held', label: 'Needs the owner' },
  denied: { tone: 'refund', label: 'Denied' },
};

const PRESETS = [
  { title: '50 embroidered t-shirts', description: 'Plain white t-shirts with a small blue star on the chest.', amount: 450 },
  { title: '40 hoodies', description: 'Grey hoodies with an embroidered logo.', amount: 800 },
  { title: '3 laptops', description: 'Refurbished laptops with chargers.', amount: 2500 },
];

const DEFAULT_MANDATE = (agent: string): Mandate => ({ agent, owner: '', active: true, currency: 'USD', maxPactMinor: 100_000, maxOpenMinor: 150_000, approvalAboveMinor: 50_000, categories: [] });

function Limit({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-line-2 bg-paper px-4 py-3">
      <div className="text-[12px] text-muted">{label}</div>
      <div className="mt-0.5 truncate text-lg font-semibold text-ink">{children}</div>
      {hint && <div className="mt-0.5 truncate text-[12px] text-muted">{hint}</div>}
    </div>
  );
}

function Meter({ used, limit }: { used: number; limit: number }) {
  const pct = Math.min(100, (used / limit) * 100);
  return (
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-paper-2" role="meter" aria-valuenow={used} aria-valuemin={0} aria-valuemax={limit} aria-label="Open budget used">
      <div className={cx('h-full rounded-full', pct > 85 ? 'bg-refund' : pct > 60 ? 'bg-held' : 'bg-released')} style={{ width: `${pct}%` }} />
    </div>
  );
}

function MandateForm({ initial, onSaved, onCancel }: { initial: Mandate; onSaved: () => void; onCancel: () => void }) {
  const [m, setM] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const major = (minor: number | null) => (minor === null ? '' : String(minor / 100));
  const minor = (v: string) => (v.trim() === '' ? null : Math.round(Number(v) * 100));
  const field = (label: string, key: 'maxPactMinor' | 'maxOpenMinor' | 'approvalAboveMinor', hint: string) => (
    <label className="block text-[13px]">
      <span className="font-medium text-ink">{label}</span>
      <span className="mt-1 flex items-center rounded-xl border border-line bg-surface px-3 focus-within:border-ink/40">
        <span className="text-muted">$</span>
        <input type="number" min={0} step="1" inputMode="decimal" className="h-10 w-full bg-transparent px-2 outline-none" value={major(m[key])} placeholder="no limit" onChange={(e) => setM({ ...m, [key]: minor(e.target.value) })} />
      </span>
      <span className="mt-1 block text-[12px] text-muted">{hint}</span>
    </label>
  );
  const toggle = (c: MandateCategory) => setM({ ...m, categories: m.categories.includes(c) ? m.categories.filter((x) => x !== c) : [...m.categories, c] });
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const { agent, ...body } = m;
      await api('POST', `/api/mandates/${encodeURIComponent(agent)}`, body);
      onSaved();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mt-5 space-y-4 rounded-2xl border border-line-2 bg-paper p-4 sm:p-5">
      <label className="block text-[13px]">
        <span className="font-medium text-ink">Owner</span>
        <input className="mt-1 h-10 w-full rounded-xl border border-line bg-surface px-3 outline-none focus:border-ink/40" value={m.owner} onChange={(e) => setM({ ...m, owner: e.target.value })} placeholder="The human this agent spends for" />
      </label>
      <div className="grid gap-4 sm:grid-cols-3">
        {field('Per pact', 'maxPactMinor', 'Largest single pact')}
        {field('Open budget', 'maxOpenMinor', 'All unsettled pacts together')}
        {field('Owner approves above', 'approvalAboveMinor', 'Agent waits for a human')}
      </div>
      <fieldset>
        <legend className="text-[13px] font-medium text-ink">Allowed categories <span className="font-normal text-muted">(none selected = any)</span></legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {MANDATE_CATEGORY_NAMES.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={m.categories.includes(c)}
              onClick={() => toggle(c)}
              className={cx('rounded-full border px-3 py-1 text-[13px] transition-colors', m.categories.includes(c) ? 'border-navy bg-navy text-paper' : 'border-line bg-surface text-ink-2 hover:border-ink/30')}
            >
              {c}
            </button>
          ))}
        </div>
      </fieldset>
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={m.active} onChange={(e) => setM({ ...m, active: e.target.checked })} className="size-4 accent-[var(--color-navy)]" />
        Mandate active
      </label>
      <ErrorNote error={error} />
      <div className="flex flex-wrap gap-2">
        <Button onClick={save} loading={saving} disabled={!m.owner.trim()}>Save mandate</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function AgentCard({ row, reload }: { row: AgentRow; reload: () => void }) {
  const [editing, setEditing] = useState(false);
  const m = row.mandate;
  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold tracking-[0.18em] text-muted uppercase">MCP agent</div>
          <h2 className="hash mt-1 truncate text-xl font-semibold text-ink">{row.agent}</h2>
          <div className="mt-0.5 text-[13px] text-muted">{m ? <>Spends for <b className="font-medium text-ink-2">{m.owner}</b></> : 'No mandate: this agent is not limited'}</div>
        </div>
        <div className="flex items-center gap-2">
          {m && <Badge tone={m.active ? 'released' : 'void'} dot>{m.active ? 'Enforced' : 'Inactive'}</Badge>}
          {!editing && (
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              {m ? 'Edit' : 'Set a mandate'}
            </Button>
          )}
        </div>
      </div>

      {m && (
        <>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <Limit label="Per pact">{m.maxPactMinor === null ? 'No limit' : money(m.maxPactMinor, m.currency)}</Limit>
            <div className="min-w-0 rounded-xl border border-line-2 bg-paper px-4 py-3">
              <div className="text-[12px] text-muted">Open budget</div>
              <div className="mt-0.5 truncate text-lg font-semibold text-ink">
                {money(row.openMinor, m.currency)}
                <span className="text-[13px] font-normal text-muted"> / {m.maxOpenMinor === null ? 'no limit' : money(m.maxOpenMinor, m.currency)}</span>
              </div>
              {m.maxOpenMinor !== null && <Meter used={row.openMinor} limit={m.maxOpenMinor} />}
            </div>
            <Limit label="Owner approves above" hint={m.approvalAboveMinor === null ? undefined : 'and unrecognised categories'}>
              {m.approvalAboveMinor === null ? 'Never' : money(m.approvalAboveMinor, m.currency)}
            </Limit>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-[13px]">
            <span className="text-muted">Allowed:</span>
            {m.categories.length ? m.categories.map((c) => <Badge key={c}>{c}</Badge>) : <Badge>any category</Badge>}
            <span className="text-muted">· {m.currency} only</span>
          </div>
          {row.openPacts.length > 0 && (
            <div className="mt-3 text-[12px] text-muted">
              Open: {row.openPacts.map((p, i) => (
                <span key={p.id}>
                  {i > 0 && ', '}
                  <Link href={`/pacts/${p.id}`} className="underline decoration-line underline-offset-2 hover:text-ink">{p.title}</Link> ({money(p.totalMinor, m.currency)})
                </span>
              ))}
            </div>
          )}
        </>
      )}
      {editing && (
        <MandateForm
          initial={m ?? DEFAULT_MANDATE(row.agent)}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            reload();
          }}
        />
      )}
    </Card>
  );
}

function DryRun({ agents }: { agents: AgentRow[] }) {
  const withMandate = agents.filter((a) => a.mandate);
  const [agent, setAgent] = useState(withMandate[0]?.agent ?? agents[0]?.agent ?? '');
  const [form, setForm] = useState(PRESETS[0]);
  const [result, setResult] = useState<Check | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (f = form) => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api<Check>('POST', `/api/mandates/${encodeURIComponent(agent)}/check`, { ...f, currency: 'USD' }));
    } catch (e) {
      setError(e as ApiError);
      setResult(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-5 sm:p-6">
      <SectionTitle eyebrow="Dry run" title="Would the agent be allowed?" />
      <p className="-mt-2 mb-4 text-[13px] text-muted">The same rules the server applies to <span className="hash">create_pact</span> and <span className="hash">fund_pact</span>. Nothing is written.</p>
      <div className="mb-3 flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.title}
            type="button"
            onClick={() => {
              setForm(p);
              void run(p);
            }}
            className={cx('rounded-full border px-3 py-1 text-[13px] transition-colors', form.title === p.title ? 'border-ink/40 bg-paper-2 text-ink' : 'border-line text-ink-2 hover:border-ink/30')}
          >
            {p.title} · ${p.amount.toLocaleString('en-US')}
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_140px]">
        <label className="block text-[13px]">
          <span className="font-medium text-ink">What the agent wants to buy</span>
          <input className="mt-1 h-10 w-full rounded-xl border border-line bg-surface px-3 outline-none focus:border-ink/40" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value, description: '' })} />
        </label>
        <label className="block text-[13px]">
          <span className="font-medium text-ink">Total (USD)</span>
          <input type="number" min={1} className="mt-1 h-10 w-full rounded-xl border border-line bg-surface px-3 outline-none focus:border-ink/40" value={form.amount} onChange={(e) => setForm({ ...form, amount: Number(e.target.value) })} />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {agents.length > 1 && (
          <select aria-label="Agent" className="h-10 rounded-full border border-line bg-surface px-3 text-[13px]" value={agent} onChange={(e) => setAgent(e.target.value)}>
            {agents.map((a) => (
              <option key={a.agent} value={a.agent}>{a.agent}</option>
            ))}
          </select>
        )}
        <Button onClick={() => run()} loading={busy} disabled={!agent || !form.title.trim() || !(form.amount > 0)}>Check</Button>
      </div>
      <div className="mt-4" aria-live="polite">
        <ErrorNote error={error} />
        {result && (
          <div className={cx('rounded-xl border p-4', result.outcome === 'allowed' ? 'border-released/30 bg-released-soft' : result.outcome === 'denied' ? 'border-refund/30 bg-refund-soft' : 'border-held/30 bg-held-soft')}>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={OUTCOME[result.outcome].tone} dot>{OUTCOME[result.outcome].label}</Badge>
              <span className="text-[12px] text-ink-2">Category: {result.categories.length ? result.categories.join(', ') : 'not recognised'}</span>
            </div>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] text-ink">
              {result.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}

const DECISION_LABEL: Record<string, { tone: Tone; label: string }> = {
  'mandate.denied': { tone: 'refund', label: 'Denied' },
  'mandate.approval_requested': { tone: 'held', label: 'Approval requested' },
  'mandate.approval_approved': { tone: 'released', label: 'Owner approved' },
  'mandate.approval_denied': { tone: 'refund', label: 'Owner refused' },
  'mandate.updated': { tone: 'neutral', label: 'Mandate changed' },
};

export default function AgentsPage() {
  const { data, error, loading, reload } = useLive<Overview>('/api/mandates', (e) => e.type === 'audit.appended' || e.type === 'pact.updated');
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const decide = async (id: string, d: 'approve' | 'deny') => {
    setBusy(id + d);
    setActionError(null);
    try {
      await api('POST', `/api/mandates/approvals/${id}/${d}`);
      reload();
    } catch (e) {
      setActionError(e as ApiError);
    } finally {
      setBusy(null);
    }
  };
  const pending = data?.approvals.filter((a) => a.status === 'pending') ?? [];
  return (
    <div className="mx-auto w-full max-w-7xl space-y-8 px-4 py-10 sm:px-6">
      <div className="max-w-3xl">
        <div className="text-[11px] font-semibold tracking-[0.18em] text-muted uppercase">Agent commerce</div>
        <h1 className="font-display mt-1 text-4xl">Agent mandates</h1>
        <p className="mt-3 text-[15px] text-ink-2">
          Each agent spends inside limits its human owner sets: a per-pact ceiling, a budget across open pacts, allowed categories and an amount above which the owner decides. PACT enforces them on the server for every MCP call that commits money, whatever the agent’s prompt says. On top of that, PayPal still asks the human to approve every authorization.
        </p>
      </div>

      <ErrorNote error={error ?? actionError} />
      {loading && !data && <Skeleton className="h-64" />}

      {data && (
        <>
          {pending.length > 0 && (
            <Card className="border-held/40 p-5 sm:p-6">
              <SectionTitle eyebrow="Waiting for you" title={`${pending.length} pact${pending.length > 1 ? 's' : ''} to approve`} />
              <ul className="space-y-3">
                {pending.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line-2 bg-paper p-4">
                    <div className="min-w-0">
                      <div className="font-medium text-ink">
                        <span className="hash">{a.agent}</span> wants to fund{' '}
                        <Link href={`/pacts/${a.pactId}`} className="underline decoration-line underline-offset-2">{a.pactTitle ?? a.pactId}</Link> for <b>{money(a.totalMinor, a.currency)}</b>
                      </div>
                      <div className="mt-0.5 text-[13px] text-muted">{a.reasons.join(' ')}</div>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="success" loading={busy === a.id + 'approve'} onClick={() => decide(a.id, 'approve')}>Approve</Button>
                      <Button size="sm" variant="secondary" loading={busy === a.id + 'deny'} onClick={() => decide(a.id, 'deny')}>Refuse</Button>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
            <div className="space-y-6">
              {data.agents.map((row) => (
                <AgentCard key={row.agent} row={row} reload={reload} />
              ))}
              {data.agents.length === 0 && <Card className="p-6 text-[13px] text-muted">No MCP agent is configured (AGENT_API_KEYS).</Card>}
            </div>
            <div className="space-y-6">
              {data.agents.length > 0 && <DryRun agents={data.agents} />}
              <Card className="p-5 sm:p-6">
                <SectionTitle eyebrow="Audit log" title="Mandate decisions" />
                {data.decisions.length === 0 ? (
                  <p className="text-[13px] text-muted">Nothing yet. Every refusal, approval request, owner decision and mandate change is sealed in the audit hash chain.</p>
                ) : (
                  <ul className="divide-y divide-line-2 text-[13px]">
                    {data.decisions.map((d) => {
                      const l = DECISION_LABEL[d.type] ?? { tone: 'neutral' as Tone, label: d.type };
                      const what = typeof d.data.title === 'string' ? d.data.title : d.pactId ? (data.approvals.find((a) => a.pactId === d.pactId)?.pactTitle ?? '') : '';
                      return (
                        <li key={d.seq} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                          <Badge tone={l.tone}>{l.label}</Badge>
                          <span className="min-w-0 flex-1 truncate text-ink">
                            <span className="hash">{String(d.data.agent ?? '')}</span>
                            {what && <> · {what}</>}
                            {typeof d.data.totalMinor === 'number' && <> · {money(d.data.totalMinor)}</>}
                          </span>
                          <span className="text-[12px] text-muted">{new Date(d.ts).toLocaleString()}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
