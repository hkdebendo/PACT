import Link from 'next/link';
import { Seal } from '@/components/shell';

const STEPS = [
  { n: 'I', title: 'Say the deal', body: 'A buyer, or the buyer’s agent, writes the deal in plain words. Muse turns it into a contract with milestones and checkable criteria — or asks what is unclear.' },
  { n: 'II', title: 'PayPal holds the money', body: 'The buyer approves once in PayPal. PACT authorizes the order: funds are held, not charged. That approval is the spending cap the human sets for every agent.' },
  { n: 'III', title: 'Evidence, verified', body: 'The seller submits photos, tracking, code or documents. Deterministic checks first, then Muse describes the evidence blind and judges it against each criterion.' },
  { n: 'IV', title: 'Release, or return', body: 'Approved milestones are captured from the authorization, one share at a time. Disputes go to an AI Arbiter with reasons — and a human appeal.' },
];

function Receipt() {
  const rows = [
    { t: 'Production — 50 shirts photographed', p: '30%', s: 'Released', c: 'text-released', b: 'bg-released' },
    { t: 'Delivery — tracking shows delivered', p: '70%', s: 'Held', c: 'text-held', b: 'bg-held' },
  ];
  return (
    <div className="relative mx-auto w-full max-w-md rotate-[1.2deg] rounded-[22px] border border-line bg-surface p-6 shadow-card sm:p-7">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[11px] font-semibold tracking-[0.2em] text-muted uppercase">Pact</div>
          <div className="font-display mt-1 text-[22px] leading-tight text-ink">50 embroidered t-shirts</div>
          <div className="mt-1 text-sm text-muted">Ada’s agent ⇄ Kofi Textiles · USD 450</div>
        </div>
        <Seal size={46} />
      </div>
      <div className="ledger-rule my-5" />
      <ul className="space-y-4">
        {rows.map((r) => (
          <li key={r.t} className="flex items-center gap-3">
            <span className={`size-2.5 shrink-0 rounded-full ${r.b}`} />
            <span className="flex-1 text-[14px] text-ink-2">{r.t}</span>
            <span className="hash text-muted">{r.p}</span>
            <span className={`text-[13px] font-semibold ${r.c}`}>{r.s}</span>
          </li>
        ))}
      </ul>
      <div className="mt-6 rounded-xl bg-paper-2 p-3 text-[13px] leading-relaxed text-ink-2">
        <span className="font-semibold text-refund">Rejected earlier:</span> “The photo shows 24 grey mugs, not white t-shirts. Criterion c1 failed (confidence 0.95).”
      </div>
      <div className="mt-4 flex items-center justify-between text-[12px] text-muted">
        <span className="hash">chain 9f3a…c41e ✓ verified</span>
        <span>appeal to a human →</span>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 sm:px-6">
      <section className="grid items-center gap-12 py-14 md:grid-cols-[1.15fr_1fr] md:py-24">
        <div>
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-[12px] text-ink-2">
            <span className="size-1.5 rounded-full bg-held" /> Programmable trust for the agent economy
          </div>
          <h1 className="font-display text-[44px] leading-[1.02] text-ink sm:text-[64px]">
            Where AI agents sign deals and <em className="text-navy-2 not-italic">PayPal</em> enforces them.
          </h1>
          <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-ink-2">
            An agent that pays another agent, a freelancer or a seller on a chat app pays blind. PACT puts a programmable third party in the
            middle: PayPal holds the money, an AI verifier checks real evidence, and funds move milestone by milestone — with every decision
            explained and recorded in a tamper-evident log.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/pacts/new" className="inline-flex h-12 items-center rounded-full bg-navy px-6 text-[15px] font-medium text-paper shadow-card hover:bg-navy-2">
              Write a pact
            </Link>
            <Link href="/control-tower" className="inline-flex h-12 items-center rounded-full border border-line bg-surface px-6 text-[15px] font-medium text-ink hover:border-ink/30">
              Open the Control Tower
            </Link>
          </div>
          <p className="mt-6 text-[13px] text-muted">Agents connect over MCP: <span className="hash">create_pact · fund_pact · submit_evidence · verify_milestone · release_funds · open_dispute · get_reputation</span></p>
        </div>
        <Receipt />
      </section>

      <div className="ledger-rule" />

      <section className="grid gap-px overflow-hidden py-14 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s) => (
          <div key={s.n} className="p-5">
            <div className="font-display text-3xl text-held">{s.n}</div>
            <h3 className="mt-3 text-lg font-semibold text-ink">{s.title}</h3>
            <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{s.body}</p>
          </div>
        ))}
      </section>

      <section className="mb-20 grid gap-6 md:grid-cols-3">
        {[
          { h: 'For small sellers in emerging markets', p: '“I paid and received nothing” keeps buyers away from sellers they cannot meet. With funds held by PayPal and released on evidence, a workshop can sell to a stranger.' },
          { h: 'For agent builders', p: 'Your agent operates inside a human-approved authorization. It can negotiate, fund and release — but never spend beyond what the human approved once.' },
          { h: 'For auditors', p: 'Every state change and AI decision is appended to a SHA-256 hash chain. One click recomputes it; any edit to history breaks the seal.' },
        ].map((c) => (
          <div key={c.h} className="rounded-2xl border border-line bg-surface p-6 shadow-card">
            <h3 className="font-display text-xl text-ink">{c.h}</h3>
            <p className="mt-3 text-[14px] leading-relaxed text-ink-2">{c.p}</p>
          </div>
        ))}
      </section>

      <footer className="mb-10 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6 text-[12px] text-muted">
        <span>PACT · MIT licence · PayPal sandbox only — never real money</span>
        <span>AI: Meta Muse via the Meta Model API · Dashboard: AG Studio</span>
      </footer>
    </div>
  );
}
