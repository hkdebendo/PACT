# Devpost submission — ready to paste

## Project name
PACT

## Tagline
Where AI agents sign deals and PayPal enforces them.

## Inspiration
AI agents are starting to buy and sell on our behalf, and the first thing they run into is the oldest problem in commerce: who goes first? An agent that pays another agent, a freelancer or a seller on a chat app pays blind. For millions of small sellers and freelancers in emerging markets, "I paid and received nothing" is the reason buyers will not deal with them at all. Escrow solves this, but today it is manual, slow and opaque. We wanted trust that software can enforce — and explain.

## What it does
PACT is an escrow platform for agents and people.

- **Say the deal.** A buyer (or the buyer's agent) writes the deal in plain words — *"50 embroidered t-shirts before Friday, 30% at production, 70% at delivery."* Meta Muse turns it into a contract with milestones, checkable criteria and accepted evidence types, or asks clarification questions instead of guessing.
- **PayPal holds the money.** The buyer approves once in PayPal checkout. PACT creates an Orders v2 order with `intent: AUTHORIZE`: funds are held, not charged. That single human approval is the spending cap every agent then operates inside.
- **Evidence, verified.** The seller submits photos, tracking pages, documents or code. Deterministic checks run first (file type, size, evidence reused from another deal, deadline). Then Muse describes the evidence *without seeing the criteria*, and a second Muse step judges that description against each criterion. Low confidence never releases money.
- **Programmable release.** Each approved milestone is a **partial capture** of the authorization; the last one is a final capture; anything no longer payable is **voided**; a dispute resolved for the buyer becomes a **refund**. Subcontractors can be paid with **Payouts**.
- **Transparent arbitration.** Disputes go to an AI Arbiter that reads the contract, evidence and both statements and decides release, partial or refund — with reasons, cited evidence and a human appeal button.
- **For agents.** An MCP server exposes `create_pact`, `fund_pact`, `submit_evidence`, `verify_milestone`, `release_funds`, `open_dispute`, `get_reputation` and more. Two Muse agents play buyer and seller in the demo with no human scripting.
- **For operators.** The PACT Control Tower, built on AG Studio, shows the ledger live across five pages: KPI tiles with growth sparklines, Escrow Vault, Milestone Timeline, Verdict Card, Reputation Leaderboard, a Money Flow Sankey, dispute and refund gauges, PayPal reconciliation and an Anomaly Radar. A custom AG Studio agent, the PACT Auditor, answers *"Why was milestone 2 refused?"* from the evidence and builds new widgets by delegating to Studio's own agents.
- **A Sentinel that watches the money.** Nine deterministic rules flag refund spikes, sellers whose deals keep ending in refunds, repeated evidence rejections, money released on low-confidence AI decisions and PayPal authorizations about to lapse. Ask *"What needs attention right now?"*: the Auditor hands off to the PACT Sentinel, which pins the riskiest finding on the radar and has Studio's own Widget agent build the chart that shows it. Rules decide, the model explains.
- **Auditable.** Every state change and AI decision is appended to a SHA-256 hash chain; one click recomputes it.

## How we built it
TypeScript end to end, in an npm-workspaces monorepo that runs with `npm install && npm run dev` — no Docker, no database server.

- **PayPal (sandbox):** OAuth2 with token caching; Orders v2 `AUTHORIZE`; Payments v2 authorizations — partial and final captures, void, reauthorize; refunds; Payouts; webhook signature verification; Transaction Search and balances for reconciliation; the PayPal JS SDK buttons for the buyer approval. Every write carries a deterministic `PayPal-Request-Id`, with bounded retries on 429/5xx and typed errors surfaced in the UI and the audit log. A reconciliation poller covers what webhooks cannot reach on localhost; a re-authorization job handles the 3-day honor period and 29-day validity.
- **AI (Meta Muse via the Meta Model API, OpenAI-compatible):** Contract Parser, two-step multimodal Verifier, Arbiter, the two demo agents (plain tool-calling loops over the MCP client), and the AG Studio agent. Structured outputs are Zod schemas compiled to strict JSON Schema. A record/replay cache makes the demo deterministic and lets judges without a Meta key run it; volatile ids and dates are normalised so recordings replay on any day.
- **AG Studio:** a custom PACT theme (light and dark modes) built on Studio's theming API and shared with the app's design tokens, a matching AG Grid theme for PACT's grid widgets, eleven custom widgets that adapt their layout to the size they are given (container queries), a KPI Tile whose metric is picked in Studio's own edit form, Studio charts and filters mixed in on five pages, live data pushed from Server-Sent Events into Studio's data sources, and drill-through with Studio's cross-filter. In the Agent Framework: a custom primary agent (PACT Auditor, Muse via a server-side adapter proxy) with PACT tools that delegates to Studio's built-in planning, data, page and widget agents, and a second agent with **its own loop** (PACT Sentinel, `clientToolRunner`: a rules engine instead of an LLM) that Studio runs tools for, including a typed delegation to Studio's Widget agent.
- **Core:** XState state machine with guarded transitions (invalid moves fail with 409 and are audit-logged), SQLite with Drizzle, Fastify, Zod-generated OpenAPI 3.1 and a Postman collection, Vitest and Playwright, GitHub Actions.

## Challenges we ran into
- **An agent cannot click "approve" in PayPal — and should not.** We made the human approval a feature: agents act inside an authorization the human capped.
- **Vision models can be wrong.** We split verification so the model describes evidence before it knows what the evidence should prove, added deterministic pre-checks, and wrapped the model's verdict in a policy that turns low confidence into "needs more evidence".
- **Determinism for the video and for judges.** Replaying recorded model answers breaks as soon as ids or dates change, so we normalise volatile values in the cache key and shift dates on replay.
- **Partial captures and authorization lifetimes.** Honor period, 29-day validity, reauthorization rules and auto-void on final capture all shape when PACT can move money. Testing a real 4-day-old authorization showed that a reauthorization keeps the original expiry and cannot itself be voided (only the original can, which voids both), so PACT now always voids the original.
- **Bringing our own model into AG Studio's Agent Framework.** Studio's built-in tools use deep, recursive JSON Schemas; Meta's Model API rejects recursive schemas and anything nested deeper than 10 levels. Our server-side adapter proxy rewrites each tool schema into a finite, bounded one (shared definitions kept, deep paths cut and sent non-strict) while Studio still validates every argument the model returns.
- **Making a rules engine a first-class agent.** We wanted anomaly detection to be deterministic and testable, but still part of the conversation. Studio's `clientToolRunner` let us produce the Sentinel's turns ourselves (protocol events, tool calls left for Studio to run) and resume with the results, so a non-LLM agent can pin findings, delegate chart-building to Studio's Widget agent and hand its summary back to the LLM agent that called it.
- **A real race condition.** Our reconciliation poller and the buyer confirming the same PayPal approval at the same moment produced a double transition. One in-flight confirmation per pact fixed it; a test now covers it.
- **Writing criteria a photo can prove.** Our first contracts asked a photo to "count 50 shirts" and prove "embroidery". The Verifier rightly refused. The Contract Parser now writes criteria evidence can actually satisfy (a quantity label, a visible mark) — and the Verifier still rejects the wrong item at 0.99 confidence.

## Accomplishments that we're proud of
- A real money flow in the PayPal sandbox, verified end to end: authorize once, 30% partial capture, 70% final capture, partial refund, void on cancellation, a dispute resolved at 60% with the remainder released, and a Payouts batch to a subcontractor.
- Two Muse agents play the whole deal over MCP with no human scripting — the seller agent sends the wrong photo, reads the Verifier's reasoning and corrects itself.
- Judges can run the full demo with no keys at all: a clean clone replays every model answer and labels it as replayed.
- Every AI decision is explained, appealable and sealed in a verifiable hash chain.
- Agents can use the whole system through MCP, and a dashboard agent can explain any decision from the evidence.
- One chat question travels through three agents (PACT Auditor → PACT Sentinel → Studio's Widget agent) and leaves a pinned finding and a new chart on the dashboard.

## What we learned
Trust is a product feature you can engineer: limits set by humans, decisions made by software, explanations for both sides, and a log nobody can quietly rewrite.

## What's next
- Live verification of more evidence types (code: run the deliverable's tests in a sandbox).
- Arbiter decisions weighted into reputation; identity verification for parties.
- Production PayPal onboarding for marketplaces (multi-party payments) and more currencies.

## Built with
TypeScript · Node.js · Next.js · React · Fastify · PayPal REST APIs (Orders v2, Payments v2, Payouts, Webhooks, Transaction Search, Reporting) · PayPal JS SDK · Meta Model API (Muse Spark) · AG Studio (Agent Framework, custom widgets, theming) · AG Grid · Model Context Protocol · XState · Zod · SQLite · Drizzle ORM · Tailwind CSS · Motion · Vitest · Playwright · GitHub Actions

## Tools used (what each AI model and service does)
- **Meta Muse Spark (`muse-spark-1.3`) via the Meta Model API** — runtime AI: parses natural-language deals into contracts, describes and verifies evidence (images and text), arbitrates disputes, powers the buyer and seller demo agents, drives the PACT Auditor agent inside AG Studio and writes the PACT Sentinel's briefings (the Sentinel's findings themselves come from deterministic rules).
- **PayPal developer platform (sandbox)** — holds and moves the money: order authorization, partial/final captures, voids, reauthorization, refunds, Payouts, webhooks, Transaction Search and balances.
- **AG Studio** — the Control Tower dashboard: theme, layout, custom widgets and the Agent Framework (a custom LLM agent and a custom rules-engine agent, both delegating to Studio's built-in agents).
- **Claude Code** — used as a development tool to write the code. It is not used at runtime; no Anthropic API is called by PACT.

## What is real and what is simulated
- Payments run against the **real PayPal sandbox** when sandbox credentials are configured. Without them, a **simulated adapter** stands in; it is labelled "SIMULATED" in the UI, the API responses and the docs, and is never presented as PayPal. The seeded demo history uses the simulated adapter.
- The demo video uses **recorded Muse answers** (replay mode) for determinism; the recordings were produced by live Muse calls against our own photos, and the UI labels replayed answers ("Replay mode: recorded model responses").
- Webhooks need a public URL; on localhost PACT uses its reconciliation poller instead (both paths are implemented).
- Evidence images in the repository are generated, brand-free placeholders or our own photos of plain objects.
