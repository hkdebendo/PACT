import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SandboxGateway, SimulatedGateway, normaliseWebhook, PayPalError } from '../src/index';

const usd = (minor: number) => ({ minor, currency: 'USD' });
const fixture = (name: string) => JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures', name), 'utf8'));

async function authorized(sim: SimulatedGateway, minor = 45000) {
  const o = await sim.createAuthorizeOrder({ pactId: 'p1', description: 'd', amount: usd(minor), returnUrl: 'r', cancelUrl: 'c', requestId: 'o1' });
  sim.approveOrder(o.orderId);
  return sim.authorizeOrder(o.orderId, 'a1');
}

describe('SimulatedGateway (SIMULATED rules)', () => {
  it('labels ids and requires approval before authorize', async () => {
    const sim = new SimulatedGateway();
    const o = await sim.createAuthorizeOrder({ pactId: 'p1', description: 'd', amount: usd(100), returnUrl: 'r', cancelUrl: 'c', requestId: 'x' });
    expect(o.orderId).toMatch(/^SIM-ORDER-/);
    expect(o.approvalUrl).toContain(o.orderId);
    await expect(sim.authorizeOrder(o.orderId, 'y')).rejects.toThrow(/ORDER_NOT_APPROVED/);
  });

  it('supports multiple partial captures then a final capture', async () => {
    const sim = new SimulatedGateway();
    const a = await authorized(sim);
    const c1 = await sim.captureAuthorization(a.authorizationId, { amount: usd(13500), finalCapture: false, requestId: 'c1' });
    expect((await sim.getAuthorization(a.authorizationId)).status).toBe('PARTIALLY_CAPTURED');
    await sim.captureAuthorization(a.authorizationId, { amount: usd(31500), finalCapture: true, requestId: 'c2' });
    expect((await sim.getAuthorization(a.authorizationId)).status).toBe('CAPTURED');
    await expect(sim.captureAuthorization(a.authorizationId, { amount: usd(1), finalCapture: true, requestId: 'c3' })).rejects.toThrow(
      /ALREADY_CAPTURED/,
    );
    const r = await sim.refundCapture(c1.captureId, usd(13500), 'dispute', 'r1');
    expect(r.status).toBe('COMPLETED');
    await expect(sim.refundCapture(c1.captureId, usd(1), 'x', 'r2')).rejects.toThrow(/REFUND_AMOUNT_EXCEEDED/);
  });

  it('is idempotent on request id', async () => {
    const sim = new SimulatedGateway();
    const a = await authorized(sim);
    const x = await sim.captureAuthorization(a.authorizationId, { amount: usd(100), finalCapture: false, requestId: 'same' });
    const y = await sim.captureAuthorization(a.authorizationId, { amount: usd(100), finalCapture: false, requestId: 'same' });
    expect(y.captureId).toBe(x.captureId);
  });

  it('enforces the capture allowance, void and honor period', async () => {
    const sim = new SimulatedGateway();
    const a = await authorized(sim, 10000);
    await expect(sim.captureAuthorization(a.authorizationId, { amount: usd(11600), finalCapture: false, requestId: 'big' })).rejects.toThrow(
      /MAX_CAPTURE/,
    );
    await expect(sim.reauthorize(a.authorizationId, usd(10000), 're1')).rejects.toThrow(/honor period/);
    sim.ageAuthorization(a.authorizationId, 4);
    const re = await sim.reauthorize(a.authorizationId, usd(10000), 're2');
    expect(re.authorizationId).not.toBe(a.authorizationId);
    const v = await sim.voidAuthorization(re.authorizationId, 'v1');
    expect(v.status).toBe('VOIDED');
    sim.ageAuthorization(a.authorizationId, 30);
    expect((await sim.getAuthorization(a.authorizationId)).status).toBe('EXPIRED');
  });
});

describe('SandboxGateway transport (mocked fetch)', () => {
  const tokenRes = () => new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });

  it('sends PayPal-Request-Id, retries 5xx with the same id, and maps capture results', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init: init ?? {} });
      if (u.endsWith('/v1/oauth2/token')) return tokenRes();
      const n = calls.filter((c) => c.url.includes('/capture')).length;
      if (n === 1) return new Response('{"name":"INTERNAL_SERVER_ERROR"}', { status: 503 });
      return new Response(JSON.stringify({ id: 'CAP1', status: 'COMPLETED', amount: { value: '135.00', currency_code: 'USD' }, final_capture: false }), {
        status: 201,
      });
    });
    const gw = new SandboxGateway({ clientId: 'id', clientSecret: 'secret', fetchImpl: fetchImpl as typeof fetch, sleep: async () => {} });
    const cap = await gw.captureAuthorization('AUTH1', { amount: usd(13500), finalCapture: false, requestId: 'req-123' });
    expect(cap).toMatchObject({ captureId: 'CAP1', amount: { minor: 13500 }, finalCapture: false });
    const captureCalls = calls.filter((c) => c.url.includes('/capture'));
    expect(captureCalls).toHaveLength(2);
    for (const c of captureCalls) expect((c.init.headers as Record<string, string>)['PayPal-Request-Id']).toBe('req-123');
    expect(JSON.parse(String(captureCalls[0].init.body))).toEqual({ amount: { currency_code: 'USD', value: '135.00' }, final_capture: false });
  });

  it('surfaces typed errors with issues and debug id', async () => {
    const fetchImpl = async (url: string | URL | Request) =>
      String(url).endsWith('/token')
        ? tokenRes()
        : new Response(JSON.stringify({ name: 'UNPROCESSABLE_ENTITY', message: 'bad', debug_id: 'dbg1', details: [{ issue: 'AUTHORIZATION_VOIDED' }] }), { status: 422 });
    const gw = new SandboxGateway({ clientId: 'id', clientSecret: 's', fetchImpl: fetchImpl as typeof fetch, sleep: async () => {} });
    const e = await gw.voidAuthorization('A', 'r').catch((x) => x);
    expect(e).toBeInstanceOf(PayPalError);
    expect(e.toJSON()).toMatchObject({ status: 422, debugId: 'dbg1', issues: [{ issue: 'AUTHORIZATION_VOIDED' }] });
    expect(JSON.stringify(e.toJSON())).not.toContain('tok');
  });

  it('refuses non-sandbox base URLs', () => {
    expect(() => new SandboxGateway({ clientId: 'a', clientSecret: 'b', baseUrl: 'https://api-m.paypal.com' })).toThrow(/sandbox/);
  });
});

describe('webhook normalisation (recorded payloads)', () => {
  it('maps capture, refund and void events', () => {
    expect(normaliseWebhook(fixture('capture-completed.json'))).toEqual({
      kind: 'capture',
      captureId: '2GG279541U471931P',
      authorizationId: '0VF52814937998046',
      status: 'COMPLETED',
    });
    expect(normaliseWebhook(fixture('capture-refunded.json'))).toMatchObject({ kind: 'refund', captureId: '2GG279541U471931P' });
    expect(normaliseWebhook(fixture('authorization-voided.json'))).toMatchObject({ kind: 'authorization', status: 'VOIDED' });
    expect(normaliseWebhook({ id: 'x', event_type: 'CUSTOMER.DISPUTE.CREATED', resource: {} }).kind).toBe('ignored');
  });
});
