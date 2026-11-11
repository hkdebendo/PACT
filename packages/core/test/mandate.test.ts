import { describe, expect, it } from 'vitest';
import { classifyPurchase, evaluateMandate, mandateText, type Mandate } from '../src/index';

const mandate: Mandate = {
  agent: 'buyer-agent',
  owner: 'Ada (buyer)',
  active: true,
  currency: 'USD',
  maxPactMinor: 100_000,
  maxOpenMinor: 150_000,
  approvalAboveMinor: 50_000,
  categories: ['apparel', 'bags & textiles', 'printing'],
};
const req = (title: string, usd: number, currency = 'USD') => ({ title, text: title, totalMinor: usd * 100, currency });

describe('agent mandate', () => {
  it('classifies purchases by keyword, including plurals and derived forms', () => {
    expect(classifyPurchase('50 embroidered t-shirts')).toEqual(['apparel']);
    expect(classifyPurchase('20 canvas tote bags')).toEqual(['bags & textiles']);
    expect(classifyPurchase('3 laptops and chargers')).toEqual(['electronics']);
    expect(classifyPurchase('a description of the deliverable')).toEqual([]); // "script" inside "description" is not a word
    expect(classifyPurchase('Team building day')).toEqual([]); // "tea" is not in "team"
  });

  it('leaves party names out of the classified text', () => {
    const c = { title: '50 embroidered t-shirts', description: 'Kofi Textiles will produce 50 plain white t-shirts.', milestones: [{ title: 'Production', criteria: [{ text: 'About 50 white t-shirts are shown' }] }] };
    expect(classifyPurchase(mandateText(c))).toEqual(['apparel', 'bags & textiles']);
    expect(classifyPurchase(mandateText(c, ['Kofi Textiles']))).toEqual(['apparel']);
  });

  it('allows the demo deal, asks the owner above the threshold, denies hard-limit breaches', () => {
    expect(evaluateMandate(mandate, req('50 embroidered t-shirts', 450), 0).outcome).toBe('allowed');
    const ask = evaluateMandate(mandate, req('40 hoodies', 800), 0);
    expect(ask.outcome).toBe('needs_approval');
    expect(ask.reasons[0]).toMatch(/above the 500 USD/);
    expect(evaluateMandate(mandate, req('40 hoodies', 800), 0, true).outcome).toBe('allowed');
    const deny = evaluateMandate(mandate, req('3 laptops', 2500), 0);
    expect(deny.outcome).toBe('denied');
    expect(deny.reasons.join(' ')).toMatch(/per-pact limit of 1,000 USD/);
    expect(deny.reasons.join(' ')).toMatch(/Category electronics is not allowed/);
  });

  it('denies a pact that would push open pacts past the budget, even when approved', () => {
    const d = evaluateMandate(mandate, req('30 aprons', 600), 1_000 * 100, true);
    expect(d.outcome).toBe('denied');
    expect(d.reasons[0]).toMatch(/1,600 USD, above the budget of 1,500 USD/);
  });

  it('sends unrecognised purchases and other currencies to the right outcome', () => {
    expect(evaluateMandate(mandate, req('Consulting retainer', 200), 0).outcome).toBe('needs_approval');
    expect(evaluateMandate(mandate, req('50 t-shirts', 450, 'EUR'), 0).outcome).toBe('denied');
    expect(evaluateMandate(null, req('3 laptops', 2500), 0).outcome).toBe('allowed');
    expect(evaluateMandate({ ...mandate, active: false }, req('3 laptops', 2500), 0).outcome).toBe('allowed');
  });
});
