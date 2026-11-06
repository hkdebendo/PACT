# PACT — Build Brief for Claude Code

> Programmable trust for the agent economy.
> Tagline: **"Where AI agents sign deals and PayPal enforces them."**

You (Claude Code) are the sole implementer of this project. Read this whole file before acting, then execute it autonomously. The human (Vincent) is not a reviewer of every step: he supplies credentials and demo photos, and records the video. Everything else is your job.

Today is 2026-11-06. **Submission closes 2026-11-12 12:00 PM Pacific Time (21:00 in Cotonou, UTC+1).** There is no scope cut: build the full scope below. Work in priority tiers (section 13) so that something demoable exists at every point in time.

---

## 1. Mission and success criteria

Build **PACT**: an escrow-style platform in which AI agents (or humans) agree on a deal written in natural language, PayPal holds the money, an AI verifier checks real evidence (photos, documents, code, tracking), and funds are released milestone by milestone, partially or fully, or returned. Every AI decision is explained and auditable, and any agent can use the system through an MCP server.

Hackathon: **PayPal AI Hackathon, "Build What's Next with PayPal and AI"** (Devpost). The project must integrate the PayPal developer platform (free sandbox) AND AI in a significant, non-trivial way.

**Primary prize target: "Best Use of AG Grid" (sponsor prize).** The AG Grid prize judges both how the dashboard looks and how it is built: polished custom widgets, theme and layout tooling (not just AG Grid or AG Charts on their own), and the **AG Studio Agent Framework** (a custom agent talking to Studio's built-in agents, or a swapped/custom harness). Only one sponsor prize can be won, so we aim only at AG Grid. Do not spend effort on other sponsors' tools (Render, Astropods, Kernel, Elastic, Postman, Zapier, Channel3, Bryntum). A Postman collection and an OpenAPI spec are cheap and welcome, but they require no sponsor account.

**Also aim for the global prizes** through quality: Best Use of Agentic Commerce, Best Use of PayPal + AI, Most Impactful, Best Demo Delivery, and the Grand Prizes. The judging criteria are equally weighted:
1. Technological Implementation: thorough, skilled, non-trivial use of PayPal and AI.
2. Design: a complete, coherent product experience, not a proof of concept.
3. Potential Impact: a credible, specific real problem for a real audience.
4. Innovation / Idea.
5. Presentation: a video showing the project working end to end, with a clear pitch.

---

## 2. Hard constraints (read twice)

1. **Zero spending.** No paid service, no paid plan. Use only: PayPal sandbox, Meta Model API credits Vincent already holds, AG Studio 45-day free trial licence, open-source libraries, GitHub (public repo), YouTube.
2. **No Docker.** Vincent has no Docker. The judges must be able to run the project with `npm install` then `npm run dev` (plus a `.env.local` they fill in). No Postgres, no Redis: use **SQLite** and in-process job handling.
3. **AI runtime = Meta Muse via the Meta Model API.** Do NOT use the Anthropic API, the Anthropic SDK or the Claude Agent SDK at runtime. Claude Code is only the builder. Use an OpenAI-compatible client pointed at Meta's endpoint (Meta documents OpenAI-compatible and Anthropic-compatible request formats; use the OpenAI-compatible one). Model id to try first: `muse-spark-1.3` (verify in Meta's docs; read the id and base URL from env, never hardcode).
4. **Secrets never enter the repo or the chat.** Keys live only in `.env.local` (git-ignored). Ship `.env.example` with empty values and comments. Never print secrets in logs. If you need a value that is not set, stop that task, write exactly which variable is missing into `HUMAN_TODO.md`, and continue with something else. Never ask Vincent to paste secrets into the conversation.
5. **Everything public is in English**: code comments, UI, README, docs, the demo, the Devpost text. (Vincent's UI chat with you may be in French.)
6. **Open source**: MIT `LICENSE` at the repo root, detectable by GitHub in the About section.
7. **No third-party trademarks, logos or copyrighted media** in the demo, the UI, the fixtures or the video (hackathon rule). Use neutral objects and generic names. PayPal's own name and PayPal's official checkout button are fine; do not use PayPal's logo as your own branding.
8. **Be honest about limits.** The PayPal sandbox does not reproduce every real-world behavior. Wherever you use a simulated adapter instead of a real sandbox call, label it clearly in the code, in the UI and in the README. Never present simulated behavior as real PayPal behavior.
9. **Claude Pro rate limits apply to you.** Work in efficient batches, commit often with clear messages, and keep `PROGRESS.md` up to date, so that a session cut-off can be resumed without loss (section 13).

---

## 3. Environment and credentials

Vincent has already done: the AG Studio trial licence request, a PayPal Developer sandbox app (Client ID and Secret) with two sandbox accounts (one buyer, one seller), checked his Meta API credit and model name, and created an empty public GitHub repo. He will put values in `.env.local`.

Define and document these variables in `.env.example` (names are suggestions; keep them consistent everywhere):

```
# PayPal (sandbox only)
PAYPAL_ENV=sandbox
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
PAYPAL_WEBHOOK_ID=            # optional; webhooks need a public URL (see section 6)
DEMO_BUYER_EMAIL=             # sandbox test buyer, used only by the demo automation
DEMO_BUYER_PASSWORD=          # sandbox test buyer, never a real account

# AI (Meta Model API, Muse)
META_API_KEY=
META_BASE_URL=                # read from Meta Model API docs
MUSE_MODEL=muse-spark-1.3     # verify
LLM_MODE=live                 # live | replay (see section 7)

# AG Studio
AG_STUDIO_LICENSE_KEY=        # 45-day trial; see the "Installing a Licence Key" docs page

# App
APP_BASE_URL=http://localhost:3000
DATABASE_URL=file:./data/pact.db
AGENT_API_KEYS=               # comma-separated keys for the MCP server demo agents
```

On first run, **detect the OS and Node version** and report them in `PROGRESS.md`. Node 20.9+ is required by the starter boilerplate. Choose a SQLite driver that installs from prebuilt binaries on Windows, macOS and Linux without a C++ toolchain (check `better-sqlite3` or a libsql file client; verify the install works on this machine before committing to it).

---

## 4. The product: full feature scope

### 4.1 The problem
Agent-to-agent and online commerce lacks a programmable third party of trust. An agent that pays another agent, a freelancer or a WhatsApp seller pays blind. In emerging markets, the "I paid and received nothing" scam blocks small sellers and freelancers from online commerce. PACT makes the trust enforceable by software, with an explanation for every decision.

### 4.2 The flow
1. **Natural-language contract.** Example: *"I want 50 embroidered t-shirts delivered before Friday, 30% at production, 70% at delivery."* A Muse **Contract Parser** turns it into a structured contract (Zod-validated): parties, currency, total, deadline, milestones with `id, title, percent, verifiable criteria, accepted evidence types (photo | document | code | tracking), deadline`, and a dispute policy.
2. **Funds secured by PayPal.** Orders API v2 with `intent: AUTHORIZE` blocks the funds without charging the buyer. Validity is up to 29 days, with a shorter honor period; a re-authorization job handles expiry.
3. **Multimodal Verifier agent.** The seller submits evidence (product photo, tracking page, code deliverable, document). Muse checks conformity against each milestone's criteria and returns a structured verdict `{status: approved | rejected | needs_more, confidence, per-criterion results, reasoning}`.
4. **Programmable release.** Approved milestone → partial capture of that milestone's share. Final failure or cancellation → void the remaining authorization. A resolved dispute in the buyer's favor → refund of what was captured. **Payouts** can pay subcontractors.
5. **Transparent AI Arbiter.** On dispute, the Arbiter reads the contract, the evidence and the verifier history and issues a motivated decision (release / partial / refund), with a **human appeal** path.
6. **MCP server (+ PayPal Agent Toolkit).** Any agent (Claude, ChatGPT, a custom one) can call `create_pact`, `fund_pact`, `submit_evidence`, `verify_milestone`, `release_funds`, `open_dispute`, `get_reputation`. This is what makes it agentic commerce rather than just an app.
7. **Reputation score.** Every executed pact feeds a reliability history (completion rate, on-time rate, dispute rate, refund rate, with Bayesian smoothing so new accounts are not over- or under-rated). Document the formula in `docs/REPUTATION.md`.
8. **Auditability.** Append-only, **hash-chained audit log** of every state change and every AI decision (hash = sha256 of previous hash + canonical JSON of the entry), with a verification endpoint and a UI badge "chain verified".
9. **Real-time dashboard** fed by Server-Sent Events.

### 4.3 State machine (XState)
`draft → proposed → funded → in_progress → evidence_submitted → (approved → released) | (rejected → in_progress) | disputed → resolved(release | partial | refund) → closed`, with `cancelled` and `expired`. Model per-milestone state inside the pact machine. Guard every transition; invalid transitions must fail loudly and be audit-logged.

---

## 5. Architecture and stack (zero-cost variant)

Language: **TypeScript end to end.** Suggested structure (adapt if justified, keep one-command startup):

```
pact/
  apps/web/            Next.js (start from the PayPal + AG Studio boilerplate): landing, pact UI, AG Studio dashboard
  apps/api/            Fastify: core API, webhooks, SSE, MCP server (Streamable HTTP), agent endpoints
  packages/core/       domain logic: state machine, pact schema (Zod), reputation, audit chain
  packages/paypal/     PayPal adapter (real sandbox client + clearly-labelled recorded/simulated adapter)
  packages/llm/        LLM client (Muse), prompts, schemas, replay cache
  packages/agents/     two demo agents (buyer, seller) driven by Muse + MCP client
  fixtures/            evidence files, recorded LLM responses
  docs/                ARCHITECTURE.md, REPUTATION.md, SANDBOX_LIMITATIONS.md, DEMO_SCRIPT.md, DEVPOST_SUBMISSION.md
  e2e/                 Playwright tests of the demo scenario
```

Use npm workspaces, and a root script so that `npm run dev` starts web + api together (for example with `concurrently`). Everything else:

- **DB**: SQLite + Drizzle ORM (or equivalent) with migrations and a `seed` script. The file lives in `./data/` (git-ignored).
- **Jobs**: an in-process scheduler plus a `jobs` table (re-authorization before expiry, async verification, webhook retries, reconciliation polling). No Redis.
- **State machine**: XState. **Validation**: Zod everywhere; generate **OpenAPI 3.1** from the Zod schemas and commit it.
- **Realtime**: Server-Sent Events.
- **Evidence storage**: local disk under `./data/evidence/` with sha256 content hashes, mime/size limits and basic sanitization.
- **Idempotency**: idempotency keys on every PayPal write (`PayPal-Request-Id`) and on every API mutation.
- **UI**: Next.js + Tailwind + shadcn/ui for the non-Studio parts. Framer Motion for the milestone animations. The dashboard itself is AG Studio (section 9).
- **Tests**: Vitest (unit: state machine, audit chain, reputation, schemas, adapters), Playwright (end-to-end demo scenario). **CI**: GitHub Actions. ESLint + Prettier.
- Provide a Postman collection generated from the OpenAPI spec (optional, low effort).

---

## 6. PayPal integration (the heart of the project)

Use the official **PayPal TypeScript Server SDK** (`@paypal/paypal-server-sdk`, as the boilerplate does) where it covers the endpoint, and direct REST calls where it does not. Verify every endpoint and field in PayPal's current docs and in the sandbox before relying on it.

Required real-sandbox integrations:
- **OAuth2** client-credentials, token caching.
- **Orders v2** with `intent: AUTHORIZE`; create order, buyer approval, authorize.
- **Payments v2 authorizations**: capture (partial with `final_capture: false`, final with `final_capture: true`), **void**, **reauthorize**; **refunds** on captures. Verify in the sandbox that multiple partial captures against one authorization work as expected, and record the exact behavior in `docs/SANDBOX_LIMITATIONS.md`.
- **Payouts** (batch payouts to subcontractors). If the sandbox app does not have Payouts enabled, tell Vincent through `HUMAN_TODO.md` and implement it behind the same interface with a clearly labelled simulated adapter until it works.
- **Webhooks** with **signature verification** (`PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.CAPTURE.REFUNDED`, and payout events). PayPal cannot reach localhost, so also build a **reconciliation poller** that works without a public URL, and test the webhook handler with recorded payloads and PayPal's webhook simulator. Document both paths.
- **PayPal JS SDK** buttons for the buyer's approval step in the UI.
- **PayPal Agent Toolkit** (`@paypal/agent-toolkit`) and PayPal's MCP server: evaluate them honestly and use them where they add real value (for example exposing PayPal read actions to agents alongside the PACT tools). Verify the actual package names and capabilities first; if something does not exist or does not fit, say so in `docs/ARCHITECTURE.md` instead of faking it.
- **Transaction Search + balances** (as in the boilerplate) for a "PayPal reconciliation" view. Known limits: at most a 31-day range, and new activity can take up to ~3 hours to appear. Therefore **the live dashboard reads PACT's own ledger**, and the PayPal-side data is used for reconciliation and for preloaded demo data. The sandbox app needs the Transaction Search feature enabled.

**Buyer approval problem.** An Orders `AUTHORIZE` flow needs the buyer to approve in PayPal checkout; an autonomous agent cannot do that by itself. Design it explicitly: `fund_pact` returns an approval URL/status; the human buyer approves once through the PayPal JS SDK in the sandbox; for the demo and the e2e tests, write a Playwright script that completes the sandbox buyer approval using `DEMO_BUYER_EMAIL` and `DEMO_BUYER_PASSWORD` from `.env.local` (sandbox test account only). Explain this honestly in the README: autonomous agents operate within a human-approved authorization, which is also a feature (a spending cap the human sets).

**Idempotency, retries, error handling**: every PayPal call has an idempotency key, bounded retries with backoff on 5xx/429, and typed errors surfaced in the UI and the audit log.

---

## 7. AI layer (Meta Muse)

Create `packages/llm` with a provider-agnostic `LLMClient` (OpenAI-compatible HTTP), configured only from env. Muse (per Meta's docs) supports structured outputs, tool calls (including parallel), image input, adjustable reasoning effort and prompt caching. Verify the exact request shape, the reasoning-effort parameter and the image input format in Meta's docs before coding the client.

Roles (each with its own prompt, Zod output schema and tests):
1. **Contract Parser**: natural language → contract JSON. Reject ambiguous input with specific clarification questions instead of guessing.
2. **Verifier** (the riskiest part, since Muse trails the best models on some visual-reasoning benchmarks): use a **two-step** procedure. Step 1, describe the evidence factually (what is visible: counts, objects, text, dates), without seeing the criteria. Step 2, compare that description against the milestone criteria with a strict JSON schema, returning per-criterion pass/fail, confidence and reasoning. Add deterministic pre-checks (file type, size, hash not reused from another pact, deadline, required fields). Low confidence → `needs_more`, never a silent approval.
3. **Arbiter**: reads contract, verifier history, evidence descriptions and both parties' statements; returns a decision (release / partial with amount / refund), reasoning, cited evidence and a confidence; always allows a human appeal.
4. **Agents** (buyer/seller demo agents, section 8): a plain tool-calling loop over the MCP client. No agent SDK dependency.
5. **Studio agent** (section 9): the AG Studio custom agent uses Muse through the Studio adapter.

**Replay cache (critical for the judges).** Add `LLM_MODE=live|replay`. In `live`, every call is recorded to `fixtures/llm-cache/` keyed by a hash of (model, prompt, input, image hashes). In `replay`, calls are served from the cache; unknown inputs fail with a clear message telling the user to supply their own `META_API_KEY`. Commit the cache for the demo scenario, so (a) the video is deterministic and (b) judges without a Meta key can still run the demo scenario. Label replay mode clearly in the UI ("Replay mode: recorded model responses"). Never use replay silently.

Track token usage per call and show a cost counter in the admin view (so Vincent can watch his Meta credit).

---

## 8. MCP server and demo agents

- `@modelcontextprotocol/sdk`, **Streamable HTTP** transport (also support stdio if cheap), per-agent API keys from `AGENT_API_KEYS`, rate limiting, input validation, audit-logged calls.
- Tools: `create_pact`, `fund_pact`, `submit_evidence`, `verify_milestone`, `release_funds`, `open_dispute`, `get_reputation`, plus read tools (`get_pact`, `list_pacts`). Each tool has a precise description and Zod schema, and returns structured results with next-step hints.
- Include a short guide `docs/MCP.md` showing how to connect an external agent client.
- **Two demo agents** (Buyer agent, Seller agent) built on Muse + the MCP client. They negotiate and execute the scenario in section 10 without human scripting, with a fixed seed/replay for reproducibility.

---

## 9. AG Studio dashboard (the prize target; spend your best effort here)

Goal: show **polish and craft**: custom widgets, theme and layout tooling, and the Studio Agent Framework used in a non-trivial way.

**Setup**
- Start from the official starter: `https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate` (Next.js, `lib/paypal.ts`, `app/data-table.tsx`, pages `/transactions`, `/subscriptions`, `/balances`; it has `AGENTS.md` and `CLAUDE.md`, read them). The README does not clearly show Studio wiring: inspect the code and see what is actually configured.
- Read these docs BEFORE writing dashboard code (fetch them; do not rely on memory):
  - Quick start: https://www.ag-grid.com/studio/react/quick-start/
  - Installing a licence key: https://www.ag-grid.com/studio/react/licence-install/ and enterprise licence: https://www.ag-grid.com/studio/react/enterprise-licence/
  - Custom widgets: https://www.ag-grid.com/studio/react/custom-widgets/ (+ widget-overview, widget-configuration, custom-widgets-form)
  - Theming and Theme Builder: https://www.ag-grid.com/studio/react/theming/ , https://www.ag-grid.com/studio/react/theme-builder/
  - Layout: modes-layout, standalone-layout, responsive-layout (same base path)
  - Live data and data loading: live-data, loading-data, data-modelling, server-side-data (Custom Engine)
  - Drill through, context menu, exporting
  - **Agent Framework**: https://www.ag-grid.com/studio/react/ai/ , ai-quickstart, ai-harness, ai-builtin-harness, ai-direct-llm-runner, ai-client-tool-runner, ai-custom-runner, ai-custom-harness, ai-builtin-agents, ai-custom-agents, ai-context, ai-tools, ai-custom-tools, ai-chat-ui, ai-tool-components, ai-webmcp
  - **AI Skills** page: https://www.ag-grid.com/studio/react/skills/ (may help you generate correct Studio code)
  - Blogs: https://www.ag-grid.com/blog/introducing-the-ag-studio-agent-framework/ and the "Vibecoding a widget" post
- Licence: `AG_STUDIO_LICENSE_KEY` from env, **never committed**. The README must explain how any judge gets the free 45-day trial (https://www.ag-grid.com/studio/react/enterprise-licence/#request-a-45-day-trial-licence). Test and document what happens without a key (watermark or warning) so the project is still viewable.

**The dashboard: "PACT Control Tower"**
Custom widgets (not stock tables only):
1. **Escrow Vault**: held / released / refunded amounts with animated transitions.
2. **Milestone Timeline**: per pact, steps colored by state, evidence thumbnails, verifier confidence.
3. **Verdict Card**: arbiter/verifier decision with reasoning, cited evidence, confidence, "Appeal to a human" action, and the audit-chain "verified" badge.
4. **Reputation Leaderboard**: grid with sparklines/trend.
5. **Money Flow**: a Sankey (buyer → escrow → seller / refund / subcontractor). Check whether the Studio trial covers the AG Charts Enterprise Sankey; if not, build an equivalent with what is available.
6. **Dispute & refund rate** gauges/tiles.
7. **PayPal Reconciliation** grid (Transaction Search + balances) with a clear "as of" timestamp and the 3-hour caveat.

Craft: a custom **PACT theme** made with the Studio theme tooling (light and dark), consistent typography and spacing, responsive layout, empty/loading/error states, keyboard accessibility, drill-through from a grid row into a pact's timeline, export where cheap. Live data via the realtime feed (SSE) into Studio's live-data mechanism.

**Agent Framework (the differentiator)**
- Build a custom agent **"PACT Auditor"**, registered in the Studio harness (`createAiHarness`, with a primary agent and delegates), that **delegates to Studio's built-in agents** (data and widget agents) via the delegate mechanism, and has custom tools such as `get_verdict`, `list_refused_milestones`, `explain_decision`, `open_pact_drilldown` implemented against PACT's API.
- Drive it with Muse via a **direct LLM runner + adapter** (the docs say the adapter is how you bring a model; verify the adapter interface and stream events). Names seen in the docs overview and to be verified: `directLlmRunner`, `clientToolRunner`, `createAiHarness`, `tools.delegateTo`, `studio.viewSchema()`, `studio.executeQuery()`, `studio.addWidget()`, `studio.configureWidget()`.
- Stretch (do it if the base works): a **custom harness or custom runner** variant, to hit the "swapped harness" idea, plus passing PACT context through the agent-context mechanism.
- Demo moment: right after the Arbiter refuses a wrong photo, the user types in the Studio chat *"Why was milestone 2 refused? Show all refused milestones this week."* The agent explains, and a new widget appears live.

Quality bar for this section: it must look like a product, not a demo. Use the `frontend-design` skill guidance if available (distinctive, intentional choices, not templated defaults).

---

## 10. Demo scenario and fixtures (deterministic)

Video must be **under 3 minutes**, shot on the device it was built for (a desktop browser), uploaded by Vincent to YouTube as public, without third-party trademarks or copyrighted music. Provide `docs/DEMO_SCRIPT.md` with a timed shot list (target 2:45) and exact commands.

Scenario (`npm run demo` seeds the data and replays what is needed):
1. Buyer agent states the deal in natural language → Contract Parser → structured pact with milestones (30% production, 70% delivery) shown on screen.
2. Buyer authorizes (PayPal sandbox approval) → funds held; the Escrow Vault widget shows it.
3. Seller agent submits a **wrong photo** (a different product) → Verifier rejects with an explanation → Verdict Card + Studio chat moment (section 9).
4. Seller submits the **correct photo** → approved → **partial capture** (30%) → balance moves in the sandbox, visible on screen.
5. Delivery milestone with tracking evidence → final capture (70%) → reputation updates → Money Flow Sankey updates.
6. Short dispute variant: a contested milestone → Arbiter decision with reasoning → refund/void, with the human-appeal button visible.
7. Close with a one-line pitch: the problem solved, who it is for, why it matters.

Fixtures in `fixtures/evidence/`: `order_conforming.jpg`, `order_wrong_item.jpg`, `tracking_valid.png`, etc. They must contain no logos or brands. Vincent will provide real photos of a plain object (one conforming, one not); until then, generate neutral placeholder images with a script and log in `HUMAN_TODO.md` that he should replace them. Record the live LLM responses for these fixtures into `fixtures/llm-cache/` once they pass reliably.

---

## 11. Deliverables and repo hygiene

- Public repo with MIT `LICENSE`, a polished English `README.md` (what/why, screenshots or GIFs, architecture diagram, quick start, **judge quick-start**, env table, how to get each credential, sandbox limits, troubleshooting). Include a "How judges can run this in 5 minutes" section covering the sandbox app creation, the AG Studio trial key, the `replay` mode, and what works without a Meta key.
- `docs/ARCHITECTURE.md`, `docs/REPUTATION.md`, `docs/SANDBOX_LIMITATIONS.md`, `docs/MCP.md`, `docs/DEMO_SCRIPT.md`.
- `docs/DEVPOST_SUBMISSION.md` with ready-to-paste English text for the Devpost form: tagline (use the one at the top), project description (inspiration, what it does, how we built it, challenges, accomplishments, what's next), "Built with", the **tools list** (which AI models and services were used and how: Meta Muse Spark via the Meta Model API for parsing/verification/arbitration and the Studio agent; PayPal sandbox APIs; AG Studio; Claude Code used as a development tool), and an honest "what is simulated vs real" note.
- `.env.example`, `.gitignore` (covers `.env*`, `data/`, `node_modules`, build output), `CLAUDE.md` (short project rules and commands, for future sessions), `PROGRESS.md`, `HUMAN_TODO.md`.
- Run a secret scan before every commit (for example a simple grep for the env var values and common key patterns); never commit keys, tokens, the sandbox buyer password or the AG licence key.

---

## 12. Quality and honesty requirements

- `npm run lint`, `npm run build`, `npm test` and the Playwright demo scenario must pass before you declare a tier complete. Run them yourself.
- Verify behavior against the real sandbox and the real Meta API, not only against mocks. Mocks are for unit tests only.
- Never claim something works without having run it. If something cannot be verified (for example because a credential is missing), say so in `PROGRESS.md`.
- Prefer a smaller feature that works end to end over a larger one that is half-wired, but within the stated full scope, finish everything eventually.

---

## 13. Work plan and autonomy protocol

**First 15 minutes**
1. Read this file. Create `PROGRESS.md`, `HUMAN_TODO.md` and a short `CLAUDE.md` (rules and commands, so that a future session restarts correctly).
2. Detect OS/Node; clone or scaffold from the boilerplate; confirm `npm install` and `npm run dev` work; read the boilerplate's `AGENTS.md`/`CLAUDE.md` and `app/data-table.tsx`.
3. Check which credentials exist in `.env.local` without printing their values (only "set / not set"). Record gaps in `HUMAN_TODO.md`.

**Tiers (commit after each; each tier ends with a working demo of what exists)**
- **Tier 0, skeleton**: monorepo, SQLite, env handling, MIT licence, README skeleton, CI, boilerplate running.
- **Tier 1, core money flow**: pact schema, state machine, PayPal authorize → partial capture → void/refund against the real sandbox, audit chain, REST API, SSE. Reconciliation poller and webhook handler.
- **Tier 2, AI core**: LLM client, Contract Parser, two-step Verifier, Arbiter, replay cache, tests.
- **Tier 3, AG Studio dashboard**: Studio running with the licence, live data, custom widgets, PACT theme, drill-through.
- **Tier 4, agents and MCP**: MCP server, buyer/seller agents, PayPal Agent Toolkit evaluation/integration, Payouts.
- **Tier 5, Studio Agent Framework**: PACT Auditor with delegation and Muse adapter, chat demo moment; stretch custom harness.
- **Tier 6, polish and proof**: reputation views, appeal flow, OpenAPI + Postman collection, Playwright e2e, demo scripts, README with media, Devpost text, replay cache recorded, final secret scan, clean-clone test (clone to a fresh folder and follow the README exactly).

**When blocked**: do not stop. Write the blocker in `HUMAN_TODO.md`, implement behind a clearly labelled adapter if it is a platform limit, and continue with the next task. Only stop entirely when nothing remains that you can do without a human input.

**Resuming**: if the session is cut off, the next session reads `PROGRESS.md` and `CLAUDE.md`, runs the tests, and continues from the first unfinished item.

---

## 14. Compliance checklist (official rules: verify at the end)

- [ ] Uses the PayPal developer platform (sandbox) in a significant way; uses AI in a significant way.
- [ ] Public repo on GitHub with an open-source licence visible in the About section.
- [ ] Repo contains all source, assets and instructions to run; clear setup and run instructions; test account/sandbox instructions for judges (without committing secrets).
- [ ] Working demo (judges can run it) — not a mockup or static prototype.
- [ ] Text description and tools list written (what each AI model/service does in the project).
- [ ] Demo video under 3 minutes, shows the project working on the target device, public on YouTube, no third-party trademarks or copyrighted music. (Vincent does the recording.)
- [ ] All submission materials in English.
- [ ] The project is original work; third-party SDK/APIs used in line with their terms (PayPal sandbox, Meta Model API, AG Studio trial licence).
- [ ] Project is available free of charge to judges until the end of judging (15 Dec 2026): do not depend on anything that expires before then; note that the AG Studio trial and Meta credits are the user's, and the README explains how judges use their own.

---

## 15. Things I could not verify (you must check them first)

- Meta Model API: base URL, exact model id (`muse-spark-1.3` expected), reasoning-effort parameter, image input format, rate limits, and whether the account's credit covers the planned usage.
- AG Studio: exact API names and signatures of the Agent Framework (listed above are from the docs overview only), the adapter interface for a custom model, how live data is fed, and whether the trial licence includes the AG Charts Enterprise series (Sankey, gauges).
- What the boilerplate actually wires up for Studio.
- PayPal sandbox: whether multiple partial captures per authorization behave as documented, whether Payouts is enabled on the app, the Transaction Search feature, and the behavior of authorization expiry and re-authorization in sandbox.
- PayPal Agent Toolkit and PayPal's MCP server: real package names, capabilities and fit.
- SQLite driver installation on Vincent's machine without compilers.

---

## 16. What only the human can do (keep `HUMAN_TODO.md` updated with these)

- Fill `.env.local` (never paste secrets into the chat).
- Provide two plain-object photos (conforming and non-conforming) without brands or logos, to replace the generated placeholders.
- Record the demo video with OBS (under 3 minutes), upload it to YouTube as public, and paste the link into the Devpost form.
- Paste the text from `docs/DEVPOST_SUBMISSION.md` into the Devpost form, add the repo URL, and submit **before 2026-11-12 12:00 PM PT (21:00 Cotonou)**. Aim to submit the morning of 12 November, not at the last minute.
- Ask AG Grid's team for help on the PayPal Discord if a Studio trial or licence question comes up.
