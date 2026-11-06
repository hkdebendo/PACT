# PROGRESS

Deadline: **2026-11-12 12:00 PT (21:00 Cotonou)**. Started 2026-11-06.

## Environment (detected 2026-11-06)
- OS: Windows 11 Home 10.0.26300 (x64), shells: PowerShell 5.1 + Git Bash
- Node v24.16.0, npm 11.13.0, git 2.54, gh 2.101 (logged in as `hkdebendo`)
- Repo: https://github.com/hkdebendo/PACT (public, MIT LICENSE already present)
- Network is slow: large clones/installs can take several minutes.
- `.env.local`: **missing** → all credentials not set (see HUMAN_TODO.md).

## Verified facts (external)
- Meta Model API: base `https://api.meta.ai/v1`; endpoints `/chat/completions`, `/responses`; models `muse-spark-1.3` (text+image+video+PDF, tools, structured output), `muse-spark-1.1`. `reasoning_effort` ∈ minimal|low|medium|high|xhigh. Images: Chat `image_url` (data URL ok), Responses `input_image`. Structured output: Chat `response_format.json_schema`, Responses `text.format`; strict subset = root object, `additionalProperties:false`, all props required, no oneOf/allOf. Pricing $1.25 in / $4.25 out per 1M. Sources: dev.meta.ai blog + docs, promptfoo docs. *Not yet verified live (no key).*
- Boilerplate (`paypaldev/hackathon-paypal-ag-grid-boilerplate`): Next 16.3.6, React 19.2.8, ag-studio 3.0.0, ag-grid 36.2.0. Studio is fully wired: `AgStudioProvider licenseKey`, `createAiHarness` + `openaiAdapter` (OpenAI Responses format, streamed) through a server proxy `/api/ai/responses`, custom theme via `studioTheme.withParams`, data sources + relationships in `studio/data.ts`. PayPal via plain `fetch` (no SDK) in `lib/paypal.ts`.

## Tiers
- [ ] **Tier 0 skeleton** — monorepo, SQLite, env handling, README skeleton, CI, boilerplate running
- [ ] Tier 1 core money flow
- [ ] Tier 2 AI core
- [ ] Tier 3 AG Studio dashboard
- [ ] Tier 4 agents + MCP
- [ ] Tier 5 Studio Agent Framework
- [ ] Tier 6 polish + proof

## Log
- 2026-11-06: read brief, detected env, inspected boilerplate, verified Meta API surface, created tracking files.
