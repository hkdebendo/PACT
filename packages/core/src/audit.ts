// Append-only, hash-chained audit log.
// hash_n = sha256( hash_{n-1} + canonicalJson(entry_n) ), with hash_0's predecessor = GENESIS.
// Changing, removing or reordering any past entry changes every later hash, so `verifyChain`
// detects tampering from the first altered entry onward.
import { createHash } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditEntryInput {
  pactId: string | null;
  actor: string; // e.g. "buyer:alice", "agent:seller-agent", "ai:verifier", "system", "paypal:webhook"
  type: string; // e.g. "pact.created", "milestone.verdict", "paypal.capture", "transition.rejected"
  data: unknown;
}

export interface AuditEntry extends AuditEntryInput {
  seq: number;
  ts: string; // ISO timestamp
  prevHash: string;
  hash: string;
}

/** JSON with object keys sorted recursively and no whitespace; undefined values dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite number in audit data');
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export const sha256 = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex');

export function hashEntry(prevHash: string, e: Omit<AuditEntry, 'hash' | 'prevHash'>): string {
  return sha256(
    prevHash + canonicalJson({ seq: e.seq, ts: e.ts, pactId: e.pactId, actor: e.actor, type: e.type, data: e.data }),
  );
}

export function chainNext(prev: AuditEntry | null, input: AuditEntryInput, ts = new Date().toISOString()): AuditEntry {
  const seq = prev ? prev.seq + 1 : 1;
  const prevHash = prev ? prev.hash : GENESIS_HASH;
  // Round-trip data through canonical JSON so what is hashed is exactly what is stored.
  const data = JSON.parse(canonicalJson(input.data ?? null));
  const base = { seq, ts, pactId: input.pactId, actor: input.actor, type: input.type, data };
  return { ...base, prevHash, hash: hashEntry(prevHash, base) };
}

export interface ChainVerification {
  ok: boolean;
  count: number;
  headHash: string;
  brokenAt: number | null; // seq of the first bad entry
  reason: string | null;
}

export function verifyChain(entries: AuditEntry[]): ChainVerification {
  let prevHash = GENESIS_HASH;
  let expectedSeq = 1;
  for (const e of entries) {
    if (e.seq !== expectedSeq) return fail(entries, e.seq, `sequence gap: expected ${expectedSeq}`);
    if (e.prevHash !== prevHash) return fail(entries, e.seq, 'prevHash does not match the previous entry');
    const recomputed = hashEntry(prevHash, e);
    if (recomputed !== e.hash) return fail(entries, e.seq, 'hash does not match the entry content');
    prevHash = e.hash;
    expectedSeq++;
  }
  return { ok: true, count: entries.length, headHash: prevHash, brokenAt: null, reason: null };
}

function fail(entries: AuditEntry[], seq: number, reason: string): ChainVerification {
  return { ok: false, count: entries.length, headHash: entries.at(-1)?.hash ?? GENESIS_HASH, brokenAt: seq, reason };
}
