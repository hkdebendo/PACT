# HUMAN_TODO — things only Vincent can do

Never paste secrets into the chat. Put them in `.env.local` at the repo root (copy `.env.example`).

## Blocking now: network speed

Measured 2026-11-06 ~18:30: **~4 KB/s** to registry.npmjs.org (a 10 MB package took 8 minutes). The full
`npm install` (Next.js + its SWC binary + AG Studio + TypeScript ≈ 150–200 MB) is running in the background
but may take hours at this speed. If you can, switch to a faster connection (fibre / another Wi-Fi) and tell
me — I will restart the install. Until it finishes I write code but cannot run tests, lint or the app.

## Blocking now (credentials)

Status checked 2026-11-06: **`.env.local` does not exist yet → every variable below is "not set".**

| Variable | Needed for | Status |
|---|---|---|
| `PAYPAL_CLIENT_ID` | all real sandbox calls (Tier 1) | not set |
| `PAYPAL_CLIENT_SECRET` | all real sandbox calls (Tier 1) | not set |
| `DEMO_BUYER_EMAIL` | Playwright sandbox approval (demo + e2e) | not set |
| `DEMO_BUYER_PASSWORD` | Playwright sandbox approval (demo + e2e) | not set |
| `META_API_KEY` | live Muse calls; recording the replay cache (Tier 2) | not set |
| `AG_STUDIO_LICENSE_KEY` | watermark-free Studio dashboard (Tier 3) | not set |
| `AGENT_API_KEYS` | MCP demo agents (any random strings, e.g. two UUIDs) | not set |
| `PAYPAL_WEBHOOK_ID` | optional, only with a public URL | not set |

Steps:
1. `copy .env.example .env.local` (Windows) and fill in the values.
2. Tell me "env filled" — I will re-check which values are set (never their content).

## PayPal developer dashboard (sandbox app settings)

- [ ] Enable **Transaction search** on the sandbox REST app (needed for the reconciliation view).
- [ ] Enable **Payouts** on the sandbox REST app (if the option is shown). If it is not available, tell me; a clearly labelled simulated adapter is used instead.

## Assets

- [ ] Two photos of a plain object with **no brand or logo** (e.g. a stack of plain white t-shirts): one conforming to the deal, one wrong item. Save them as `fixtures/evidence/order_conforming.jpg` and `fixtures/evidence/order_wrong_item.jpg` (they replace generated placeholders).

## Submission (do not do before the end)

- [ ] Record the demo video with OBS (< 3 min) following `docs/DEMO_SCRIPT.md`, upload to YouTube as **public**, no copyrighted music.
- [ ] Paste `docs/DEVPOST_SUBMISSION.md` into the Devpost form, add the repo URL and video link, submit **before 2026-11-12 12:00 PM PT (21:00 Cotonou)** — aim for the morning of 12 Nov.
- [ ] On GitHub, check the About section shows the MIT licence.
