'use client';
import { AnimatePresence, motion } from 'motion/react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { AuditEntry } from '@pact/core/browser';
import type { EvidenceType, MilestoneView, PactView, ReputationView } from '@pact/core/browser';
import { api, API_URL, ApiError, fileToBase64, setActor, useLive } from '@/lib/api';
import { ChainBadge, EscrowBar, VerdictCard } from '@/components/pact-parts';
import { Badge, Button, Card, ErrorNote, MILESTONE_TONE, PACT_TONE, Skeleton, cx, label, money } from '@/components/ui';
import { Funding } from './funding';

type Role = 'buyer' | 'seller' | 'reviewer';

function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, run };
}

function RoleSwitch({ role, setRole, pact }: { role: Role; setRole: (r: Role) => void; pact: PactView }) {
  const opts: { r: Role; l: string }[] = [
    { r: 'buyer', l: pact.buyer.name },
    { r: 'seller', l: pact.seller.name },
    { r: 'reviewer', l: 'Human reviewer' },
  ];
  return (
    <div className="inline-flex max-w-full overflow-x-auto rounded-full border border-line bg-surface p-1 text-[13px]" role="radiogroup" aria-label="Act as">
      {opts.map((o) => (
        <button key={o.r} role="radio" aria-checked={role === o.r} onClick={() => setRole(o.r)} className={cx('rounded-full px-3 py-1 whitespace-nowrap transition-colors', role === o.r ? 'bg-ink text-paper' : 'text-ink-2 hover:bg-paper-2')}>
          <span className="hidden text-[11px] tracking-wider uppercase opacity-70 sm:inline">{o.r === 'reviewer' ? '' : `${o.r} · `}</span>
          {o.l}
        </button>
      ))}
    </div>
  );
}

function PartyChip({ party, roleLabel }: { party: PactView['buyer']; roleLabel: string }) {
  const { data } = useLive<ReputationView>(`/api/reputation/${party.id}`, (e) => e.type === 'pact.updated');
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line-2 bg-paper/60 px-3 py-2">
      <div className="grid size-9 place-items-center rounded-full bg-navy font-display text-paper">{party.name.slice(0, 1)}</div>
      <div className="min-w-0">
        <div className="text-[11px] tracking-wider text-muted uppercase">
          {roleLabel} · {party.kind}
        </div>
        <div className="truncate text-[14px] font-semibold text-ink">{party.name}</div>
      </div>
      {data && (
        <div className="ml-2 text-right" title={`Bayesian-smoothed reputation, confidence ${Math.round(data.confidence * 100)}%`}>
          <div className="hash text-[15px] font-semibold text-ink">{data.score.toFixed(0)}</div>
          <div className="text-[11px] text-muted">{data.tier}</div>
        </div>
      )}
    </div>
  );
}

const STEP_ICON: Record<string, string> = { released: '✓', partially_released: '½', refunded: '↺', voided: '∅', rejected: '✗', disputed: '!', approved: '✓', evidence_submitted: '…', needs_more: '?', pending: '' };

function EvidenceUpload({ pact, m, onDone }: { pact: PactView; m: MilestoneView; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [type, setType] = useState<EvidenceType>(m.evidenceTypes[0]);
  const [note, setNote] = useState('');
  const { busy, error, run } = useAction();
  const input = useRef<HTMLInputElement>(null);
  const submit = () =>
    run('upload', async () => {
      if (!file) return;
      await api('POST', `/api/pacts/${pact.id}/milestones/${m.id}/evidence`, { filename: file.name, contentBase64: await fileToBase64(file), type, note: note || null });
      setFile(null);
      setNote('');
      if (input.current) input.current.value = '';
      onDone();
    });
  return (
    <div className="rounded-xl border border-dashed border-line bg-paper/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif,.txt,.md,.json,.csv,.ts,.tsx,.js,.py,.html" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="max-w-[230px] text-[13px] file:mr-2 file:rounded-full file:border-0 file:bg-paper-2 file:px-3 file:py-1.5 file:text-[13px]" aria-label="Evidence file" />
        <select value={type} onChange={(e) => setType(e.target.value as EvidenceType)} className="h-8 rounded-lg border border-line bg-surface px-2 text-[13px]" aria-label="Evidence type">
          {m.evidenceTypes.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 text-[13px]" />
        <Button size="sm" onClick={submit} disabled={!file} loading={busy === 'upload'}>
          Submit evidence
        </Button>
      </div>
      <ErrorNote error={error} />
    </div>
  );
}

function Milestone({ pact, m, index, role, focused }: { pact: PactView; m: MilestoneView; index: number; role: Role; focused: boolean }) {
  const { busy, error, run } = useAction();
  const [statement, setStatement] = useState('');
  const dispute = pact.disputes.find((d) => d.milestoneId === m.id && d.status === 'open');
  const live = ['funded', 'in_progress', 'disputed', 'completed'].includes(pact.status);
  const tone = MILESTONE_TONE[m.status];
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focused]);
  const ring = tone === 'released' ? 'border-released bg-released text-white' : tone === 'refund' ? 'border-refund bg-refund text-white' : tone === 'held' ? 'border-held bg-held-soft text-held' : tone === 'navy' ? 'border-navy bg-navy text-paper' : 'border-line bg-surface text-muted';
  return (
    <motion.li ref={ref} layout id={`milestone-${m.id}`} className={cx('relative grid grid-cols-[44px_1fr] gap-4', focused && 'rounded-2xl ring-2 ring-focus/50')}>
      <div className="flex flex-col items-center">
        <motion.div key={m.status} initial={{ scale: 0.6 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 18 }} className={cx('z-10 grid size-11 place-items-center rounded-full border-2 font-display text-lg', ring)}>
          {STEP_ICON[m.status] || index + 1}
        </motion.div>
        {index < pact.milestones.length - 1 && <div className="w-px flex-1 bg-line" />}
      </div>
      <div className="pb-8">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-display text-xl text-ink">{m.title}</h3>
          <Badge tone={tone}>{label(m.status)}</Badge>
          <span className="hash ml-auto text-ink-2">
            {m.percent}% · {money(m.amountMinor, pact.currency)}
          </span>
        </div>
        <ul className="mt-2 space-y-1 text-[13px] text-ink-2">
          {m.criteria.map((c) => (
            <li key={c.id}>
              <span className="hash mr-1 text-muted">{c.id}</span>
              {c.text}
            </li>
          ))}
        </ul>
        <div className="mt-1 text-[12px] text-muted">
          Accepts {m.evidenceTypes.join(', ')} · due {m.deadline}
          {m.capturedMinor > 0 && <> · captured {money(m.capturedMinor, pact.currency)}</>}
          {m.refundedMinor > 0 && <> · refunded {money(m.refundedMinor, pact.currency)}</>}
        </div>

        {m.evidence.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {m.evidence.map((e) => (
              <a key={e.id} href={`${API_URL}${e.url}`} target="_blank" rel="noreferrer" className="group relative block overflow-hidden rounded-lg border border-line bg-paper-2" title={`${e.filename} · sha256 ${e.sha256.slice(0, 12)}…${e.description ? `\n${e.description.summary}` : ''}`}>
                {e.mime.startsWith('image/') ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`${API_URL}${e.url}`} alt={e.description?.summary ?? e.filename} className="h-20 w-28 object-cover transition-transform group-hover:scale-105" />
                ) : (
                  <div className="grid h-20 w-28 place-items-center p-2 text-center text-[11px] text-ink-2">
                    <span className="hash">{e.filename}</span>
                  </div>
                )}
                <span className="absolute bottom-0 left-0 bg-ink/70 px-1.5 text-[10px] text-paper">{e.type}</span>
              </a>
            ))}
          </div>
        )}

        <AnimatePresence initial={false}>
          <div className="mt-3 space-y-3">
            {m.verdicts
              .slice()
              .reverse()
              .map((v, i) => (
                <div key={v.id} className={cx(i > 0 && 'opacity-70')}>
                  <VerdictCard verdict={v} criteria={m.criteria} canAppeal={i === 0 && role !== 'reviewer' && v.kind !== 'human'} party={role === 'buyer' ? 'buyer' : 'seller'} compact={i > 0} />
                  {role === 'reviewer' && v.appealStatus === 'requested' && <ReviewBox verdictId={v.id} kind={v.kind} />}
                </div>
              ))}
          </div>
        </AnimatePresence>

        {live && (
          <div className="mt-3 space-y-3">
            {role === 'seller' && ['pending', 'rejected', 'needs_more', 'evidence_submitted'].includes(m.status) && pact.status !== 'completed' && (
              <EvidenceUpload pact={pact} m={m} onDone={() => undefined} />
            )}
            <div className="flex flex-wrap gap-2">
              {m.status === 'evidence_submitted' && (
                <Button onClick={() => run('verify', () => api('POST', `/api/pacts/${pact.id}/milestones/${m.id}/verify`, {}))} loading={busy === 'verify'}>
                  Verify with Muse
                </Button>
              )}
              {m.status === 'approved' && role === 'buyer' && (
                <Button variant="success" onClick={() => run('release', () => api('POST', `/api/pacts/${pact.id}/milestones/${m.id}/release`, undefined, { idempotencyKey: `release-${pact.id}-${m.id}` }))} loading={busy === 'release'}>
                  Release {money(m.amountMinor, pact.currency)}
                </Button>
              )}
              {role !== 'reviewer' && ['evidence_submitted', 'approved', 'rejected', 'needs_more', 'released'].includes(m.status) && !dispute && (
                <div className="flex min-w-0 flex-1 gap-2">
                  <input value={statement} onChange={(e) => setStatement(e.target.value)} placeholder={role === 'seller' ? 'Why the verdict is wrong…' : 'What is wrong with this milestone…'} className="h-10 min-w-0 flex-1 rounded-full border border-line bg-surface px-4 text-[13px] outline-none focus:border-navy" />
                  <Button variant="secondary" disabled={statement.length < 5} onClick={() => run('dispute', () => api('POST', `/api/pacts/${pact.id}/milestones/${m.id}/dispute`, { party: role, statement }))} loading={busy === 'dispute'}>
                    Open dispute
                  </Button>
                </div>
              )}
            </div>
            {dispute && (
              <div className="rounded-xl border border-refund/30 bg-refund-soft/50 p-4">
                <div className="text-[11px] font-semibold tracking-widest text-refund uppercase">Dispute open · opened by {dispute.openedBy}</div>
                <dl className="mt-2 grid gap-2 text-[13px] sm:grid-cols-2">
                  <div>
                    <dt className="text-muted">Buyer says</dt>
                    <dd className="text-ink">{dispute.buyerStatement ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">Seller says</dt>
                    <dd className="text-ink">{dispute.sellerStatement ?? '—'}</dd>
                  </div>
                </dl>
                <div className="mt-3 flex flex-wrap gap-2">
                  {role !== 'reviewer' && !(role === 'buyer' ? dispute.buyerStatement : dispute.sellerStatement) && (
                    <>
                      <input value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="Your statement" className="h-9 min-w-0 flex-1 rounded-full border border-line bg-surface px-4 text-[13px]" />
                      <Button size="sm" variant="secondary" disabled={statement.length < 5} onClick={() => run('stmt', () => api('POST', `/api/pacts/${pact.id}/milestones/${m.id}/statement`, { party: role, statement }))} loading={busy === 'stmt'}>
                        Add statement
                      </Button>
                    </>
                  )}
                  <Button size="sm" variant="danger" onClick={() => run('arb', () => api('POST', `/api/pacts/${pact.id}/milestones/${m.id}/arbitrate`, undefined, { idempotencyKey: `arb-${dispute.id}` }))} loading={busy === 'arb'}>
                    Ask the AI Arbiter
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
        <div className="mt-2">
          <ErrorNote error={error} />
        </div>
      </div>
    </motion.li>
  );
}

function ReviewBox({ verdictId, kind }: { verdictId: string; kind: string }) {
  const [note, setNote] = useState('');
  const { busy, error, run } = useAction();
  const review = (outcome: 'upheld' | 'overturned', decision?: { outcome: 'release' | 'refund' }) =>
    run(outcome, () => api('POST', `/api/verdicts/${verdictId}/review`, { reviewer: 'demo-reviewer', outcome, note: note || 'Reviewed.', decision }));
  return (
    <div className="mt-2 rounded-xl border border-navy/30 bg-surface p-3">
      <div className="text-[12px] font-semibold text-navy">Human review</div>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reviewer note" className="mt-2 h-9 w-full rounded-lg border border-line bg-paper px-3 text-[13px]" />
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => review('upheld')} loading={busy === 'upheld'}>
          Uphold
        </Button>
        <Button size="sm" onClick={() => review('overturned', kind === 'verifier' ? { outcome: 'release' } : undefined)} loading={busy === 'overturned'}>
          Overturn{kind === 'verifier' ? ' & release' : ''}
        </Button>
      </div>
      <ErrorNote error={error} />
    </div>
  );
}

function AuditTrail({ pactId }: { pactId: string }) {
  const { data } = useLive<AuditEntry[]>(`/api/audit?pactId=${pactId}`, (e) => e.type === 'audit.appended' && e.pactId === pactId);
  const [open, setOpen] = useState(false);
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="font-display text-xl whitespace-nowrap">Audit trail</h2>
        <ChainBadge />
        <button className="ml-auto text-[13px] text-ink-2 underline" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Hide' : `Show ${data?.length ?? ''} entries`}
        </button>
      </div>
      <p className="mt-1 text-[13px] text-muted">Append-only. Each entry’s hash = sha256(previous hash + canonical JSON of the entry).</p>
      {open && (
        <ol className="mt-4 max-h-[420px] space-y-1 overflow-auto pr-2">
          {data
            ?.slice()
            .reverse()
            .map((e) => (
              <li key={e.seq} className="grid grid-cols-[48px_150px_1fr_auto] items-baseline gap-3 border-b border-line-2 py-1.5 text-[12px]">
                <span className="hash text-muted">#{e.seq}</span>
                <span className="font-medium text-ink">{e.type}</span>
                <span className="truncate text-ink-2">{e.actor}</span>
                <span className="hash text-muted" title={e.hash}>
                  {e.hash.slice(0, 10)}
                </span>
              </li>
            ))}
        </ol>
      )}
    </Card>
  );
}

export function PactRoom({ id, paypalClientId }: { id: string; paypalClientId: string | null }) {
  const { data: pact, error } = useLive<PactView>(`/api/pacts/${id}`, (e) => ('pactId' in e ? e.pactId === id : true));
  const [role, setRoleState] = useState<Role>('buyer');
  const { busy, error: actionError, run } = useAction();
  const params = useSearchParams();
  const focus = params.get('milestone');
  const setRole = (r: Role) => {
    setRoleState(r);
    if (pact) setActor(r === 'reviewer' ? 'human:reviewer' : `${r}:${r === 'buyer' ? pact.buyer.name : pact.seller.name}`);
  };
  useEffect(() => {
    if (pact) setActor(`buyer:${pact.buyer.name}`);
    // Returning from the PayPal redirect flow: confirm the authorization once.
    if (pact && params.get('paypal') === 'approved' && pact.status === 'proposed') void api('POST', `/api/pacts/${id}/fund/confirm`).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pact?.id]);

  if (error) return <div className="mx-auto max-w-3xl p-10"><ErrorNote error={error} /></div>;
  if (!pact)
    return (
      <div className="mx-auto w-full max-w-6xl space-y-4 px-4 py-10 sm:px-6">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
      </div>
    );

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[13px] text-muted">
        <Link href="/pacts" className="hover:underline">
          Pacts
        </Link>
        <span>/</span>
        <span className="hash">{pact.id}</span>
        <Badge tone={pact.paymentMode === 'sandbox' ? 'released' : 'held'} className="ml-2">
          {pact.paymentMode === 'sandbox' ? 'PayPal sandbox' : 'SIMULATED PayPal'}
        </Badge>
      </div>
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-4xl leading-tight text-ink">{pact.title}</h1>
          <p className="mt-2 max-w-2xl text-[15px] text-ink-2">{pact.description}</p>
        </div>
        <div className="text-right">
          <Badge tone={PACT_TONE[pact.status]} dot className="text-[13px]">
            {label(pact.status)}
          </Badge>
          <div className="font-display mt-2 text-3xl text-ink">{money(pact.totalMinor, pact.currency)}</div>
          <div className="text-[12px] text-muted">due {pact.deadline}</div>
        </div>
      </div>
      {pact.sourceText && <blockquote className="mt-4 border-l-2 border-held pl-4 font-display text-[16px] text-ink-2 italic">“{pact.sourceText}”</blockquote>}

      <div className="mt-6 grid gap-3 md:grid-cols-2">
        <PartyChip party={pact.buyer} roleLabel="Buyer" />
        <PartyChip party={pact.seller} roleLabel="Seller" />
      </div>

      <Card className="mt-6 p-5">
        <EscrowBar pact={pact} />
        {pact.authorizationId && (
          <div className="mt-3 text-[12px] text-muted">
            Authorization <span className="hash">{pact.authorizationId}</span>
            {pact.authorizationExpiresAt && <> · valid until {new Date(pact.authorizationExpiresAt).toLocaleDateString()} (re-authorized automatically after the 3-day honor period if work is still open)</>}
          </div>
        )}
      </Card>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <span className="text-[13px] text-muted">Act as</span>
        <RoleSwitch role={role} setRole={setRole} pact={pact} />
        <span className="text-[12px] text-muted">Demo identities — no login. Agents use the MCP server with API keys.</span>
      </div>

      <div className="mt-6 space-y-4">
        {pact.status === 'draft' && role === 'buyer' && <Button onClick={() => run('propose', () => api('POST', `/api/pacts/${id}/propose`))} loading={busy === 'propose'}>Propose to {pact.seller.name}</Button>}
        {pact.status === 'proposed' && !pact.sellerAccepted && (
          <div className="rounded-2xl border border-line bg-surface p-5">
            <h3 className="font-display text-xl">Waiting for {pact.seller.name} to accept</h3>
            {role === 'seller' ? (
              <Button className="mt-3" onClick={() => run('accept', () => api('POST', `/api/pacts/${id}/accept`))} loading={busy === 'accept'}>
                Accept this pact
              </Button>
            ) : (
              <p className="mt-1 text-[14px] text-ink-2">Switch to the seller to accept, or let the seller agent accept over MCP.</p>
            )}
          </div>
        )}
        {pact.status === 'proposed' && pact.sellerAccepted && (role === 'buyer' ? <Funding pact={pact} paypalClientId={paypalClientId} /> : <p className="text-[14px] text-ink-2">Accepted. Waiting for the buyer to secure the funds with PayPal.</p>)}
        <ErrorNote error={actionError} />
      </div>

      <section className="mt-8">
        <h2 className="font-display mb-5 text-2xl">Milestones</h2>
        <ol>
          {pact.milestones.map((m, i) => (
            <Milestone key={m.id} pact={pact} m={m} index={i} role={role} focused={focus === m.id} />
          ))}
        </ol>
      </section>

      <div className="mt-2 flex flex-wrap gap-2">
        {['proposed', 'funded', 'in_progress'].includes(pact.status) && role === 'buyer' && (
          <Button variant="ghost" onClick={() => run('cancel', () => api('POST', `/api/pacts/${id}/cancel`, { reason: 'Cancelled by buyer' }))} loading={busy === 'cancel'}>
            Cancel pact &amp; void the authorization
          </Button>
        )}
        {pact.status === 'completed' && (
          <Button variant="secondary" onClick={() => run('close', () => api('POST', `/api/pacts/${id}/close`))} loading={busy === 'close'}>
            Close pact (end dispute window)
          </Button>
        )}
      </div>

      <div className="mt-10">
        <AuditTrail pactId={id} />
      </div>
    </div>
  );
}
