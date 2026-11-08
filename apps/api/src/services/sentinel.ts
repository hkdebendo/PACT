// PACT Sentinel: deterministic anomaly detection over the escrow ledger.
//
// Rules decide; the model only explains. Every check below is a plain function of the ledger
// (pacts, milestones, verdicts, PayPal operations), so the same data always raises the same
// alerts, the thresholds are visible in code and docs/SENTINEL.md, and the scan works with no
// model at all. Muse is used afterwards (sentinelBrief) to write the plain-English briefing, with a
// deterministic fallback when no recorded answer exists.
import { z } from 'zod';
import { tables } from '@pact/db';
import { LlmReplayMissError } from '@pact/llm';
import type { PactView } from '@pact/core';
import type { AppContext } from '../context';
import { buildPactView } from './views';

export type Severity = 'critical' | 'warning' | 'info';

export interface Anomaly {
  id: string; // stable: rule + subject
  rule: RuleId;
  severity: Severity;
  title: string;
  detail: string;
  metric: { label: string; value: number; baseline: number | null; unit: 'usd' | 'pct' | 'count' | 'hours' };
  pactIds: string[];
  amount: number | null; // USD at stake, major units
  /** A chart that would show the anomaly: a Studio widget type plus a plain-language spec for Studio's built-in Widget agent. */
  chart: { title: string; widgetType: string; instructions: string } | null;
}

export const RULES = {
  refund_velocity: 'Refund & void spike (24 h vs 7-day average)',
  seller_refund_concentration: 'Seller refund concentration vs platform',
  repeat_rejections: 'Repeated or unresolved evidence rejections',
  low_confidence_release: 'Money released on a low-confidence AI decision',
  authorization_expiring: 'Held funds with an expiring PayPal authorization',
  payment_failures: 'Failed PayPal operations',
  open_disputes: 'Open disputes',
  pending_appeals: 'Appeals waiting for a human',
  stalled_funding: 'Pacts stuck waiting for buyer approval',
} as const;
export type RuleId = keyof typeof RULES;

// Thresholds (documented in docs/SENTINEL.md).
export const THRESHOLDS = {
  refundVelocityMinUsd: 50, // ignore spikes smaller than this
  refundVelocityFactor: 2, // 24 h total must be ≥ this × the 7-day daily average
  sellerMinSettled: 2, // milestones before a seller's rate means anything
  sellerFactor: 2, // seller refund rate ≥ this × platform rate…
  sellerMinRate: 0.34, // …and at least this
  lowConfidence: 0.75,
  authExpiringHours: 72,
  authCriticalHours: 24,
  appealWaitHours: 24,
  stalledFundingHours: 24,
};

export interface SentinelInput {
  now: Date;
  pacts: PactView[];
}

const H = 36e5;
const major = (minor: number) => Math.round(minor) / 100;
const FAILED = /FAILED|DENIED|DECLINED|ERROR|REVERSED/i;
const SETTLED = ['released', 'partially_released', 'refunded'];

export interface SentinelScan {
  asOf: string;
  status: 'clear' | 'warning' | 'critical';
  scanned: { pacts: number; milestones: number; verdicts: number; payments: number };
  rules: { id: RuleId; label: string; triggered: number }[];
  anomalies: Anomaly[];
}

export function scanLedger({ now, pacts }: SentinelInput): SentinelScan {
  const t = now.getTime();
  const out: Anomaly[] = [];
  const milestones = pacts.flatMap((p) => p.milestones.map((m) => ({ p, m })));
  const verdicts = milestones.flatMap(({ p, m }) => m.verdicts.map((v) => ({ p, m, v })));
  const payments = pacts.flatMap((p) => p.payments.map((x) => ({ p, x })));

  // 1. Refund & void spike: explicit refunds and buyer-side voids in the last 24 h against the
  //    7-day daily average (automatic voids of an unused remainder after a final capture are routine).
  const outflow = payments.filter(({ x }) => x.kind === 'refund' || (x.kind === 'void' && x.status === 'VOIDED'));
  const inWindow = (hours: number) => outflow.filter(({ x }) => t - Date.parse(x.createdAt) <= hours * H && Date.parse(x.createdAt) <= t);
  const day = inWindow(24).reduce((a, { x }) => a + x.amountMinor, 0);
  const week = inWindow(24 * 7).reduce((a, { x }) => a + x.amountMinor, 0);
  const avg = week / 7;
  if (major(day) >= THRESHOLDS.refundVelocityMinUsd && day >= THRESHOLDS.refundVelocityFactor * avg - 1) {
    const ids = [...new Set(inWindow(24).map(({ p }) => p.id))];
    out.push({
      id: 'refund_velocity',
      rule: 'refund_velocity',
      severity: major(day) >= 4 * Math.max(THRESHOLDS.refundVelocityMinUsd, major(avg)) ? 'critical' : 'warning',
      title: `Refunds and voids spiked to $${major(day).toFixed(0)} in 24 h`,
      detail: `${inWindow(24).length} refund/void operation(s) across ${ids.length} pact(s) in the last 24 hours, against a 7-day daily average of $${major(avg).toFixed(0)}.`,
      metric: { label: 'Refunded or voided, last 24 h', value: major(day), baseline: major(avg), unit: 'usd' },
      pactIds: ids,
      amount: major(day),
      chart: {
        title: 'Refunds & voids over time (Sentinel)',
        widgetType: 'column-chart-stacked',
        instructions:
          'Configure this chart: x axis = Operation Time (payments.createdAt) by day, value = sum of Operation Amount (payments.amount), legend split by Operation (payments.kind). Keep the title "Refunds & voids over time (Sentinel)".',
      },
    });
  }

  // 2. Seller refund concentration: a seller whose settled milestones end in (partial) refunds far
  //    more often than the platform's.
  const settled = milestones.filter(({ m }) => SETTLED.includes(m.status));
  const refundedShare = (list: typeof settled) => (list.length ? list.filter(({ m }) => m.status !== 'released').length / list.length : 0);
  const platform = refundedShare(settled);
  const bySeller = new Map<string, typeof settled>();
  for (const s of settled) bySeller.set(s.p.seller.id, [...(bySeller.get(s.p.seller.id) ?? []), s]);
  for (const [sellerId, list] of bySeller) {
    if (list.length < THRESHOLDS.sellerMinSettled) continue;
    const rate = refundedShare(list);
    if (rate < THRESHOLDS.sellerMinRate || rate < THRESHOLDS.sellerFactor * platform) continue;
    const name = list[0].p.seller.name;
    const bad = list.filter(({ m }) => m.status !== 'released');
    out.push({
      id: `seller_refund_concentration:${sellerId}`,
      rule: 'seller_refund_concentration',
      severity: rate >= 0.5 ? 'critical' : 'warning',
      title: `${name}: ${Math.round(rate * 100)}% of settled milestones refunded`,
      detail: `${bad.length} of ${list.length} settled milestones for ${name} ended in a full or partial refund, against ${Math.round(platform * 100)}% across the platform.`,
      metric: { label: `${name} refund rate`, value: rate, baseline: platform, unit: 'pct' },
      pactIds: [...new Set(bad.map(({ p }) => p.id))],
      amount: major(bad.reduce((a, { m }) => a + m.amountMinor, 0)),
      chart: {
        title: 'Milestone outcomes by seller (Sentinel)',
        widgetType: 'bar-chart-stacked-100',
        instructions:
          'Configure this chart: category = Milestone Seller (milestones.seller), value = count of Milestone Key (milestones.key), legend split by Milestone Status (milestones.status). Keep the title "Milestone outcomes by seller (Sentinel)".',
      },
    });
  }

  // 3. Repeated or unresolved rejections: the same milestone refused twice, or refused and still open.
  for (const { p, m } of milestones) {
    const rejected = m.verdicts.filter((v) => v.kind === 'verifier' && v.status === 'rejected');
    const open = !['released', 'partially_released', 'refunded', 'voided'].includes(m.status);
    if (rejected.length >= 2 || (rejected.length >= 1 && open)) {
      out.push({
        id: `repeat_rejections:${p.id}:${m.id}`,
        rule: 'repeat_rejections',
        severity: rejected.length >= 2 && open ? 'critical' : rejected.length >= 2 ? 'warning' : 'info',
        title: `"${m.title}" refused ${rejected.length}× (${p.title})`,
        detail: `The AI Verifier rejected the evidence ${rejected.length} time(s)${open ? ' and the milestone is still open' : ', later resolved'}. Latest reason: ${rejected.at(-1)!.reasoning.slice(0, 160)}`,
        metric: { label: 'Rejections', value: rejected.length, baseline: 1, unit: 'count' },
        pactIds: [p.id],
        amount: major(m.amountMinor),
        chart: null,
      });
    }
  }

  // 4. Money released on a low-confidence decision: approved by the AI below the confidence floor.
  for (const { p, m, v } of verdicts) {
    if (!['approved', 'release', 'partial'].includes(v.status) || v.confidence >= THRESHOLDS.lowConfidence) continue;
    if (m.capturedMinor <= 0) continue;
    out.push({
      id: `low_confidence_release:${v.id}`,
      rule: 'low_confidence_release',
      severity: v.confidence < 0.6 ? 'warning' : 'info',
      title: `$${major(m.capturedMinor).toFixed(0)} released at ${Math.round(v.confidence * 100)}% confidence`,
      detail: `${v.kind === 'arbiter' ? 'The AI Arbiter' : 'The AI Verifier'} decided "${v.status}" on "${m.title}" (${p.title}) with confidence ${Math.round(v.confidence * 100)}%, below the ${Math.round(THRESHOLDS.lowConfidence * 100)}% review floor. Worth a human look; the decision can be appealed.`,
      metric: { label: 'Decision confidence', value: v.confidence, baseline: THRESHOLDS.lowConfidence, unit: 'pct' },
      pactIds: [p.id],
      amount: major(m.capturedMinor),
      chart: null,
    });
  }

  // 5. Held funds whose PayPal authorization expires soon.
  for (const p of pacts) {
    if (p.heldMinor <= 0 || !p.authorizationExpiresAt) continue;
    const left = (Date.parse(p.authorizationExpiresAt) - t) / H;
    if (left > THRESHOLDS.authExpiringHours) continue;
    out.push({
      id: `authorization_expiring:${p.id}`,
      rule: 'authorization_expiring',
      severity: left <= THRESHOLDS.authCriticalHours ? 'critical' : 'warning',
      title: `$${major(p.heldMinor).toFixed(0)} authorization ${left <= 0 ? 'expired' : `expires in ${Math.max(1, Math.round(left))} h`}`,
      detail: `"${p.title}" still holds $${major(p.heldMinor).toFixed(2)} on a PayPal authorization valid until ${p.authorizationExpiresAt}. Capture the remaining milestones or reauthorize.`,
      metric: { label: 'Hours left', value: Math.max(0, Math.round(left)), baseline: THRESHOLDS.authExpiringHours, unit: 'hours' },
      pactIds: [p.id],
      amount: major(p.heldMinor),
      chart: null,
    });
  }

  // 6. Failed PayPal operations.
  const failed = payments.filter(({ x }) => FAILED.test(x.status));
  if (failed.length) {
    out.push({
      id: 'payment_failures',
      rule: 'payment_failures',
      severity: 'critical',
      title: `${failed.length} PayPal operation(s) failed`,
      detail: failed
        .slice(0, 3)
        .map(({ p, x }) => `${x.kind} ${x.status} on "${p.title}"`)
        .join('; '),
      metric: { label: 'Failed operations', value: failed.length, baseline: 0, unit: 'count' },
      pactIds: [...new Set(failed.map(({ p }) => p.id))],
      amount: major(failed.reduce((a, { x }) => a + x.amountMinor, 0)),
      chart: null,
    });
  }

  // 7. Open disputes.
  const disputes = pacts.flatMap((p) => p.disputes.filter((d) => d.status === 'open').map((d) => ({ p, d })));
  if (disputes.length) {
    out.push({
      id: 'open_disputes',
      rule: 'open_disputes',
      severity: 'warning',
      title: `${disputes.length} open dispute(s) waiting for the Arbiter`,
      detail: disputes.map(({ p, d }) => `"${p.title}" (opened by the ${d.openedBy})`).join('; '),
      metric: { label: 'Open disputes', value: disputes.length, baseline: 0, unit: 'count' },
      pactIds: [...new Set(disputes.map(({ p }) => p.id))],
      amount: null,
      chart: null,
    });
  }

  // 8. Appeals waiting for a human.
  const appeals = verdicts.filter(({ v }) => v.appealStatus === 'requested');
  if (appeals.length) {
    const oldest = Math.max(...appeals.map(({ v }) => (t - Date.parse(v.createdAt)) / H));
    out.push({
      id: 'pending_appeals',
      rule: 'pending_appeals',
      severity: oldest >= THRESHOLDS.appealWaitHours ? 'warning' : 'info',
      title: `${appeals.length} appeal(s) waiting for a human reviewer`,
      detail: `Oldest decision under appeal is ${Math.round(oldest)} h old. Appeals are the human check on every AI decision.`,
      metric: { label: 'Pending appeals', value: appeals.length, baseline: 0, unit: 'count' },
      pactIds: [...new Set(appeals.map(({ p }) => p.id))],
      amount: null,
      chart: null,
    });
  }

  // 9. Pacts stuck waiting for the buyer to approve funding in PayPal.
  const stalled = pacts.filter((p) => ['draft', 'proposed'].includes(p.status) && p.payments.some((x) => x.kind === 'order' && x.status === 'PAYER_ACTION_REQUIRED') && t - Date.parse(p.updatedAt) >= THRESHOLDS.stalledFundingHours * H);
  if (stalled.length) {
    out.push({
      id: 'stalled_funding',
      rule: 'stalled_funding',
      severity: 'info',
      title: `${stalled.length} pact(s) waiting for buyer approval in PayPal`,
      detail: `${stalled.map((p) => `"${p.title}"`).join(', ')}: a PayPal order was created but the buyer has not approved it for over ${THRESHOLDS.stalledFundingHours} h. Nothing is held yet.`,
      metric: { label: 'Stalled pacts', value: stalled.length, baseline: 0, unit: 'count' },
      pactIds: stalled.map((p) => p.id),
      amount: major(stalled.reduce((a, p) => a + p.totalMinor, 0)),
      chart: null,
    });
  }

  const rank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  out.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.amount ?? 0) - (a.amount ?? 0));
  return {
    asOf: now.toISOString(),
    status: out.some((a) => a.severity === 'critical') ? 'critical' : out.some((a) => a.severity === 'warning') ? 'warning' : 'clear',
    scanned: { pacts: pacts.length, milestones: milestones.length, verdicts: verdicts.length, payments: payments.length },
    rules: (Object.keys(RULES) as RuleId[]).map((id) => ({ id, label: RULES[id], triggered: out.filter((a) => a.rule === id).length })),
    anomalies: out,
  };
}

export function runSentinelScan(ctx: AppContext): SentinelScan {
  const pacts = ctx.db
    .select()
    .from(tables.pacts)
    .all()
    .map((r) => buildPactView(ctx, r));
  return scanLedger({ now: ctx.now(), pacts });
}

// --- Briefing: Muse explains what the rules found ---------------------------------------------

const Brief = z.object({
  headline: z.string().describe('One short sentence, at most 14 words, naming the most important risk.'),
  summary: z.string().describe('Two or three plain-English sentences for an operator: what was found, how much money is at stake, what to do first.'),
  actions: z.array(z.string()).describe('At most three concrete next steps, each under 15 words.'),
});
export type SentinelBrief = z.infer<typeof Brief> & { source: 'model' | 'template'; model: string | null; llmMode: string };

const BRIEF_PROMPT = [
  'You are PACT Sentinel, the risk monitor of an escrow ledger where PayPal holds buyer money and PACT releases it milestone by milestone after AI-verified evidence.',
  'A deterministic rules engine has already scanned the ledger. You receive its findings as JSON. Do not invent findings, amounts or names that are not in the JSON.',
  'Write for an operations person: calm, specific, no hype. Use US dollars as given. If there are no findings, say the ledger is clear and what was checked.',
].join('\n');

function templateBrief(scan: SentinelScan): Omit<SentinelBrief, 'source' | 'model' | 'llmMode'> {
  if (!scan.anomalies.length)
    return {
      headline: 'All clear: no rule triggered on the current ledger.',
      summary: `Checked ${scan.rules.length} rules over ${scan.scanned.pacts} pacts, ${scan.scanned.verdicts} decisions and ${scan.scanned.payments} PayPal operations. Nothing needs attention.`,
      actions: [],
    };
  const top = scan.anomalies[0];
  const atStake = scan.anomalies.reduce((a, x) => a + (x.amount ?? 0), 0);
  return {
    headline: top.title,
    summary: `${scan.anomalies.length} finding(s), ${scan.anomalies.filter((a) => a.severity === 'critical').length} critical, touching about $${atStake.toFixed(0)}. ${top.detail}`,
    actions: scan.anomalies.slice(0, 3).map((a) => `Review: ${a.title}`),
  };
}

export async function sentinelBrief(ctx: AppContext, scan: SentinelScan): Promise<SentinelBrief> {
  const findings = scan.anomalies.map((a) => ({ severity: a.severity, rule: RULES[a.rule], title: a.title, detail: a.detail, atStakeUsd: a.amount }));
  try {
    const r = await ctx.llm.structured({
      role: 'sentinel.brief',
      schema: Brief,
      schemaName: 'pact_sentinel_brief',
      reasoningEffort: 'low',
      maxOutputTokens: 1200,
      messages: [
        { role: 'system', content: BRIEF_PROMPT },
        { role: 'user', content: JSON.stringify({ scanned: scan.scanned, rulesChecked: scan.rules.length, findings }) },
      ],
    });
    return { ...r.value, actions: r.value.actions.slice(0, 3), source: 'model', model: r.model, llmMode: r.mode };
  } catch (e) {
    // No recorded answer (replay) or no key: the rules' own wording, labelled as such.
    if (!(e instanceof LlmReplayMissError)) console.warn(`[sentinel] brief fell back to the template: ${String(e).slice(0, 200)}`);
    return { ...templateBrief(scan), source: 'template', model: null, llmMode: ctx.llm.mode };
  }
}
