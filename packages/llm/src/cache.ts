// Record/replay cache for model responses: one pretty-printed JSON file per call under
// fixtures/llm-cache/<first 2 hex>/<key>.json, committed for the demo scenario so the video is
// deterministic and judges without a Meta key can run it (LLM_MODE=replay).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface CachedCall {
  role: string;
  model: string;
  output: unknown;
  usage: {
    role: string;
    model: string;
    mode: 'live' | 'replay';
    cacheHit: boolean;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cachedTokens: number;
    costUsd: number;
    latencyMs: number;
  };
  recordedAt: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}

export const cacheKey = (parts: unknown): string => createHash('sha256').update(canonical(parts)).digest('hex');

export class ReplayCache {
  constructor(private readonly dir: string) {}

  private path(key: string) {
    return resolve(this.dir, key.slice(0, 2), `${key}.json`);
  }

  get(key: string): CachedCall | null {
    const p = this.path(key);
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as CachedCall) : null;
  }

  put(key: string, call: CachedCall) {
    const p = this.path(key);
    mkdirSync(resolve(p, '..'), { recursive: true });
    writeFileSync(p, JSON.stringify(call, null, 2) + '\n');
  }
}
