/* eslint-disable @typescript-eslint/no-explicit-any */
// PACT Sentinel: an agent whose loop is NOT an LLM loop.
//
// It plugs into AG Studio's Agent Framework through clientToolRunner ("an agent whose turns you
// produce and whose tools Studio runs"). Each round is produced here, from PACT's deterministic
// rules engine on the API server (GET /api/sentinel/scan) and a Muse-written briefing
// (POST /api/sentinel/brief, recorded for replay, template fallback). Studio then executes the tool
// calls the round asks for:
//   - raise_anomaly_alert (PACT tool): pins the finding on the Anomaly Radar, opens the Sentinel
//     page and places an empty chart of the right type for the finding;
//   - delegate_to (Studio harness tool): hands that chart's configuration to Studio's built-in
//     Widget agent, with the typed params it declares (widgetType, widgetId, pageId);
//   - complete_task (when another agent, e.g. the PACT Auditor, delegated the scan to it).
// Rules decide, the model only explains, and Studio's own agents build the visuals.
import { clientToolRunner, type AgAiEvent, type AgAiRunInput, type AgStudioApi } from 'ag-studio';
import type { TowerContext } from './widgets/common';
import type { SentinelAnomaly, SentinelScan } from './widgets/sentinel';

interface Brief {
  headline: string;
  summary: string;
  actions: string[];
  source: 'model' | 'template';
  model: string | null;
}

const RADAR_TYPE = 'pact-sentinel-radar';
const SENTINEL_PAGE = 'sentinel';

let seq = 0;
const nextId = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

async function* text(content: string): AsyncGenerator<AgAiEvent> {
  const messageId = nextId('sentinel-msg');
  yield { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' } as AgAiEvent;
  yield { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: content } as AgAiEvent;
  yield { type: 'TEXT_MESSAGE_END', messageId } as AgAiEvent;
}
async function* call(name: string, args: Record<string, unknown>): AsyncGenerator<AgAiEvent> {
  const toolCallId = nextId('sentinel-call');
  yield { type: 'TOOL_CALL_START', toolCallId, toolCallName: name } as AgAiEvent;
  yield { type: 'TOOL_CALL_ARGS', toolCallId, delta: JSON.stringify(args) } as AgAiEvent;
  yield { type: 'TOOL_CALL_END', toolCallId } as AgAiEvent;
}

/** Messages of the current exchange: everything after the latest user message. */
function currentExchange(input: AgAiRunInput) {
  const lastUser = input.messages.map((m) => m.role).lastIndexOf('user');
  return { ask: lastUser >= 0 ? String((input.messages[lastUser] as any).content ?? '') : '', after: input.messages.slice(lastUser + 1) };
}

/** The finding the user is asking about (a name or rule mentioned), else the most severe one. */
function pick(anomalies: SentinelAnomaly[], ask: string) {
  const words = ask.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? [];
  const stop = new Set(['scan', 'what', 'with', 'this', 'that', 'there', 'anything', 'ledger', 'anomalies', 'anomaly', 'risks', 'risk', 'show', 'please', 'today', 'check', 'suspicious', 'find', 'needs', 'attention', 'right', 'sentinel', 'riskiest', 'finding', 'findings', 'run']);
  const hits = anomalies.filter((a) => words.some((w) => !stop.has(w) && `${a.title} ${a.detail}`.toLowerCase().includes(w)));
  return hits[0] ?? anomalies[0];
}

const money = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const slug = (t: string) =>
  'sentinel-' +
  t
    .toLowerCase()
    .replace(/\(sentinel\)/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

export function buildSentinelAgent(api: AgStudioApi, getContext: () => TowerContext, tools: any) {
  const raise = api.defineAiTool({
    name: 'raise_anomaly_alert',
    description:
      'Pin a Sentinel finding on the Anomaly Radar (adding the radar to the Sentinel page if missing), open that page and, when a chart is given, place an empty chart of that type under the radar for the Widget agent to configure.',
    params: (s: any) =>
      s.object({
        focus: s.string({ description: 'Rule id of the finding to pin first, e.g. seller_refund_concentration.' }),
        headline: s.string({ description: 'One-line briefing shown on the radar.' }),
        chartTitle: s.string({ description: 'Title of the chart to place.' }).optional(),
        chartType: s.string({ description: 'Studio widget type of the chart, e.g. bar-chart-stacked-100.' }).optional(),
      }),
    execute: async (args: any, c: any) => {
      const state = api.getState() as any;
      const page = state.pages.find((p: any) => p.id === SENTINEL_PAGE) ?? state.pages.find((p: any) => p.id === state.selectedPageId);
      if (!page) return c.error('No page to place the radar on.');
      const widgets = { ...(page.widgets ?? {}) };
      const layout = { ...(page.widgetLayout ?? {}) };
      const bottom = () => Math.max(0, ...Object.values(layout).map((l: any) => l.yTrack + l.ySpan));
      const radarId = Object.keys(widgets).find((k) => widgets[k].type === RADAR_TYPE) ?? 'sentinel-radar';
      const radar = widgets[radarId] ?? { type: RADAR_TYPE, dataMapping: {}, format: { title: { enabled: true, text: 'Anomaly radar' } } };
      if (!layout[radarId]) layout[radarId] = { xTrack: 0, yTrack: bottom(), xSpan: 14, ySpan: 30 };
      widgets[radarId] = { ...radar, format: { ...radar.format, style: { ...(radar.format?.style ?? {}), focus: args.focus, headline: args.headline } } };
      // Deterministic id from the title: replays see the same page state.
      let chartId: string | null = null;
      if (args.chartTitle && args.chartType) {
        chartId = slug(args.chartTitle);
        if (!widgets[chartId]) {
          widgets[chartId] = {
            type: args.chartType,
            dataMapping: {},
            format: { title: { enabled: true, text: args.chartTitle }, subtitle: { enabled: true, text: 'Configured by Studio’s Widget agent for the PACT Sentinel' } },
          };
          layout[chartId] = { xTrack: 0, yTrack: bottom(), xSpan: 24, ySpan: 18 };
        }
      }
      api.setState({ ...state, selectedPageId: page.id, pages: state.pages.map((p: any) => (p.id !== page.id ? p : { ...p, widgets, widgetLayout: layout })) });
      return c.success(`Pinned "${args.focus}" on the Anomaly Radar (page ${page.id}).${chartId ? ` Placed an empty ${args.chartType} chart: chartWidget=${chartId}` : ''}`, { radarId, chartId, pageId: page.id });
    },
  });

  /** A chart for this finding is already configured on the Sentinel page: nothing to build. */
  const configured = (title: string) => {
    const state = api.getState() as any;
    const page = state.pages.find((p: any) => p.id === SENTINEL_PAGE);
    return Object.values(page?.widgets ?? {}).some((w: any) => w?.format?.title?.text === title && Object.keys(w.dataMapping ?? {}).length > 0);
  };
  const scanOf = (apiUrl: string, signal?: AbortSignal): Promise<SentinelScan | null> =>
    fetch(`${apiUrl}/api/sentinel/scan`, { signal })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

  return clientToolRunner({
    id: 'pact-sentinel',
    name: 'PACT Sentinel',
    description:
      'PACT Sentinel: runs the deterministic anomaly rules over the escrow ledger (refund spikes, seller refund concentration, repeated rejections, low-confidence releases, expiring PayPal authorizations, failed operations, open disputes, pending appeals, stalled funding), explains the findings, pins them on the Anomaly Radar and has Studio build a chart for the most important one. Delegate to it for any question about risk, fraud, anomalies or what needs attention.',
    schema: (s: any) => s.undefined(),
    maxTurns: 5,
    tools: () => [raise, tools.delegateTo(['widget'])],
    run: async function* (input, ctx): AsyncGenerator<AgAiEvent> {
      const { apiUrl } = getContext();
      const { ask, after } = currentExchange(input);
      const calls = after.flatMap((m: any) => (m.role === 'assistant' ? (m.toolCalls ?? []) : [])) as any[];
      const results = after.filter((m) => m.role === 'tool') as any[];
      const resultOf = (name: string) => {
        const id = calls.find((c) => c.function?.name === name || c.name === name)?.id;
        return id ? results.find((r) => r.toolCallId === id) : undefined;
      };

      // Round 1: scan, brief, pin the finding (and place its chart).
      if (!results.length) {
        const res = await fetch(`${apiUrl}/api/sentinel/brief`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pact-Actor': 'agent:pact-sentinel' }, body: '{}', signal: ctx.signal });
        if (!res.ok) {
          yield* text(`The Sentinel scan failed (HTTP ${res.status}). Is the PACT API running?`);
          return;
        }
        const { scan, brief } = (await res.json()) as { scan: SentinelScan; brief: Brief };
        const lines = [
          `**${brief.headline}**`,
          brief.summary,
          `Checked ${scan.rules.length} rules over ${scan.scanned.pacts} pacts, ${scan.scanned.verdicts} AI decisions and ${scan.scanned.payments} PayPal operations${brief.source === 'template' ? ' (briefing in the rules’ own words: no recorded model answer)' : ''}.`,
        ];
        if (brief.actions.length) lines.push(brief.actions.map((a) => `- ${a}`).join('\n'));
        yield* text(lines.join('\n\n'));
        if (!scan.anomalies.length) {
          if (ctx.completeTask) yield* call('complete_task', { summary: `${brief.headline} ${brief.summary}`, artifacts: [] });
          return;
        }
        const top = pick(scan.anomalies, ask);
        const chart = top.chart && !configured(top.chart.title) ? top.chart : null;
        yield* call('raise_anomaly_alert', { focus: top.rule, headline: brief.headline, ...(chart && { chartTitle: chart.title, chartType: chart.widgetType }) });
        return;
      }

      const scan = await scanOf(apiUrl, ctx.signal);
      const top = scan?.anomalies.length ? pick(scan.anomalies, ask) : null;

      // Round 2: hand the empty chart to Studio's built-in Widget agent, with its typed params.
      const raised = resultOf('raise_anomaly_alert');
      const chartId = String(raised?.content ?? '').match(/chartWidget=([\w-]+)/)?.[1];
      const delegated = resultOf('delegate_to');
      if (chartId && !delegated && top?.chart) {
        yield* call('delegate_to', { type: { id: 'widget', widgetType: top.chart.widgetType, widgetId: chartId, pageId: SENTINEL_PAGE }, instructions: top.chart.instructions });
        return;
      }

      // Round 3: report.
      const summary = [
        top ? `Pinned "${top.title}"${top.amount != null ? ` (${money(top.amount)} at stake)` : ''} on the Anomaly Radar, Sentinel page.` : 'Pinned the finding on the Anomaly Radar.',
        delegated && top?.chart ? `Studio's Widget agent configured "${top.chart.title}" below it.` : '',
        scan && scan.anomalies.length > 1 ? `${scan.anomalies.length - 1} other finding(s) are listed on the radar.` : '',
      ]
        .filter(Boolean)
        .join(' ');
      yield* text(summary);
      if (ctx.completeTask) yield* call('complete_task', { summary, artifacts: [] });
    },
  });
}
