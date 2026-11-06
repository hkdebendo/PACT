'use client';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { Contract, ParseResult } from '@pact/core/browser';
import { api, ApiError, setActor } from '@/lib/api';
import { Badge, Button, Card, ErrorNote, cx, money } from '@/components/ui';

const DEMO_DEAL =
  'I want 50 embroidered t-shirts (plain white, small blue embroidered star on the chest) delivered within 7 days. Total price 450 USD: 30% when production is done, 70% at delivery.';

const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

const template = (buyer: string, seller: string): Contract => ({
  title: 'New pact',
  description: 'Describe the deal in one sentence.',
  buyer: { name: buyer, email: null },
  seller: { name: seller, email: null },
  currency: 'USD',
  totalAmount: 100,
  deadline: plusDays(7),
  milestones: [
    { id: 'm1', title: 'Production', percent: 30, criteria: [{ id: 'c1', text: 'A photo shows the finished goods' }], evidenceTypes: ['photo'], deadline: null },
    { id: 'm2', title: 'Delivery', percent: 70, criteria: [{ id: 'c1', text: 'Tracking shows the parcel delivered' }], evidenceTypes: ['tracking'], deadline: null },
  ],
  subcontractors: [],
  disputePolicy: { windowHours: 72, resolution: 'ai_arbiter_with_human_appeal', notes: null },
});

interface ParseResponse {
  result: ParseResult;
  problems: string[];
  model: string;
  llmMode: 'live' | 'replay';
}

export function Composer() {
  const router = useRouter();
  const [text, setText] = useState(DEMO_DEAL);
  const [buyer, setBuyer] = useState('Ada (buyer)');
  const [seller, setSeller] = useState('Kofi Textiles');
  const [parsing, setParsing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [parsed, setParsed] = useState<ParseResponse | null>(null);
  const [contract, setContract] = useState<Contract | null>(null);

  const parse = async () => {
    setParsing(true);
    setError(null);
    try {
      const r = await api<ParseResponse>('POST', '/api/contracts/parse', { text, today: today(), buyerName: buyer, sellerName: seller });
      setParsed(r);
      setContract(r.result.contract);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setParsing(false);
    }
  };

  const sum = useMemo(() => contract?.milestones.reduce((a, m) => a + m.percent, 0) ?? 0, [contract]);

  const create = async () => {
    if (!contract) return;
    setCreating(true);
    setError(null);
    setActor(`buyer:${buyer}`);
    try {
      const key = crypto.randomUUID();
      const p = await api<{ id: string }>('POST', '/api/pacts', { contract, sourceText: parsed ? text : null, buyer: { name: buyer }, seller: { name: seller } }, { idempotencyKey: key });
      await api('POST', `/api/pacts/${p.id}/propose`, undefined, { idempotencyKey: `${key}-propose` });
      router.push(`/pacts/${p.id}`);
    } catch (e) {
      setError(e as ApiError);
      setCreating(false);
    }
  };

  const update = (fn: (c: Contract) => Contract) => setContract((c) => (c ? fn(structuredClone(c)) : c));

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1.1fr]">
      <Card className="p-5 sm:p-6">
        <label htmlFor="deal" className="text-[11px] font-semibold tracking-[0.18em] text-muted uppercase">
          The deal, in your words
        </label>
        <textarea
          id="deal"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={7}
          className="font-display mt-3 w-full resize-y rounded-xl border border-line bg-paper/60 p-4 text-[19px] leading-relaxed text-ink outline-none focus:border-navy"
        />
        <div className="mt-4 grid grid-cols-2 gap-3">
          {[
            ['Buyer', buyer, setBuyer],
            ['Seller', seller, setSeller],
          ].map(([l, v, set]) => (
            <label key={l as string} className="text-[13px] text-muted">
              {l as string}
              <input value={v as string} onChange={(e) => (set as (s: string) => void)(e.target.value)} className="mt-1 h-10 w-full rounded-lg border border-line bg-surface px-3 text-[14px] text-ink outline-none focus:border-navy" />
            </label>
          ))}
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button onClick={parse} loading={parsing} size="lg">
            Read it with Muse
          </Button>
          <Button variant="ghost" onClick={() => setContract(template(buyer, seller))}>
            Fill in by hand
          </Button>
        </div>
        <div className="mt-4">
          <ErrorNote error={error} />
          {error?.code === 'AI_UNAVAILABLE' && (
            <p className="mt-2 text-[13px] text-muted">
              Replay mode only knows recorded inputs. Use the demo deal (<button className="underline" onClick={() => setText(DEMO_DEAL)}>restore it</button>), fill the contract in by hand, or set <span className="hash">META_API_KEY</span> to parse anything.
            </p>
          )}
        </div>
        {parsed && (
          <div className="mt-5 space-y-2 text-[13px] text-ink-2">
            <div className="flex items-center gap-2">
              <Badge tone={parsed.result.status === 'ok' ? 'released' : 'held'} dot>
                {parsed.result.status === 'ok' ? 'Parsed' : 'Needs clarification'}
              </Badge>
              <span className="text-muted">
                {parsed.model} · {parsed.llmMode === 'replay' ? 'recorded response' : 'live'}
              </span>
            </div>
            {parsed.result.questions.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-ink">
                {parsed.result.questions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            )}
            {parsed.result.assumptions.length > 0 && (
              <div>
                <span className="font-semibold">Assumptions:</span> {parsed.result.assumptions.join(' · ')}
              </div>
            )}
          </div>
        )}
      </Card>

      <Card className={cx('p-5 sm:p-6', !contract && 'grid place-items-center border-dashed bg-transparent shadow-none')}>
        {!contract ? (
          <div className="max-w-xs py-16 text-center text-[14px] text-muted">The structured contract appears here: parties, total, milestones and the criteria the Verifier will check.</div>
        ) : (
          <div>
            <input value={contract.title} onChange={(e) => update((c) => ({ ...c, title: e.target.value }))} className="font-display w-full bg-transparent text-[28px] leading-tight text-ink outline-none" aria-label="Title" />
            <textarea value={contract.description} onChange={(e) => update((c) => ({ ...c, description: e.target.value }))} rows={2} className="mt-1 w-full resize-none bg-transparent text-[14px] text-ink-2 outline-none" aria-label="Description" />
            <div className="mt-3 flex flex-wrap gap-3 text-[13px]">
              <label className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5">
                Total
                <input type="number" min={1} step="0.01" value={contract.totalAmount} onChange={(e) => update((c) => ({ ...c, totalAmount: Number(e.target.value) }))} className="hash w-24 bg-transparent text-ink outline-none" />
                <span className="text-muted">{contract.currency}</span>
              </label>
              <label className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5">
                Deadline
                <input type="date" value={contract.deadline} onChange={(e) => update((c) => ({ ...c, deadline: e.target.value }))} className="bg-transparent text-ink outline-none" />
              </label>
              <span className="flex items-center rounded-lg bg-paper-2 px-3 py-1.5 text-ink-2">Disputes: AI Arbiter + human appeal · {contract.disputePolicy.windowHours}h</span>
            </div>
            <div className="ledger-rule my-5" />
            <ol className="space-y-4">
              {contract.milestones.map((m, i) => (
                <li key={m.id} className="rounded-xl border border-line-2 bg-paper/50 p-4">
                  <div className="flex items-center gap-3">
                    <span className="font-display text-xl text-held">{i + 1}</span>
                    <input value={m.title} onChange={(e) => update((c) => ((c.milestones[i].title = e.target.value), c))} className="flex-1 bg-transparent font-semibold text-ink outline-none" aria-label={`Milestone ${i + 1} title`} />
                    <label className="flex items-center gap-1 text-[13px] text-muted">
                      <input type="number" min={1} max={100} value={m.percent} onChange={(e) => update((c) => ((c.milestones[i].percent = Number(e.target.value)), c))} className="hash w-12 rounded border border-line bg-surface px-1 text-right text-ink" aria-label={`Milestone ${i + 1} percent`} />%
                    </label>
                    <span className="hash w-20 text-right text-ink-2">{money(Math.round((contract.totalAmount * 100 * m.percent) / 100), contract.currency)}</span>
                  </div>
                  <ul className="mt-3 space-y-1.5 pl-8">
                    {m.criteria.map((cr, j) => (
                      <li key={cr.id} className="flex items-start gap-2 text-[13px] text-ink-2">
                        <span className="hash mt-0.5 text-muted">{cr.id}</span>
                        <input value={cr.text} onChange={(e) => update((c) => ((c.milestones[i].criteria[j].text = e.target.value), c))} className="flex-1 bg-transparent outline-none" aria-label={`Criterion ${cr.id}`} />
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2 flex gap-1.5 pl-8">
                    {m.evidenceTypes.map((t) => (
                      <Badge key={t}>{t}</Badge>
                    ))}
                  </div>
                </li>
              ))}
            </ol>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
              <span className={cx('text-[13px]', sum === 100 ? 'text-released' : 'text-refund')}>Milestones sum to {sum}%{sum !== 100 && ' — must be 100%'}</span>
              <Button size="lg" onClick={create} loading={creating} disabled={sum !== 100}>
                Create &amp; propose to {seller}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
