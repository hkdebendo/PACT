// Record/replay cache for model responses: one pretty-printed JSON file per call under
// fixtures/llm-cache/<first 2 hex>/<key>.json, committed for the demo scenario so the video is
// deterministic and judges without a Meta key can run it (LLM_MODE=replay).
//
// Volatile values (PACT ids, PayPal ids, timestamps, dates) differ on every run, so they are
// replaced by positional placeholders ⟦v1⟧, ⟦v2⟧… before hashing. The recorded output is stored in
// the same placeholder form and, on replay, placeholders are mapped back to the CURRENT run's values
// in order of first appearance. Dates the model derived from "today" (e.g. a deadline) are shifted by
// the number of days between the recording and the replay.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface CachedCall {
  role: string;
  model: string;
  output: unknown; // normalised (placeholders) form
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
  today?: string | null; // reference date of the recording (YYYY-MM-DD), for date shifting
  /** The normalised prompt that produced the key: shows exactly what was asked, and lets a replay
   *  miss be diffed against the recordings. */
  prompt?: string;
}

export function canonical(value: unknown): string {
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

const VOLATILE = new RegExp(
  [
    String.raw`\b(?:pact|ev|vd|pay|party|dsp|job|llm)_[0-9a-f]{16}\b`, // PACT ids
    String.raw`\bSIM-[A-Z]+-[0-9A-F-]{12}\b`, // simulated PayPal ids (uuid slice, may contain a dash)
    String.raw`\b(?=[0-9A-Z]*\d)[0-9A-Z]{17}\b`, // real PayPal order/authorization/capture ids (may be all digits)
    String.raw`\b[0-9a-f]{64}\b`, // sha256 hashes (audit chain links embed timestamps)
    String.raw`\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b`, // ISO timestamps
    String.raw`\b\d{4}-\d{2}-\d{2}\b`, // dates
  ].join('|'),
  'g',
);

export interface Normalised {
  text: string;
  values: string[];
}

/** Replaces volatile values with ⟦vN⟧ placeholders (N by first appearance). */
// The LLM mode a verdict was produced in ("live" when recorded, "replay" when replayed) appears in
// tool results; it says nothing about the content, so it is neutralised in the key.
const LLM_MODE_FIELD = /(llmMode\\*"\s*:\s*\\*")(live|replay)/g;

export function normaliseVolatile(value: unknown, values: string[] = []): Normalised {
  const text = canonical(value).replace(LLM_MODE_FIELD, '$1⟦mode⟧').replace(VOLATILE, (m) => {
    let i = values.indexOf(m);
    if (i < 0) {
      values.push(m);
      i = values.length - 1;
    }
    return `⟦v${i + 1}⟧`;
  });
  return { text, values };
}

/** Replaces only values already known from the input; new values in the output stay literal. */
export function normaliseOutput(output: unknown, inputValues: string[]): unknown {
  const text = JSON.stringify(output).replace(VOLATILE, (m) => {
    const i = inputValues.indexOf(m);
    return i < 0 ? m : `⟦v${i + 1}⟧`;
  });
  return JSON.parse(text);
}

const shiftDate = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Maps placeholders back to the current run's values and shifts literal dates by the today delta. */
export function denormaliseOutput(output: unknown, values: string[], recordedToday?: string | null, today?: string | null): unknown {
  const delta = recordedToday && today ? daysBetween(recordedToday, today) : 0;
  let text = JSON.stringify(output);
  if (delta) text = text.replace(/(?<![\dT:-])\d{4}-\d{2}-\d{2}(?![\dT:])/g, (d) => shiftDate(d, delta));
  text = text.replace(/⟦v(\d+)⟧/g, (m, n) => values[Number(n) - 1] ?? m);
  return JSON.parse(text);
}

export class ReplayCache {
  constructor(private readonly dir: string) {}

  private path(key: string) {
    return resolve(this.dir, key.slice(0, 2), `${key}.json`);
  }

  get(key: string): CachedCall | null {
    const p = this.path(key);
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as CachedCall) : null;
  }

  /** Writes the prompt of a replay miss next to the cache (fixtures/llm-cache/_misses/) for diffing. */
  recordMiss(key: string, role: string, prompt: string) {
    const p = resolve(this.dir, '_misses', `${role}-${key.slice(0, 12)}.txt`);
    mkdirSync(resolve(p, '..'), { recursive: true });
    writeFileSync(p, prompt);
  }

  put(key: string, call: CachedCall) {
    const p = this.path(key);
    mkdirSync(resolve(p, '..'), { recursive: true });
    writeFileSync(p, JSON.stringify(call, null, 2) + '\n');
  }
}
