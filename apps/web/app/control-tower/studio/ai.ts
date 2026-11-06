/* eslint-disable @typescript-eslint/no-explicit-any */
// The AG Studio Agent Framework setup for the Control Tower.
//
// Primary agent "pact-auditor" (custom, driven by Meta Muse through the Responses adapter and the
// server proxy at /api/ai/responses). It has PACT tools of its own (get_verdict,
// list_refused_milestones, explain_decision, open_pact_drilldown, verify_audit_chain,
// add_refused_milestones_widget) and DELEGATES dashboard work to Studio's built-in agents
// (planning, data, page, widget) through tools.delegateTo. Its instructions are re-resolved every
// run from live PACT context (runtime modes, ledger totals, audit chain) plus Studio's own
// agent context (api.getAiContext().schema()).
import { createAiHarness, directLlmRunner, type AgAiHarnessSetup, type AgAiPromptStarter, type AgStudioApi } from 'ag-studio';
import { openaiAdapter } from './openai-adapter';
import type { TowerContext } from './widgets/common';

export const PROMPT_STARTERS: AgAiPromptStarter[] = [
  { label: 'Why was milestone 2 refused?', prompt: 'Why was milestone 2 refused? Show all refused milestones this week.' },
  { label: 'Is the audit chain intact?', prompt: 'Is the audit chain intact? Summarise what the AI decided today.' },
  { label: 'Who is most reliable?', prompt: 'Which seller has the best reputation, and why? Add a chart of reputation by party.' },
];

async function getJson(apiUrl: string, path: string, signal?: AbortSignal) {
  const res = await fetch(`${apiUrl}${path}`, { signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? `HTTP ${res.status}`);
  return body;
}

function pactTools(api: AgStudioApi, ctx: () => TowerContext) {
  const getVerdict = api.defineAiTool({
    name: 'get_verdict',
    description: 'Fetch one PACT verdict (AI Verifier, AI Arbiter or human) with its per-criterion results, reasoning, confidence, model and appeal status. Omit verdictId for the most recent verdict.',
    params: (s: any) => s.object({ verdictId: s.string({ description: 'Verdict id (vd_...). Omit for the latest.' }).optional() }),
    execute: async (args: any, c: any) => {
      const { apiUrl } = ctx();
      const v = args.verdictId ? await getJson(apiUrl, `/api/verdicts/${args.verdictId}`, c.signal) : (await getJson(apiUrl, '/api/verdicts', c.signal))[0];
      if (!v) return c.error('No verdicts yet.');
      return c.success(`Verdict ${v.id}: ${v.status} (confidence ${v.confidence}).`, v);
    },
  });

  const listRefused = api.defineAiTool({
    name: 'list_refused_milestones',
    description: 'List milestones the AI refused (Verifier "rejected" or Arbiter "refund") in the last N days, newest first, with pact, milestone, reasoning and confidence.',
    params: (s: any) => s.object({ days: s.number({ description: 'Look-back window in days. Defaults to 7.' }).optional() }),
    execute: async (args: any, c: any) => {
      const since = new Date(Date.now() - (args.days ?? 7) * 864e5).toISOString();
      const all = await getJson(ctx().apiUrl, `/api/verdicts?since=${encodeURIComponent(since)}`, c.signal);
      const refused = all.filter((v: any) => v.status === 'rejected' || v.status === 'refund');
      return c.success(`${refused.length} refused milestone decision(s) since ${since.slice(0, 10)}.`, {
        refused: refused.map((v: any) => ({ verdictId: v.id, pactId: v.pactId, milestoneId: v.milestoneId, decidedBy: v.kind, status: v.status, confidence: v.confidence, reasoning: v.reasoning, precheckFailures: v.precheckFailures, at: v.createdAt })),
      });
    },
  });

  const explain = api.defineAiTool({
    name: 'explain_decision',
    description: 'Everything behind one decision: the milestone criteria, the evidence descriptions the Verifier produced (step 1, written without seeing the criteria), the per-criterion judgement (step 2), deterministic pre-check failures, and the audit-log entries for that verdict with the chain status.',
    params: (s: any) => s.object({ verdictId: s.string({ description: 'Verdict id (vd_...)' }) }),
    execute: async (args: any, c: any) => {
      const { apiUrl } = ctx();
      const v = await getJson(apiUrl, `/api/verdicts/${args.verdictId}`, c.signal);
      const pact = await getJson(apiUrl, `/api/pacts/${v.pactId}`, c.signal);
      const m = pact.milestones.find((x: any) => x.id === v.milestoneId);
      const audit = (await getJson(apiUrl, `/api/audit?pactId=${v.pactId}`, c.signal)).filter((e: any) => JSON.stringify(e.data).includes(v.id));
      const chain = await getJson(apiUrl, '/api/audit/verify', c.signal);
      return c.success(`Explanation for ${v.id}.`, {
        pact: { id: pact.id, title: pact.title, status: pact.status, paymentMode: pact.paymentMode },
        milestone: { id: m.id, title: m.title, percent: m.percent, criteria: m.criteria, status: m.status },
        evidence: m.evidence.filter((e: any) => v.evidenceIds.includes(e.id)).map((e: any) => ({ id: e.id, type: e.type, filename: e.filename, sha256: e.sha256, description: e.description })),
        verdict: { status: v.status, confidence: v.confidence, reasoning: v.reasoning, criteria: v.verifier?.criteria ?? null, arbiter: v.arbiter, precheckFailures: v.precheckFailures, model: v.model, llmMode: v.llmMode },
        audit: audit.map((e: any) => ({ seq: e.seq, type: e.type, hash: e.hash })),
        chain: { ok: chain.ok, count: chain.count, headHash: chain.headHash },
      });
    },
  });

  const drill = api.defineAiTool({
    name: 'open_pact_drilldown',
    description: "Open a pact's room (timeline, evidence, verdicts, audit trail) for the user, optionally scrolled to one milestone.",
    params: (s: any) => s.object({ pactId: s.string({ description: 'Pact id (pact_...)' }), milestoneId: s.string({ description: 'Milestone id, e.g. m2' }).optional() }),
    execute: async (args: any, c: any) => {
      ctx().openPact(args.pactId, args.milestoneId);
      return c.success(`Opened pact ${args.pactId}${args.milestoneId ? ` at ${args.milestoneId}` : ''}.`);
    },
  });

  const chain = api.defineAiTool({
    name: 'verify_audit_chain',
    description: 'Recompute every SHA-256 link of the append-only audit log and report whether it is intact.',
    params: (s: any) => s.object({}),
    execute: async (_args: any, c: any) => {
      const r = await getJson(ctx().apiUrl, '/api/audit/verify', c.signal);
      return r.ok ? c.success(`Chain intact: ${r.count} entries, head ${r.headHash.slice(0, 16)}.`, r) : c.error(`Chain broken at entry #${r.brokenAt}: ${r.reason}`);
    },
  });

  const addRefused = api.defineAiTool({
    name: 'add_refused_milestones_widget',
    description: 'Add a "Refused milestones" widget to the current page: every Verifier rejection and Arbiter refund in the last 7 days, with reasoning, confidence and appeal status. Use this when the user asks to SEE refused milestones.',
    params: (s: any) => s.object({ title: s.string({ description: 'Widget title. Defaults to "Refused milestones this week".' }).optional() }),
    execute: async (args: any, c: any) => {
      const state = api.getState() as any;
      const page = state.pages.find((p: any) => p.id === state.selectedPageId);
      if (!page) return c.error('No page is selected.');
      const id = `refused-${Date.now().toString(36)}`;
      const bottom = Math.max(0, ...Object.values(page.widgetLayout ?? {}).map((l: any) => l.yTrack + l.ySpan));
      api.setState({
        ...state,
        pages: state.pages.map((p: any) =>
          p.id !== page.id
            ? p
            : {
                ...p,
                widgets: { ...p.widgets, [id]: { type: 'pact-refused-list', dataMapping: {}, format: { title: { enabled: true, text: args.title ?? 'Refused milestones this week' } } } },
                widgetLayout: { ...p.widgetLayout, [id]: { xTrack: 0, yTrack: bottom, xSpan: 24, ySpan: 16 } },
              },
        ),
      });
      return c.success(`Added widget ${id} at the bottom of the page.`, { widgetId: id });
    },
  });

  return [getVerdict, listRefused, explain, drill, chain, addRefused];
}

export function buildAi(getContext: () => TowerContext): AgAiHarnessSetup {
  // Studio's adapter speaks the OpenAI Responses format; the endpoint is PACT's own server proxy,
  // which holds the Meta key and forwards to Muse. The model id here is informational only:
  // the proxy always uses MUSE_MODEL.
  const adapter = openaiAdapter({ endpoint: '/api/ai', model: 'muse-spark-1.3' });

  return ({ api }) =>
    createAiHarness(api, ({ tools, builtIn }: any) => {
      const custom = pactTools(api, getContext);
      const delegates = ['planning', 'data', 'page', 'widget'];
      return {
        agents: [
          directLlmRunner({
            id: 'pact-auditor',
            adapter,
            description: 'PACT Auditor: explains escrow decisions and audits the PACT ledger.',
            schema: (s: any) => s.undefined(),
            instructions: () => {
              const ctx = getContext();
              const { tables } = api.getAiContext().schema();
              return [
                'You are the PACT Auditor inside the PACT Control Tower, an AG Studio dashboard over an escrow ledger.',
                'PACT: buyers and sellers (often AI agents) agree a deal; PayPal holds the money with an authorization; PACT captures each milestone share only after the AI Verifier approves evidence; disputes go to an AI Arbiter; every decision can be appealed to a human and is written to a SHA-256 hash-chained audit log.',
                `Runtime: PayPal ${ctx.paymentMode === 'sandbox' ? 'REAL sandbox' : 'SIMULATED adapter (say so if asked about payments)'}; model responses ${ctx.llmMode === 'replay' ? 'replayed from recordings' : 'live'}. Audit chain ${ctx.audit.ok ? 'verified' : 'BROKEN'} (${ctx.audit.count} entries).`,
                `Dashboard tables: ${tables.map((t: any) => t.name).join(', ')}.`,
                'How to work:',
                '- "Why was X refused/approved?": call list_refused_milestones or get_verdict to find the verdict, then explain_decision. Quote the failed criterion and the facts from the evidence description. Mention the confidence and that the decision can be appealed.',
                '- "Show/list/add ..." for refused milestones: call add_refused_milestones_widget. For any other new chart or widget, delegate to the built-in agents with delegate_to (page to place widgets, widget to configure one, data for numeric questions, planning for multi-widget layouts).',
                '- To let the user inspect evidence, call open_pact_drilldown.',
                '- Never invent ids, amounts or reasons: everything you state must come from a tool result.',
                'Answer in plain English, 2-5 short sentences, no markdown tables.',
              ].join('\n');
            },
            tools: () => [tools.studio.viewSchema(), tools.studio.viewPage(), tools.studio.executeQuery(), ...custom, tools.delegateTo(delegates)],
          }),
          ...delegates.map((id) => directLlmRunner({ ...builtIn[id], adapter })),
        ],
        primary: 'pact-auditor',
        promptStarters: PROMPT_STARTERS,
      };
    });
}
