# Architecture

```
                  ┌──────────────────────────── apps/web (Next.js 16) ─────────────────────────────┐
  human  ───────▶ │ landing · pact composer · pact room · admin                                     │
  browser         │ Control Tower = AG Studio + 9 PACT widgets + PACT Auditor (Agent Framework)     │
                  │      │ REST + SSE                       │ /api/ai/responses (Muse proxy, replay) │
                  └──────┼──────────────────────────────────┼────────────────────────────────────────┘
                         ▼                                  ▼
  agents (Claude,  ┌──────────────── apps/api (Fastify, :4000) ───────────────┐      Meta Model API
  ChatGPT, demo) ─▶│ REST (Zod → OpenAPI 3.1) · SSE /api/events · MCP /mcp    │─────▶ Muse (parser,
   MCP over HTTP   │ PactService ── XState machine ── audit hash chain        │        verifier,
                   │ JobRunner (reauth, expiry, verify, reconcile) · webhooks  │        arbiter)
                   └──────┬──────────────────────┬────────────────────────────┘
                          ▼                      ▼
                 SQLite (better-sqlite3,   PaymentsGateway ──▶ PayPal sandbox REST
                 Drizzle) ./data/pact.db   (sandbox | SIMULATED)   Orders v2 AUTHORIZE, captures,
                 evidence ./data/evidence/                         void, reauth, refunds, payouts,
                                                                   webhooks, Transaction Search
```

## Packages

| Package | Role |
|---|---|
| `packages/core` | Zod schemas (contract, verdicts, arbiter decision — strict-JSON-schema compatible), the XState pact machine, money helpers (integer minor units), the audit hash chain, the reputation formula, shared view types. `@pact/core/browser` is the browser-safe entry. |
| `packages/db` | SQLite connection (better-sqlite3 ships prebuilt binaries for Windows, macOS and Linux: no compiler), hand-written SQL migrations, Drizzle table definitions, and the repo-root `.env.local` loader. |
| `packages/paypal` | `PaymentsGateway` interface, the real sandbox REST client, the SIMULATED adapter, typed errors, webhook normaliser. |
| `packages/llm` | Provider-agnostic `LlmClient` (OpenAI SDK pointed at `https://api.meta.ai/v1`), prompts and roles (Contract Parser, two-step Verifier, Arbiter), deterministic pre-checks, the record/replay cache. |
| `packages/agents` | Buyer and seller demo agents: a plain tool loop over the MCP client. |
| `apps/api` | Fastify server: services, routes, SSE, MCP server, jobs, webhooks, reconciliation. |
| `apps/web` | Next.js app started from the PayPal + AG Studio hackathon boilerplate. |

## State machine

Pact level: `draft → proposed → funded → in_progress ⇄ disputed → completed → closed`, plus `cancelled` and `expired`. Seller acceptance is a guarded flag inside `proposed` (funding is refused until the seller accepts).

Milestone level (one record per milestone in the machine context, guarded by `nextMilestoneStatus`):

```
pending ──SUBMIT_EVIDENCE──▶ evidence_submitted ──VERDICT approved──▶ approved ──RELEASE──▶ released
   ▲                              │  └─VERDICT needs_more─▶ needs_more ─┐                    │
   └────────── resubmit ◀──────── └──VERDICT rejected──▶ rejected ◀────┘                    │
evidence_submitted | approved | rejected | needs_more | released ──OPEN_DISPUTE──▶ disputed
disputed ──RESOLVE──▶ released | partially_released | refunded          any open ──CANCEL/EXPIRE──▶ voided
```

`applyPactEvent` restores the snapshot (`machine.resolveState`), checks `snapshot.can(event)` and uses XState's pure `transition()`. An event the machine would ignore throws `InvalidTransitionError`; the API answers **409** and appends a `transition.rejected` audit entry, so invalid moves fail loudly and leave a trace.

## Money

Amounts are integers in minor units. Milestone amounts are split with the remainder on the last milestone so they always sum to the total. Each money movement is a `payments` row (`order`, `authorization`, `capture`, `refund`, `void`, `reauthorization`, `payout`); held / released / refunded / voided are derived from those rows, never stored separately.

## AI layer

- **Contract Parser** returns `{status: ok | needs_clarification, questions, assumptions, contract}`; business rules JSON Schema cannot express (percentages sum to 100, unique ids, deadlines) are checked in code.
- **Verifier**, in two steps: (1) deterministic pre-checks — accepted evidence type, magic-byte sniffed mime, size, byte-identical reuse across pacts, submission deadline — reject without spending tokens; (2a) Muse **describes** each piece of evidence without seeing the criteria (counts, objects, visible text, quality issues); (2b) Muse **judges** the descriptions against the criteria with a strict schema. A deterministic policy then applies: approved requires every criterion passed and confidence ≥ 0.75; rejected requires a confidently failed criterion; anything else becomes `needs_more`. Low confidence never releases money.
- **Arbiter** reads the contract, all evidence descriptions, the verifier history and both statements, and returns release / partial (with a percentage) / refund, citing evidence ids. The percentage is clamped consistently with the decision, and every decision can be appealed to a human reviewer.
- **Replay cache**: every call is keyed by sha256 of (model, role, schema, messages with images replaced by their sha256). Volatile values — PACT ids, PayPal ids, timestamps, dates — are replaced by positional placeholders before hashing and mapped back to the current run's values on replay; dates the model derived from "today" are shifted by the days elapsed since the recording. The demo therefore replays on any day, and judges without a Meta key can run it.
- **Usage**: tokens and cost per call (Meta's published muse-spark-1.x prices) feed the Admin page.

## AG Studio

The Control Tower is a single Studio instance with sync data sources from `GET /api/dashboard` (PACT's ledger) and `GET /api/reconciliation` (PayPal). Live updates: the browser keeps one SSE connection; each event triggers a refetch and the new rows are passed to Studio's `data` prop (Studio's sync-data reload; structure is fixed at init). Custom widgets read fields from `widgetApi.getSchema()` and use `getData` with `onDataUpdated`, so they respect page filters and cross-filters. The Pact Ledger widget implements drill-through with Studio's own cross-filter (`toggleCrossFilter` multi-value on `pacts.id`); double-click opens the pact room.

The Sankey is drawn in SVG by PACT: AG Charts' Sankey series is an AG Charts Enterprise feature that requires its own licence inside a custom widget.

The **PACT Auditor** is a custom primary agent registered with `createAiHarness`, run by `directLlmRunner` with the OpenAI Responses adapter from the Studio docs, pointed at PACT's server proxy which forwards to Meta's `/v1/responses` (non-streaming upstream, re-emitted as Responses SSE events). It has six PACT tools defined with `api.defineAiTool` and delegates dashboard edits to Studio's built-in `planning`, `data`, `page` and `widget` agents via `tools.delegateTo`. Its instructions are rebuilt every run from live PACT context and `api.getAiContext().schema()`.

## Limitations (honest list)

- No user authentication in the web demo: the role switch (buyer / seller / reviewer) sets an `x-pact-actor` header for the audit log. Agents are authenticated (MCP keys).
- Overturning an **Arbiter** decision on appeal is recorded and audit-logged, but the compensating payment is not executed automatically (overturning a **Verifier** rejection does move the money, through a human-resolved dispute).
- One currency per pact; no FX.
- The simulated adapter does not model risk declines, pending captures or fees.
