// The demo scenario played by two autonomous agents over MCP. The coordinator only relays "news"
// between them (like a messaging channel); every PACT action is a tool call the agent chose.
// The one human step is the PayPal buyer approval (approveFunding callback): a Playwright script
// in sandbox mode, the SIMULATED approval endpoint in simulated mode.
import type { LlmClient } from '@pact/llm';
import { McpAgent, type AgentEvent } from './agent';

// The real current date: replayed model answers are date-shifted to it, so deadlines stay in the future.
export const DEMO_TODAY = new Date().toISOString().slice(0, 10);
export const DEMO_DEAL =
  'I want 50 embroidered t-shirts (plain white, small blue embroidered star on the chest) delivered before Friday. ' +
  'Total price 450 USD: 30% when production is done, 70% at delivery.';

const BUYER_SYSTEM = `You are "Ada", a procurement agent buying for a small cafe. Today is ${DEMO_TODAY}.
You use the PACT tools to buy safely: money is only released when an AI verifier confirms evidence.
Your deal: "${DEMO_DEAL}". The seller is "Kofi Textiles".
Rules: create the pact with create_pact (pass today), propose it, wait for the seller to accept, then fund it with fund_pact.
Never release money for a milestone that was not approved. Keep replies to one or two short sentences.`;

const SELLER_SYSTEM = `You are "Kofi Textiles", a seller agent for a small embroidery workshop. Today is ${DEMO_TODAY}.
You use the PACT tools. When a pact is proposed to you, read it with get_pact and accept it if it matches a 50 t-shirt order.
Your evidence folder (fixture names) contains, in this order:
  1. order_wrong_item.jpg   — a photo from the workshop floor (you are not sure which batch)
  2. order_conforming.jpg   — another production photo
  3. tracking_valid.png     — the courier tracking page for this order
For the production milestone, submit the FIRST photo, then call verify_milestone. If it is rejected, read the verifier's reasoning and submit the photo that matches the order instead, then verify again.
For delivery, submit the tracking page as "tracking" evidence and verify. Keep replies short.`;

export interface ScenarioOptions {
  llm: LlmClient;
  mcpUrl: string;
  buyerKey: string;
  sellerKey: string;
  approveFunding: (approvalUrl: string, pactId: string) => Promise<void>;
  onEvent?: (e: AgentEvent) => void;
}

const findPactId = (agent: McpAgent): string | null => {
  for (const m of [...agent.history].reverse()) {
    if (m.role !== 'tool' || typeof m.content !== 'string') continue;
    const hit = m.content.match(/"id":\s*"(pact_[0-9a-f]{16})"/);
    if (hit) return hit[1];
  }
  return null;
};
const findApprovalUrl = (agent: McpAgent): string | null => {
  for (const m of [...agent.history].reverse()) {
    if (m.role !== 'tool' || typeof m.content !== 'string') continue;
    const hit = m.content.match(/"approvalUrl":\s*"([^"]+)"/);
    if (hit) return hit[1];
  }
  return null;
};

export async function runScenario(o: ScenarioOptions) {
  const buyer = new McpAgent({ name: 'buyer-agent', mcpUrl: o.mcpUrl, apiKey: o.buyerKey, llm: o.llm, system: BUYER_SYSTEM, onEvent: o.onEvent });
  const seller = new McpAgent({ name: 'seller-agent', mcpUrl: o.mcpUrl, apiKey: o.sellerKey, llm: o.llm, system: SELLER_SYSTEM, onEvent: o.onEvent });
  try {
    await buyer.run('Start: set up the pact for the t-shirt order and propose it to the seller.');
    const pactId = findPactId(buyer);
    if (!pactId) throw new Error('Buyer agent did not create a pact');
    await seller.run(`News: Ada proposed pact ${pactId} to you. Review and accept it if it fits.`);
    await buyer.run(`News: the seller replied. Check pact ${pactId} and fund it if it was accepted.`);
    const approvalUrl = findApprovalUrl(buyer);
    if (!approvalUrl) throw new Error('Buyer agent did not obtain a PayPal approval URL');
    await o.approveFunding(approvalUrl, pactId); // the single human step
    await buyer.run(`News: you (the human behind Ada) approved the PayPal authorization. Confirm the funding of pact ${pactId}.`);
    await seller.run(`News: pact ${pactId} is funded. Production is finished: submit your production evidence and get it verified.`);
    await seller.run(`News: the t-shirts were delivered by courier. Submit the delivery evidence for pact ${pactId} and get it verified.`);
    await buyer.run(`News: check pact ${pactId}, summarise what was paid and the seller's reputation (get_reputation "Kofi Textiles").`);
    return { pactId };
  } finally {
    await buyer.close();
    await seller.close();
  }
}
