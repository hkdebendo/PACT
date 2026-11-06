# HUMAN_TODO — things only Vincent can do

Never paste secrets into the chat. Put them in `.env.local` at the repo root (copy `.env.example`).

## Blocking now: network speed

Measured 2026-11-06 ~18:30: **~4 KB/s** to registry.npmjs.org (a 10 MB package took 8 minutes). The full
`npm install` (Next.js + its SWC binary + AG Studio + TypeScript ≈ 150–200 MB) is running in the background
but may take hours at this speed. If you can, switch to a faster connection (fibre / another Wi-Fi) and tell
me — I will restart the install. Until it finishes I write code but cannot run tests, lint or the app.

## Blocking now (credentials)

Status checked 2026-11-06 19:15: `.env.local` present; everything set except the two optional ones below.

| Variable | Needed for | Status |
|---|---|---|
| `PAYPAL_CLIENT_ID` | all real sandbox calls (Tier 1) | ✅ set |
| `PAYPAL_CLIENT_SECRET` | all real sandbox calls (Tier 1) | ✅ set |
| `DEMO_BUYER_EMAIL` | Playwright sandbox approval (demo + e2e) | ✅ set |
| `DEMO_BUYER_PASSWORD` | Playwright sandbox approval (demo + e2e) | ✅ set |
| `META_API_KEY` | live Muse calls; recording the replay cache (Tier 2) | ✅ set |
| `AG_STUDIO_LICENSE_KEY` | watermark-free Studio dashboard (Tier 3) | ✅ set |
| `AGENT_API_KEYS` | optional — you invent them: `buyer-agent:<guid>,seller-agent:<guid>` (PowerShell `[guid]::NewGuid()`); empty = local demo keys | not set (fine) |
| `PAYPAL_WEBHOOK_ID` | optional, only with a public tunnel URL (developer dashboard → app → Webhooks → Add webhook → copy the ID) | not set (fine: poller) |

Steps:
1. `copy .env.example .env.local` (Windows) and fill in the values.
2. Tell me "env filled" — I will re-check which values are set (never their content).

## PayPal developer dashboard (sandbox app settings)

- [x] **Transaction search** works on the sandbox app (verified 2026-11-06).
- [x] Payouts scope present on the token (verified 2026-11-06); a real payout run is still to be tested.
- The sandbox **business** account is the seller/merchant behind the REST app: not needed in `.env.local`; use it to log in to sandbox.paypal.com during the video to show captures arriving.

## Assets

- [ ] Two photos of a plain object with **no brand or logo** (e.g. a stack of plain white t-shirts): one conforming to the deal, one wrong item. Save them as `fixtures/evidence/order_conforming.jpg` and `fixtures/evidence/order_wrong_item.jpg` (they replace generated placeholders).

## Submission (do not do before the end)

- [ ] Record the demo video with OBS (< 3 min) following `docs/DEMO_SCRIPT.md`, upload to YouTube as **public**, no copyrighted music.
- [ ] Paste `docs/DEVPOST_SUBMISSION.md` into the Devpost form, add the repo URL and video link, submit **before 2026-11-12 12:00 PM PT (21:00 Cotonou)** — aim for the morning of 12 Nov.
- [ ] On GitHub, check the About section shows the MIT licence.
