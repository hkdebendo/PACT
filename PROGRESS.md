# PROGRESS

Deadline: **2026-11-12 12:00 PT (21:00 Cotonou)**. Started 2026-11-06.

## Environment (detected 2026-11-06)
- OS: Windows 11 Home 10.0.26300 (x64), shells: PowerShell 5.1 + Git Bash
- Node v24.16.0, npm 11.13.0, git 2.54, gh 2.101 (logged in as `hkdebendo`); Chrome + Edge installed (Playwright uses `channel: chrome`, no browser download)
- Repo: https://github.com/hkdebendo/PACT (public, MIT LICENSE)
- **Network ≈ 4 KB/s** to registry.npmjs.org → `npm install` takes hours. better-sqlite3 13 verified to install from bundled prebuilds (no compiler) and run (SQLite 3.53.4).
- `.env.local`: present (2026-11-06 19:15). All set except optional PAYPAL_WEBHOOK_ID and AGENT_API_KEYS (local demo keys used).

## Verified facts (external docs)
- Meta Model API: base `https://api.meta.ai/v1`; `/chat/completions` and `/responses`; `muse-spark-1.3` (text+image+video+PDF, tools, structured output); `reasoning_effort` minimal|low|medium|high|xhigh; images: Chat `image_url` data URL, Responses `input_image`; strict JSON schema subset (root object, additionalProperties false, all props required, no oneOf/allOf); $1.25 in / $4.25 out per 1M. *Not yet verified live (no key).*
- Boilerplate: Next 16.3.6, React 19.2.8, ag-studio 3.0.0, ag-grid 36.2.0; Studio wired with `createAiHarness` + OpenAI Responses adapter via server proxy; PayPal via plain fetch (no SDK).
- AG Studio 3.0.0 docs downloaded (markdown) and used: custom widgets (getSchema/getData/onDataUpdated, cross-filter), Agent Framework (directLlmRunner, defineAiTool, delegateTo, builtIn planning/data/page/widget, getAiContext), theme modes, sync-data reload.
- PayPal Agent Toolkit evaluated (README v1.11.0): no authorize/capture/void/reauthorize tools; heavy deps. Documented as an optional companion MCP server in docs/MCP.md, not bundled.

## Live checks (2026-11-06 ~19:20, scratchpad probe, no deps)
- PayPal sandbox: OAuth 200 (scope includes payouts + reporting); `POST /v2/checkout/orders` intent AUTHORIZE with payment_source → 200 `PAYER_ACTION_REQUIRED` + `payer-action` link; Transaction Search 200 (enabled); balances 200 (USD); payouts endpoint reachable.
- Meta Model API: `muse-spark-1.3` chat completions with strict json_schema → valid JSON; image_url data URL accepted; `/v1/responses` non-streaming with a strict function tool → reasoning + message + function_call items (ids + call_id present); Responses streaming also supported (SSE). reasoning_effort=low still spends ~250 reasoning tokens.
- npm install attempt 2 failed (two concurrent npm processes + ECONNRESET); cache now ~958 MB; attempt 3 running with --prefer-offline.

## Status by tier (2026-11-07 02:30)
Legend: ✅ built and verified by running it · 🟡 partly verified

- ✅ **Tier 0** — install (clean clone verified), 48 tests, lint, typecheck, production build, CI green (lint, types, tests, build, e2e).
- ✅ **Tier 1** — real sandbox verified: AUTHORIZE → buyer approval → 30% partial capture → 70% final capture; partial refund; void on cancel (VOIDED); dispute partial capture with remainder released; Payouts batch SUCCESS; poller/buyer race fixed. 🟡 reauthorization: authorization `49V221249H7518322` created 2026-11-07 01:19 UTC → run `npx tsx scripts/dev/reauth-check.ts reauth 49V221249H7518322` on/after **2026-11-10 02:30 UTC**.
- ✅ **Tier 2** — Muse live with Vincent's photos (wrong item 0.99 rejected, conforming 0.93–0.95 approved, tracking approved, Arbiter partial 60%); replay verified in simulated AND sandbox modes, no misses; clean clone runs with no keys.
- ✅ **Tier 3** — Control Tower: licence, 9 custom widgets, live data, light/dark, drill-through, edit mode, reputation trends.
- ✅ **Tier 4** — MCP agents play the full scenario in the real sandbox and in simulated mode; Payouts verified.
- ✅ **Tier 5** — PACT Auditor (custom agent + delegation + PACT tools) answers the demo question and adds a widget, live and replayed. ⬜ stretch: custom harness/runner variant.
- ✅ **Tier 6** — docs, screenshots in README, OpenAPI/Postman, e2e, Devpost text updated with verified results.

## Remaining
0. **PACT Auditor replay must be re-recorded**: the 2026-11-08 Control Tower redesign changed the page layout and the widget catalogue, which are part of the Auditor's prompts, so the recorded answers in fixtures/llm-cache/studio/ no longer match (live mode is unaffected). Needs one live run of the three prompt starters (a few cents of Muse usage), then a replay check.
1. Reauthorization check on/after 2026-11-10 (see above), record in docs/SANDBOX_LIMITATIONS.md.
2. Stretch: custom runner/harness variant for the PACT Auditor (AG Studio "swapped harness").
3. Vincent: record the video; submit on Devpost. (Rights on order_wrong_item.jpg confirmed 2026-11-08.)

## Log
- 2026-11-08 evening: Control Tower redesign for the AG Grid prize. Custom widgets get real inner padding (Studio's studioWidgetPadding is the gap between cards, not padding) and container-query layouts; new PACT KPI Tile widget (8 metrics, sparkline, 24h delta, metric picker in Studio's edit form); Studio charts used properly (stacked column with legendKey, donuts with legend right + total, button filter); PACT AG Grid theme (aligned padding, centred cells, avatars, sparklines with delta); segmented page tabs with icons; canvas min width 1080 so edit mode scrolls instead of squeezing; AG Grid tooltipField deprecation fixed; mobile nav/act-as/audit header fixed. Typecheck, lint, 48 tests green; screenshots reviewed light/dark/mobile.
- 2026-11-07 01:45–02:30: void + Payouts verified live, party merge + reputation trends, replay verified in both modes, README screenshots, clean-clone test (no keys) passed, .env.example defaults to replay, Devpost text updated, reauth authorization created.
- 2026-11-06 23:00 → 2026-11-07 01:45: real photos, prompt fixes (evidence-checkable criteria, marking location), full real-sandbox scenario by agents, race fix, robust PayPal checkout automation, replay made run-independent (ids/hashes/mode), e2e green, control-tower dynamic.
- 2026-11-06 19:00–21:00: install fixed (cache filled tarball by tarball + offline install), live PayPal/Muse probes, first green test run, real sandbox money flow, Studio + PACT Auditor working with Muse, MCP agents scenario working.
- 2026-11-06 17:30–18:50: brief read, env detected, boilerplate + Studio docs studied, all packages/apps/docs written, two commits pushed. npm install running in background (metadata resolution very slow).
