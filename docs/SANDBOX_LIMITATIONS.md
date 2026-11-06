# PayPal sandbox: what is real, what is simulated, and known limits

PACT talks only to the PayPal **sandbox** (`https://api-m.sandbox.paypal.com`); the sandbox client refuses any other base URL. Nothing here moves real money.

## Two payment modes

| Mode | When | What happens |
|---|---|---|
| `sandbox` | `PAYPAL_ENV=sandbox` and `PAYPAL_CLIENT_ID` + `PAYPAL_CLIENT_SECRET` set | Real REST calls to the PayPal sandbox ([`packages/paypal/src/sandbox.ts`](../packages/paypal/src/sandbox.ts)). |
| `simulated` | `PAYPAL_ENV=simulated`, or sandbox credentials missing | An in-process **SIMULATED** adapter ([`packages/paypal/src/simulated.ts`](../packages/paypal/src/simulated.ts)) that mirrors the documented rules. Every id starts with `SIM-`, every pact records `paymentMode: "simulated"`, and the UI shows a "SIMULATED PayPal" badge on every page. It is never presented as PayPal. |

The `npm run seed` history always uses the simulated adapter and is labelled as such.

## What PACT uses in the sandbox

| Capability | Endpoint | Status |
|---|---|---|
| OAuth2 client credentials, cached token, refresh on 401 | `POST /v1/oauth2/token` | implemented |
| Create order, `intent: AUTHORIZE` | `POST /v2/checkout/orders` | implemented |
| Buyer approval | PayPal checkout (JS SDK buttons or redirect `payer-action` link) | implemented |
| Authorize the approved order | `POST /v2/checkout/orders/{id}/authorize` | implemented |
| Partial capture (`final_capture: false`), final capture (`true`) | `POST /v2/payments/authorizations/{id}/capture` | implemented |
| Void the remaining authorization | `POST /v2/payments/authorizations/{id}/void` | implemented |
| Reauthorize after the honor period | `POST /v2/payments/authorizations/{id}/reauthorize` | implemented (job) |
| Refund a capture (full or partial) | `POST /v2/payments/captures/{id}/refund` | implemented |
| Payouts to subcontractors | `POST /v1/payments/payouts`, `GET /v1/payments/payouts/{id}` | implemented; needs Payouts enabled on the app |
| Webhook signature verification | `POST /v1/notifications/verify-webhook-signature` | implemented; needs a public URL + `PAYPAL_WEBHOOK_ID` |
| Transaction Search, balances | `GET /v1/reporting/transactions`, `GET /v1/reporting/balances` | implemented; needs the "Transaction search" feature |

Every write sends a deterministic `PayPal-Request-Id` (e.g. `pact-<id>-cap-<milestone>-release`), so retries — PACT's own (3 attempts, exponential backoff on 429/5xx, honours `Retry-After`) or a user double-click — cannot capture twice.

## Rules PACT relies on (from PayPal's documentation)

- An authorization is valid for **29 days**; PayPal **honors** the funds for **3 days**. After the honor period a capture may fail if funds are no longer available; a **reauthorization** is allowed once, from day 4 to day 29. PACT schedules a `reauthorize` job one hour after the honor period ends and an `expire` job at the expiry date.
- PayPal does not allow reauthorizing an authorization that has already been partially captured; PACT's job skips that case and records why.
- **Multiple partial captures** against one authorization are allowed with `final_capture: false`; the total may exceed the authorized amount by up to 115% or USD 75, whichever is less. PACT never captures more than the pact total. The final capture (`final_capture: true`) makes PayPal void whatever remains; PACT records that as an `AUTO_VOIDED_BY_FINAL_CAPTURE` ledger row without an extra API call.
- When the last milestone ends without a capture (refund decision, cancellation, expiry), PACT voids the authorization explicitly.

## Verified against the live sandbox

Observed on 2026-11-06 with the project's sandbox app (pact `pact_888b7b6b9fe345fa`, USD 450):

| Check | Result |
|---|---|
| OAuth2 client credentials | ✅ 200; token scopes include payouts and reporting |
| Create order `intent: AUTHORIZE` with `payment_source.paypal.experience_context` | ✅ status `PAYER_ACTION_REQUIRED`, approval link has `rel: "payer-action"` (not `approve`) |
| Buyer approval in sandbox checkout, automated with Playwright + the sandbox personal account | ✅ worked (approval page load is slow on a slow connection: up to several minutes) |
| Authorize the approved order | ✅ authorization `CREATED`, `expiration_time` = authorization time + 29 days |
| Partial capture 315.00 with `final_capture: false` | ✅ `COMPLETED` |
| Second capture 135.00 with `final_capture: true` on the same authorization | ✅ `COMPLETED`; authorization then reads `CAPTURED` (two captures, one authorization) |
| Partial refund 10.00 on the first capture | ✅ `COMPLETED` |
| Transaction Search, balances | ✅ 200 (feature enabled on the app) |
| Void of an un-captured authorization (cancel path) | ⏳ not yet observed: the sandbox checkout page did not finish loading on the connection available that evening; the call is implemented and covered by mocked/simulated tests |
| Reauthorization after the honor period | ⏳ needs a 4-day-old authorization; covered by the simulated adapter and the job logic |
| Payouts batch | ⏳ endpoint reachable, real payout not yet sent |

## Webhooks vs. the reconciliation poller

PayPal cannot reach `localhost`, so PACT has two paths that end in the same ledger update and audit entry:

1. **Reconciliation poller** (always on, every 30 s, also `POST /api/admin/reconcile`): for proposed pacts with an order, reads the order back and authorizes it as soon as the buyer has approved; for funded pacts, reads the authorization back and flags `VOIDED` / `EXPIRED` / `DENIED` mismatches.
2. **Webhooks** (`POST /api/webhooks/paypal`): verified with PayPal's `verify-webhook-signature` API using `PAYPAL_WEBHOOK_ID`; duplicates are ignored by event id; unverified events are stored and audit-logged but never applied. Handled events: `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.CAPTURE.COMPLETED` / `PENDING` / `DENIED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.PAYOUTSBATCH.*`, `PAYMENT.PAYOUTS-ITEM.*`. The normaliser is unit-tested with recorded payloads in `packages/paypal/test/fixtures/`. To receive real events, expose port 4000 with any tunnel, register `https://<tunnel>/api/webhooks/paypal` in the developer dashboard, and set `PAYPAL_WEBHOOK_ID`. PayPal's webhook simulator can then send sample events.

## Transaction Search caveats

At most 31 days per request, no fractional seconds in dates, and new activity can take **up to about 3 hours** to appear. That is why the live dashboard reads **PACT's own ledger**; the "PayPal reconciliation" page shows Transaction Search rows matched against PACT's ledger, with an "as of" timestamp and a list of PACT operations not yet visible in Transaction Search.

## What the simulated adapter does not model

Risk declines, `PENDING` captures and holds, currency conversion, fees, PayPal-side disputes and chargebacks, real email notifications, and real checkout UX.
