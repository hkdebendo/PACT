// In-process job scheduler over the `jobs` table (no Redis). A single timer claims due jobs,
// runs them, and retries failures with exponential backoff up to max_attempts. A recurring
// reconciliation sweep runs on its own interval (it needs no public URL, unlike webhooks).
import { and, asc, eq, lte, tables } from '@pact/db';
import type { AppContext } from '../context';
import { appendAudit } from './audit';
import type { PactService } from './pacts';
import { reconcile } from './reconcile';

export type JobHandler = (payload: Record<string, unknown>) => Promise<unknown>;

export class JobRunner {
  private timer: NodeJS.Timeout | null = null;
  private reconTimer: NodeJS.Timeout | null = null;
  private running = false;
  readonly handlers: Record<string, JobHandler>;

  constructor(
    private readonly ctx: AppContext,
    private readonly pacts: PactService,
  ) {
    this.handlers = {
      reauthorize: (p) => pacts.reauthorizeIfNeeded(String(p.pactId)),
      expire: (p) => pacts.expireIfOpen(String(p.pactId)),
      verify: (p) => pacts.verifyMilestone(String(p.pactId), String(p.milestoneId), 'system:jobs'),
      reconcile: () => reconcile(ctx, pacts),
    };
  }

  start(intervalMs = 2000, reconcileMs = 30_000) {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.reconTimer = setInterval(() => void reconcile(this.ctx, this.pacts).catch(() => {}), reconcileMs);
    this.timer.unref();
    this.reconTimer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.reconTimer) clearInterval(this.reconTimer);
  }

  /** Runs every due job once. Returns how many ran. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let count = 0;
    try {
      const now = this.ctx.now().toISOString();
      const due = this.ctx.db
        .select()
        .from(tables.jobs)
        .where(and(eq(tables.jobs.status, 'queued'), lte(tables.jobs.runAt, now)))
        .orderBy(asc(tables.jobs.runAt))
        .limit(20)
        .all();
      for (const job of due) {
        const handler = this.handlers[job.type];
        this.ctx.db.update(tables.jobs).set({ status: 'running', attempts: job.attempts + 1, updatedAt: now }).where(eq(tables.jobs.id, job.id)).run();
        try {
          if (!handler) throw new Error(`No handler for job type ${job.type}`);
          const result = await handler(JSON.parse(job.payloadJson));
          this.ctx.db.update(tables.jobs).set({ status: 'done', lastError: null, updatedAt: this.ctx.now().toISOString() }).where(eq(tables.jobs.id, job.id)).run();
          appendAudit(this.ctx, { pactId: (JSON.parse(job.payloadJson).pactId as string) ?? null, actor: 'system:jobs', type: 'job.done', data: { jobId: job.id, type: job.type, result: result ?? null } });
        } catch (e) {
          const attempts = job.attempts + 1;
          const failed = attempts >= job.maxAttempts;
          const retryAt = new Date(this.ctx.now().getTime() + Math.min(3600_000, 5000 * 2 ** attempts)).toISOString();
          this.ctx.db
            .update(tables.jobs)
            .set({ status: failed ? 'failed' : 'queued', runAt: failed ? job.runAt : retryAt, lastError: (e as Error).message.slice(0, 500), updatedAt: this.ctx.now().toISOString() })
            .where(eq(tables.jobs.id, job.id))
            .run();
          appendAudit(this.ctx, { pactId: (JSON.parse(job.payloadJson).pactId as string) ?? null, actor: 'system:jobs', type: failed ? 'job.failed' : 'job.retry', data: { jobId: job.id, type: job.type, attempts, error: (e as Error).message } });
        }
        count++;
      }
    } finally {
      this.running = false;
    }
    return count;
  }
}
