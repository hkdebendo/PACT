# PACT Sentinel

The Sentinel watches the escrow ledger for things an operator should look at: refund spikes, a
seller whose deals keep ending in refunds, evidence that keeps getting rejected, money released on a
shaky AI decision, PayPal authorizations about to lapse.

The design rule is simple: **rules decide, the model explains, Studio's agents build the view.**

| Layer | Where | What it does |
|---|---|---|
| Rules engine | `apps/api/src/services/sentinel.ts` | Nine deterministic checks over pacts, milestones, verdicts and PayPal operations. Same ledger, same alerts. No model involved. |
| REST | `GET /api/sentinel/scan`, `POST /api/sentinel/brief` | The scan, and the scan plus a plain-English briefing written by Muse (role `sentinel.brief`, recorded for replay; falls back to the rules' own wording, labelled as such). |
| Anomaly Radar widget | `apps/web/app/control-tower/studio/widgets/sentinel.tsx` | A custom AG Studio widget: severity, metric against its baseline, money at stake, affected pacts (filter the page or open the pact room), and every rule checked. Re-scans on each live update. |
| PACT Sentinel agent | `apps/web/app/control-tower/studio/sentinel-agent.ts` | An agent in Studio's Agent Framework whose loop is ours (`clientToolRunner`). See below. |

## The rules

| Rule | Triggers when | Severity |
|---|---|---|
| `refund_velocity` | Refunds and buyer-side voids in the last 24 h are at least $50 **and** at least 2× the 7-day daily average. Automatic voids of an unused remainder after a final capture are ignored. | critical at 4× the larger of $50 and the average, else warning |
| `seller_refund_concentration` | A seller with at least 2 settled milestones has a full/partial refund rate ≥ 34 % **and** ≥ 2× the platform rate. | critical at ≥ 50 %, else warning |
| `repeat_rejections` | A milestone was rejected twice, or rejected and still open. | critical (twice and open), warning (twice), info |
| `low_confidence_release` | Money was captured on an approve / release / partial decision below 75 % confidence. | warning below 60 %, else info |
| `authorization_expiring` | Funds are still held on an authorization that lapses within 72 h. | critical within 24 h |
| `payment_failures` | A PayPal operation is FAILED, DENIED, DECLINED, ERROR or REVERSED. | critical |
| `open_disputes` | A dispute is waiting for the Arbiter. | warning |
| `pending_appeals` | A decision is under appeal. | warning after 24 h, else info |
| `stalled_funding` | A draft/proposed pact has a PayPal order waiting for the buyer's approval for over 24 h. | info |

Thresholds live in `THRESHOLDS` in `sentinel.ts`; `apps/api/test/sentinel.test.ts` covers each rule,
including the cases that must *not* fire (a steady week of refunds, an automatic void).

## The agent: our loop inside Studio's Agent Framework

Studio's Agent Framework accepts agents whose turns are produced by your own code
(`clientToolRunner`): you emit the protocol events, Studio executes the tool calls you leave
unresolved and calls you again with the results. The PACT Sentinel uses that to put a
**deterministic rules engine** in the agent roster next to the LLM agents:

1. **Round 1:** fetch `POST /api/sentinel/brief`, stream the briefing as text, pick the finding the
   user asked about (a name in the question) or the most severe one, and call
   `raise_anomaly_alert`. That PACT tool (defined with `api.defineAiTool`) pins the finding on the
   Anomaly Radar, opens the Sentinel page and places an empty chart of the right type for it.
2. **Round 2:** call Studio's `delegate_to` with the built-in **Widget agent** and the typed params
   that agent declares (`widgetType`, `widgetId`, `pageId`), plus a plain-language chart spec
   (*"category = Milestone Seller, value = count of milestones, split by Milestone Status"*). Studio's
   Widget agent, running on Muse, configures the chart.
3. **Round 3:** report what was done. When another agent delegated the scan (the PACT Auditor does
   for "what needs attention?"), the Sentinel ends with `complete_task`, so its summary flows back
   to the Auditor.

So one question in the chat travels: PACT Auditor (Muse) → PACT Sentinel (rules + Muse briefing)
→ Studio's Widget agent (Muse) → back up the chain, with every step visible in Studio's chat rail.
Users can also start a chat with the Sentinel directly from the agent picker.

## Real or simulated

The rules read PACT's own ledger, which mirrors what PACT did in PayPal (real sandbox or the labelled
simulated adapter, see the Mode banner). The Sentinel never moves money and never changes a pact: it
reads, explains and builds dashboard views.
