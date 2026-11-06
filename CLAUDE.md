# PACT — rules for Claude Code sessions

Source of truth for scope: `PACT_BRIEF.md`. Current state: `PROGRESS.md`. Human blockers: `HUMAN_TODO.md`.
On resume: read `PROGRESS.md`, run `npm test`, continue at the first unchecked item.

## Hard rules
- Runtime AI = **Meta Muse via the Meta Model API** (OpenAI-compatible, `https://api.meta.ai/v1`). Never use the Anthropic API/SDK at runtime.
- **Zero spending**, **no Docker**, SQLite only, in-process jobs. `npm install && npm run dev` must work.
- **Secrets** live only in `.env.local` (git-ignored). Never print or commit them. Check env with `npm run env:check` (prints set / not set only). Run `npm run secret-scan` before every commit.
- Everything public in **English**. No third-party logos/trademarks in UI, fixtures, demo.
- Simulated behaviour must be **labelled** in code (`SIMULATED` comments), UI badges and README. Never present it as real PayPal behaviour.
- Never claim something works without running it. Update `PROGRESS.md` after each work batch; commit often.

## Layout
```
apps/web        Next.js 16 (from the PayPal + AG Studio boilerplate) — landing, pact UI, AG Studio "Control Tower"
apps/api        Fastify — REST, SSE, webhooks, MCP server (Streamable HTTP)
packages/core   Zod schemas, XState pact machine, reputation, audit hash chain
packages/db     SQLite (better-sqlite3) + Drizzle, migrations, repositories
packages/paypal PayPal sandbox client + labelled simulated adapter
packages/llm    Muse client, prompts, replay cache (LLM_MODE=live|replay)
packages/agents buyer/seller demo agents (Muse tool loop over MCP)
fixtures/       evidence files + recorded LLM responses (llm-cache/)
docs/           ARCHITECTURE, REPUTATION, SANDBOX_LIMITATIONS, MCP, DEMO_SCRIPT, DEVPOST_SUBMISSION
e2e/            Playwright
```

## Commands
- `npm run dev` — api (:4000) + web (:3000)
- `npm test` — Vitest across workspaces
- `npm run lint`, `npm run build`, `npm run typecheck`
- `npm run db:migrate`, `npm run seed`, `npm run demo`
- `npm run env:check`, `npm run secret-scan`

## Notes
- Next.js 16 has breaking changes: read `apps/web/node_modules/next/dist/docs/` before writing Next code (see `apps/web/AGENTS.md`).
- AG Studio 3.0.0: the AI adapter speaks the OpenAI **Responses** format; the web proxy route forwards to Meta's `/v1/responses`.
