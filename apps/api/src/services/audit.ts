// Audit log writer/reader. Appends happen inside a SQLite IMMEDIATE transaction so two writers can
// never fork the chain; the table also has triggers forbidding UPDATE and DELETE.
import { chainNext, verifyChain, type AuditEntry, type AuditEntryInput } from '@pact/core';
import { asc, desc, eq, tables } from '@pact/db';
import type { AppContext } from '../context';

const rowToEntry = (r: typeof tables.auditLog.$inferSelect): AuditEntry => ({
  seq: r.seq,
  ts: r.ts,
  pactId: r.pactId,
  actor: r.actor,
  type: r.type,
  data: JSON.parse(r.dataJson),
  prevHash: r.prevHash,
  hash: r.hash,
});

export function appendAudit(ctx: AppContext, input: AuditEntryInput): AuditEntry {
  const sqlite = ctx.db.$client;
  const entry = sqlite
    .transaction(() => {
      const last = ctx.db.select().from(tables.auditLog).orderBy(desc(tables.auditLog.seq)).limit(1).get();
      const next = chainNext(last ? rowToEntry(last) : null, input, ctx.now().toISOString());
      ctx.db
        .insert(tables.auditLog)
        .values({
          seq: next.seq,
          ts: next.ts,
          pactId: next.pactId,
          actor: next.actor,
          type: next.type,
          dataJson: JSON.stringify(next.data),
          prevHash: next.prevHash,
          hash: next.hash,
        })
        .run();
      return next;
    })
    .immediate();
  ctx.bus.publish({ type: 'audit.appended', seq: entry.seq, hash: entry.hash, entryType: entry.type, pactId: entry.pactId, at: entry.ts });
  return entry;
}

export function listAudit(ctx: AppContext, opts: { pactId?: string; limit?: number } = {}): AuditEntry[] {
  const q = ctx.db.select().from(tables.auditLog);
  const rows = opts.pactId
    ? q.where(eq(tables.auditLog.pactId, opts.pactId)).orderBy(asc(tables.auditLog.seq)).all()
    : q.orderBy(asc(tables.auditLog.seq)).all();
  const entries = rows.map(rowToEntry);
  return opts.limit ? entries.slice(-opts.limit) : entries;
}

export function verifyAudit(ctx: AppContext) {
  const all = ctx.db.select().from(tables.auditLog).orderBy(asc(tables.auditLog.seq)).all().map(rowToEntry);
  return { ...verifyChain(all), verifiedAt: ctx.now().toISOString() };
}
