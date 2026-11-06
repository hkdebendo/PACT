# PACT MCP server

PACT exposes its escrow as an [MCP](https://modelcontextprotocol.io) server so any agent — Claude, ChatGPT, a custom agent — can create and execute pacts.

- **Transport:** Streamable HTTP, stateless, at `http://localhost:4000/mcp` (POST).
- **Auth:** `Authorization: Bearer <agent key>`. Keys come from `AGENT_API_KEYS` in `.env.local` (`name:key,name:key`). Without it, two local demo keys are used (`local-demo-buyer`, `local-demo-seller`) — the API only listens on 127.0.0.1, so they are not reachable from the network.
- **Rate limit:** 120 calls per minute per client.
- **Audit:** every call is appended to the hash-chained audit log as `mcp.call` with the agent's name.
- Every result is structured JSON with a `nextSteps` array telling the agent what to do next.

## Tools

| Tool | What it does |
|---|---|
| `create_pact` | Natural-language `deal` (parsed by the Muse Contract Parser) or a structured `contract`. Returns clarification questions instead of guessing. |
| `propose_pact` | Buyer proposes the draft to the seller. |
| `accept_pact` | Seller accepts (required before funding). |
| `fund_pact` | First call: creates the PayPal order (`intent: AUTHORIZE`) and returns `approvalUrl`. A **human** buyer approves once in PayPal; later calls confirm the authorization. |
| `submit_evidence` | Seller submits a photo / document / code / tracking file (base64 or a demo fixture name). |
| `verify_milestone` | Deterministic pre-checks, then the two-step Muse Verifier. Approved milestones are captured automatically (partial capture). |
| `release_funds` | Capture an approved milestone manually (when `autoRelease` was false). |
| `open_dispute` / `add_statement` / `arbitrate_dispute` | Dispute flow; the AI Arbiter decides release / partial / refund and PACT moves the money. Appealable to a human. |
| `get_reputation` | Bayesian-smoothed reliability score of a party, or the leaderboard. |
| `get_pact`, `list_pacts` | Read tools. |

## The human in the loop: buyer approval

An Orders `AUTHORIZE` flow needs the buyer to approve in PayPal checkout; an autonomous agent cannot (and should not) do that by itself. `fund_pact` returns the approval URL, the human approves once, and from then on the agents operate **inside** that authorization: they can release milestone shares, but never spend more than the human approved. That cap is a feature.

In the demo, `npm run demo` completes the sandbox approval with Playwright using the sandbox buyer test account from `.env.local` (`DEMO_BUYER_EMAIL` / `DEMO_BUYER_PASSWORD`), or the labelled SIMULATED approval when no sandbox credentials are set.

## Connecting a client

### Claude Code

```bash
claude mcp add --transport http pact http://localhost:4000/mcp --header "Authorization: Bearer local-demo-buyer"
```

### Any MCP client (JSON config)

```json
{
  "mcpServers": {
    "pact": {
      "type": "http",
      "url": "http://localhost:4000/mcp",
      "headers": { "Authorization": "Bearer local-demo-buyer" }
    }
  }
}
```

### Raw HTTP (to check it works)

```bash
curl -s http://localhost:4000/mcp \
  -H "Authorization: Bearer local-demo-buyer" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### The bundled demo agents

[`packages/agents`](../packages/agents) contains a buyer and a seller agent: a plain tool-calling loop (Muse via the OpenAI-compatible Chat Completions API) over the official MCP TypeScript client — no agent SDK. `npm run demo` runs them against the running API.

## PayPal's own MCP server and Agent Toolkit

PayPal publishes the [Agent Toolkit](https://github.com/paypal/agent-toolkit) (`@paypal/agent-toolkit`) and an MCP server (`@paypal/mcp`). We evaluated them for PACT:

- They expose invoices, `create_order` / `get_order` / `pay_order`, refunds, disputes, shipment tracking, catalog, subscriptions and `list_transactions`.
- They do **not** expose the authorization lifecycle PACT is built on — authorize an order, partial captures with `final_capture`, void, reauthorize — so they cannot replace PACT's PayPal adapter.
- They pull a large dependency tree (LangChain core, the Vercel AI SDK, OpenAI SDK v4, mathjs, axios), which conflicts with the project's "npm install and run" constraint on slow connections.

Where they **do** add value is next to PACT: an agent can connect to both servers and independently check PACT's claims with PayPal's own tools (for example `get_order` on the order id returned by `fund_pact`, or `list_transactions` after a capture). Example client config:

```json
{
  "mcpServers": {
    "pact": { "type": "http", "url": "http://localhost:4000/mcp", "headers": { "Authorization": "Bearer local-demo-buyer" } },
    "paypal": { "command": "npx", "args": ["-y", "@paypal/mcp", "--tools=orders.get,transactions.list"], "env": { "PAYPAL_ACCESS_TOKEN": "<sandbox access token>", "PAYPAL_ENVIRONMENT": "SANDBOX" } }
  }
}
```

This is documented, not bundled: PACT's demo agents only need PACT's server.
