# Demo script — target 2:45 (hard limit 3:00)

Recorded on a desktop browser (1920×1080, browser zoom 110%), OBS, no music with copyright (silence or a royalty-free track you own the rights to). No third-party logos on screen: close other tabs and bookmarks bar.

## Before recording

```bash
npm install
npm run seed -- --reset      # a few weeks of labelled, simulated history for the leaderboard
npm run dev                  # API :4000 + web :3000 (keep this terminal visible for shot 2)
```

`.env.local` for the recording: real sandbox credentials (`PAYPAL_ENV=sandbox`), `LLM_MODE=replay` (deterministic: recorded Muse answers), `AG_STUDIO_LICENSE_KEY` set (no watermark). Open three tabs: `http://localhost:3000`, a second terminal ready with `npm run demo -- --headed`, and the PayPal sandbox merchant dashboard (Activity) already logged in.

Do one full dry run first: `npm run demo` must print `Main pact …: completed` and `Audit chain: verified`.

## Shot list

| Time | Screen | Action | Voice-over (suggested) |
|---|---|---|---|
| 0:00–0:15 | Landing page | Slow scroll on the hero and the pact receipt | "When an AI agent pays another agent, or a small seller online, it pays blind. PACT puts a programmable third party in the middle: PayPal holds the money, AI checks the evidence, and funds move milestone by milestone." |
| 0:15–0:35 | Terminal | `npm run demo -- --headed`; buyer and seller agents start talking over MCP | "Two agents, both running on Meta's Muse, negotiate over PACT's MCP server. The buyer states the deal in plain words: fifty embroidered t-shirts, thirty percent at production, seventy at delivery." |
| 0:35–0:50 | Browser: pact room | Open the new pact; show parsed milestones and criteria | "Muse's Contract Parser turns it into a contract with checkable criteria." |
| 0:50–1:05 | PayPal sandbox checkout (Playwright, headed) → pact room | Sandbox approval happens; Escrow bar turns amber | "The human approves once in PayPal. That's an authorization: the money is held, not charged — and it's the spending cap for every agent." |
| 1:05–1:35 | Control Tower, Overview | Wrong photo arrives: Verdict Card shows *rejected* with reasoning; Milestone Timeline shows ✗ | "The seller's agent sends the wrong photo — mugs. The Verifier first describes the image without knowing what it should prove, then judges it against each criterion. Rejected, with reasons." |
| 1:35–1:55 | Control Tower chat (PACT Auditor) | Click the starter "Why was milestone 2 refused?"; the agent explains; a *Refused milestones* widget appears on the page | "Our PACT Auditor is a custom agent in AG Studio's Agent Framework. It explains the decision from the evidence and delegates to Studio's own agents to build the view — live." |
| 1:55–2:15 | Control Tower → PayPal sandbox Activity | Correct photo approved → 30% partial capture; Escrow Vault moves; show the capture in the sandbox | "The right photo is approved, and PACT captures thirty percent from the authorization. That's a real sandbox capture." |
| 2:15–2:30 | Control Tower | Tracking verified → final capture; Money Flow Sankey and Reputation update | "Tracking confirms delivery: final capture, the rest released, reputation updated." |
| 2:30–2:40 | Pact room of the dispute variant | Arbiter decision *partial*, "Appeal to a human" button, chain verified badge | "Disputes go to an AI Arbiter that cites evidence — and any decision can be appealed to a human. Every step is in a SHA-256 hash chain." |
| 2:40–2:45 | Landing hero | — | "PACT: where AI agents sign deals and PayPal enforces them." |

## Exact commands

```bash
npm run demo -- --headed     # agents + Playwright sandbox approval in a visible browser
npm run demo -- --no-agents  # same story driven over REST (fallback if an agent run diverges)
npm run demo -- --no-dispute # skip the dispute variant
```

## If something goes wrong on camera

- "Replay mode: no recorded Muse answer": the input changed (e.g. a fixture photo was replaced). Re-record once with `LLM_MODE=live` and a Meta key, then switch back to replay.
- PayPal sandbox checkout layout changed: run with `--headed` and click through manually; the demo waits for the approval.
- Reset everything: stop `npm run dev`, `npm run seed -- --reset`, start again.
