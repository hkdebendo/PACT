// Wiring: one object holding the database, PayPal gateway, LLM client, event bus and clock, passed
// to every service. Tests build their own context with an in-memory DB and the simulated gateway.
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PactEventMessage } from '@pact/core';
import { getConfig, openDb, repoRoot, tables, type AppConfig, type Db } from '@pact/db';
import { LlmClient } from '@pact/llm';
import { SandboxGateway, SimulatedGateway, type PaymentsGateway } from '@pact/paypal';

export interface AppContext {
  db: Db;
  gateway: PaymentsGateway;
  simulated: SimulatedGateway | null;
  llm: LlmClient;
  bus: EventBus;
  config: AppConfig;
  now: () => Date;
  evidenceDir: string;
  paypalCalls: PayPalCallLog[];
}

export interface PayPalCallLog {
  at: string;
  operation: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  debugId: string | null;
}

export class EventBus extends EventEmitter {
  publish(msg: PactEventMessage) {
    this.emit('event', msg);
  }
}

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

export function createContext(overrides: Partial<AppContext> & { dbPath?: string } = {}): AppContext {
  const config = overrides.config ?? getConfig();
  const db = overrides.db ?? openDb(overrides.dbPath);
  const paypalCalls: PayPalCallLog[] = [];
  let gateway = overrides.gateway;
  let simulated: SimulatedGateway | null = overrides.simulated ?? null;
  if (!gateway) {
    if (config.paypal.mode === 'sandbox') {
      gateway = new SandboxGateway({
        clientId: config.paypal.clientId,
        clientSecret: config.paypal.clientSecret,
        webhookId: config.paypal.webhookId,
        onCall: (c) => {
          paypalCalls.unshift({ at: new Date().toISOString(), ...c });
          paypalCalls.length = Math.min(paypalCalls.length, 200);
        },
      });
    } else {
      simulated = new SimulatedGateway({
        statePath: resolve(repoRoot, 'data', 'simulated-paypal.json'),
        approvalBaseUrl: `${config.app.baseUrl}/simulated-checkout`,
      });
      gateway = simulated;
    }
  }
  const llm =
    overrides.llm ??
    new LlmClient({
      mode: config.llm.mode,
      apiKey: config.llm.apiKey,
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      reasoningEffort: config.llm.reasoningEffort,
      cacheDir: resolve(repoRoot, 'fixtures', 'llm-cache'),
    });
  llm.onUsage((u) => {
    db.insert(tables.llmUsage)
      .values({
        id: newId('llm'),
        role: u.role,
        model: u.model,
        mode: u.mode,
        cacheHit: u.cacheHit,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        reasoningTokens: u.reasoningTokens,
        cachedTokens: u.cachedTokens,
        costUsd: u.costUsd,
        latencyMs: u.latencyMs,
        pactId: u.pactId ?? null,
        createdAt: new Date().toISOString(),
      })
      .run();
  });
  return {
    db,
    gateway,
    simulated,
    llm,
    bus: overrides.bus ?? new EventBus(),
    config,
    now: overrides.now ?? (() => new Date()),
    evidenceDir: overrides.evidenceDir ?? resolve(repoRoot, 'data', 'evidence'),
    paypalCalls,
  };
}
