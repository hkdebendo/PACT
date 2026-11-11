// Agent mandates: the limits a human owner sets for an agent that spends through PACT. Enforced on
// the server for every MCP call that commits money (create_pact, fund_pact), whatever the agent's
// prompt says. Pure and deterministic: no model is involved in deciding what an agent may do.
import { z } from 'zod';

/** Purchase categories, recognised by keywords in the contract (title, description, milestones). */
export const MANDATE_CATEGORIES = {
  apparel: ['t-shirt', 'tshirt', 'shirt', 'hoodie', 'sweatshirt', 'apron', 'cap', 'jacket', 'uniform', 'embroider', 'sock', 'jersey', 'polo'],
  'bags & textiles': ['tote', 'bag', 'napkin', 'towel', 'linen', 'fabric', 'textile', 'canvas', 'tablecloth'],
  printing: ['poster', 'flyer', 'menu card', 'business card', 'sticker', 'banner', 'brochure', 'notebook', 'leaflet'],
  'ceramics & tableware': ['mug', 'bowl', 'plate', 'cup', 'ceramic', 'teapot'],
  software: ['script', 'website', 'widget', 'software', 'plugin', 'app', 'api', 'source code'],
  electronics: ['laptop', 'phone', 'charger', 'cable', 'camera', 'headphone', 'tablet', 'monitor', 'gpu', 'console', 'printer'],
  'food & drink': ['coffee', 'tea', 'food', 'catering', 'cake', 'bean', 'juice', 'wine', 'pastry'],
  'gift cards & crypto': ['gift card', 'voucher', 'crypto', 'bitcoin', 'token'],
} as const;
export type MandateCategory = keyof typeof MANDATE_CATEGORIES;
export const MANDATE_CATEGORY_NAMES = Object.keys(MANDATE_CATEGORIES) as MandateCategory[];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PATTERNS = Object.entries(MANDATE_CATEGORIES).map(([cat, words]) => ({
  cat: cat as MandateCategory,
  re: new RegExp(`\\b(?:${words.map(escape).join('|')})(?:s|es|ed|ing|ery|ers?)?\\b`, 'i'),
}));

/** Categories whose keywords appear in the text. Empty when nothing matched. */
export function classifyPurchase(text: string): MandateCategory[] {
  return PATTERNS.filter((p) => p.re.test(text)).map((p) => p.cat);
}

export const Mandate = z.object({
  agent: z.string().min(1).max(80).describe('Agent key name from AGENT_API_KEYS'),
  owner: z.string().min(1).max(80).describe('The human the agent spends for'),
  active: z.boolean(),
  currency: z.string().length(3),
  maxPactMinor: z.number().int().positive().nullable().describe('Largest single pact, in minor units; null = no limit'),
  maxOpenMinor: z.number().int().positive().nullable().describe('Budget across all open pacts the agent started; null = no limit'),
  approvalAboveMinor: z.number().int().nonnegative().nullable().describe('Pacts above this amount wait for the owner to approve; null = never'),
  categories: z.array(z.enum(MANDATE_CATEGORY_NAMES as [MandateCategory, ...MandateCategory[]])).describe('Allowed purchase categories; empty = any'),
});
export type Mandate = z.infer<typeof Mandate>;

export interface MandateRequest {
  title: string;
  text: string; // title + description + milestone titles and criteria
  totalMinor: number;
  currency: string;
}

export type MandateOutcome = 'allowed' | 'needs_approval' | 'denied';

export interface MandateDecision {
  outcome: MandateOutcome;
  reasons: string[];
  categories: MandateCategory[];
  openMinor: number; // open exposure before this pact
}

const money = (minor: number, currency: string) => `${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: minor % 100 ? 2 : 0, maximumFractionDigits: 2 })} ${currency}`;

/**
 * Hard limits deny; soft limits (above the approval threshold, a category the classifier could not
 * recognise) wait for the owner. `approved` is true once the owner approved this pact.
 */
export function evaluateMandate(m: Mandate | null, req: MandateRequest, openMinor: number, approved = false): MandateDecision {
  const categories = classifyPurchase(req.text);
  if (!m || !m.active) return { outcome: 'allowed', reasons: m ? ['Mandate inactive: no limits applied.'] : ['No mandate for this agent.'], categories, openMinor };
  const deny: string[] = [];
  const ask: string[] = [];
  if (req.currency !== m.currency) deny.push(`Currency ${req.currency} is outside the mandate (${m.currency} only).`);
  if (m.maxPactMinor !== null && req.totalMinor > m.maxPactMinor) deny.push(`${money(req.totalMinor, req.currency)} exceeds the per-pact limit of ${money(m.maxPactMinor, m.currency)}.`);
  if (m.maxOpenMinor !== null && openMinor + req.totalMinor > m.maxOpenMinor)
    deny.push(`Open pacts would reach ${money(openMinor + req.totalMinor, m.currency)}, above the budget of ${money(m.maxOpenMinor, m.currency)} (${money(openMinor, m.currency)} already open).`);
  if (m.categories.length) {
    const outside = categories.filter((c) => !m.categories.includes(c));
    if (outside.length) deny.push(`Category ${outside.join(', ')} is not allowed (allowed: ${m.categories.join(', ')}).`);
    else if (!categories.length) ask.push('PACT could not recognise the purchase category; the owner must confirm it.');
  }
  if (m.approvalAboveMinor !== null && req.totalMinor > m.approvalAboveMinor) ask.push(`${money(req.totalMinor, req.currency)} is above the ${money(m.approvalAboveMinor, m.currency)} the agent may commit without its owner.`);
  if (deny.length) return { outcome: 'denied', reasons: deny, categories, openMinor };
  if (ask.length && !approved) return { outcome: 'needs_approval', reasons: ask, categories, openMinor };
  return { outcome: 'allowed', reasons: ask.length ? ['Approved by the owner.'] : ['Within the mandate.'], categories, openMinor };
}

/** Text the classifier reads for a contract. Party names are left out (a seller called "… Textiles"
 *  says nothing about what is bought). */
export function mandateText(c: { title: string; description: string; milestones: { title: string; criteria: { text: string }[] }[] }, partyNames: string[] = []): string {
  let text = [c.title, c.description, ...c.milestones.flatMap((m) => [m.title, ...m.criteria.map((x) => x.text)])].join('\n');
  for (const n of partyNames.filter(Boolean)) text = text.split(n).join(' ');
  return text;
}
