// Live video proof. When the buyer requires it on a milestone, photos can no longer be uploaded:
// the seller opens a one-time capture link, presses Start, and films the goods for 20 seconds while
// PACT shows three instructions drawn at random at that moment (server-side). Frames taken at fixed
// moments go to Muse, which checks each instruction; four of them also become the milestone's photo
// evidence for the usual two-step Verifier. The whole video is kept for the Arbiter and human review.
import { randomBytes, randomInt, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LIVE_PLAN, liveCheckFailures, pickChallenges, type LiveChallenge, type LiveCheck } from '@pact/core';
import { and, desc, eq, tables } from '@pact/db';
import { checkLiveChallenges, LlmConfigError, LlmOutputError, LlmReplayMissError } from '@pact/llm';
import { newId, type AppContext } from '../context';
import { appendAudit } from './audit';
import { ServiceError } from './errors';
import type { PactService } from './pacts';

type SessionRow = typeof tables.liveSessions.$inferSelect;

const OPEN_MILESTONE = ['pending', 'rejected', 'needs_more', 'evidence_submitted'];
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_VIDEO_BYTES = 12 * 1024 * 1024;

export function isLiveRequired(ctx: AppContext, pactId: string, milestoneId: string) {
  return !!ctx.db.select().from(tables.liveRequirements).where(and(eq(tables.liveRequirements.pactId, pactId), eq(tables.liveRequirements.milestoneId, milestoneId))).get();
}

/**
 * Pre-check failures for a milestone that requires live proof: every photo must come from a live
 * session whose instructions were all performed. Empty when live proof is not required.
 */
export function liveEvidenceFailures(ctx: AppContext, pactId: string, milestoneId: string, evidence: { id: string; type: string }[]): string[] {
  if (!isLiveRequired(ctx, pactId, milestoneId)) return [];
  const sessions = ctx.db.select().from(tables.liveSessions).where(and(eq(tables.liveSessions.pactId, pactId), eq(tables.liveSessions.milestoneId, milestoneId))).all();
  const bySession = new Map<string, SessionRow>();
  for (const s of sessions) for (const id of JSON.parse(s.evidenceIdsJson) as string[]) bySession.set(id, s);
  const photos = evidence.filter((e) => e.type === 'photo');
  if (!photos.length) return ['This milestone requires live video proof: no live recording was submitted.'];
  const failures: string[] = [];
  for (const e of photos) {
    const s = bySession.get(e.id);
    if (!s) failures.push(`Evidence ${e.id} was uploaded, but this milestone requires live video proof.`);
    else if (s.status !== 'passed') {
      const f = JSON.parse(s.failuresJson) as string[];
      failures.push(...(f.length ? f.map((x) => `Live proof: ${x}`) : [`Live proof: the recording could not be checked (${s.error ?? s.status}).`]));
    }
  }
  return [...new Set(failures)];
}

export function setLiveRequired(ctx: AppContext, pacts: PactService, pactId: string, milestoneId: string, required: boolean, actor: string) {
  const view = pacts.view(pactId);
  const m = view.milestones.find((x) => x.id === milestoneId);
  if (!m) throw new ServiceError('MILESTONE_NOT_FOUND', `Milestone ${milestoneId} not found`, 404);
  if (!m.evidenceTypes.includes('photo')) throw new ServiceError('LIVE_NOT_APPLICABLE', 'Live video proof replaces photos; this milestone does not accept photos.', 409);
  if (!['pending', 'rejected', 'needs_more'].includes(m.status) || ['completed', 'closed', 'cancelled', 'expired'].includes(view.status))
    throw new ServiceError('LIVE_TOO_LATE', `Live proof can only be changed before evidence is submitted (milestone is ${m.status}).`, 409);
  const where = and(eq(tables.liveRequirements.pactId, pactId), eq(tables.liveRequirements.milestoneId, milestoneId));
  if (required && !isLiveRequired(ctx, pactId, milestoneId))
    ctx.db.insert(tables.liveRequirements).values({ pactId, milestoneId, createdAt: ctx.now().toISOString(), createdBy: actor }).run();
  if (!required) ctx.db.delete(tables.liveRequirements).where(where).run();
  appendAudit(ctx, { pactId, actor, type: 'live.requirement', data: { milestoneId, required } });
  return liveOverview(ctx, pactId);
}

const failedAttempts = (ctx: AppContext, pactId: string, milestoneId: string) =>
  ctx.db
    .select()
    .from(tables.liveSessions)
    .where(and(eq(tables.liveSessions.pactId, pactId), eq(tables.liveSessions.milestoneId, milestoneId), eq(tables.liveSessions.status, 'failed')))
    .all().length;

const sessionSummary = (s: SessionRow) => ({
  id: s.id,
  status: s.status,
  createdAt: s.createdAt,
  startedAt: s.startedAt,
  submittedAt: s.submittedAt,
  challenges: s.challengesJson ? (JSON.parse(s.challengesJson) as LiveChallenge[]) : [],
  check: s.checkJson ? (JSON.parse(s.checkJson) as LiveCheck) : null,
  failures: JSON.parse(s.failuresJson) as string[],
  evidenceIds: JSON.parse(s.evidenceIdsJson) as string[],
  hasVideo: !!s.videoPath,
  error: s.error,
});

/** Live-proof state of every milestone of a pact (kept out of the pact view on purpose). */
export function liveOverview(ctx: AppContext, pactId: string) {
  const reqs = ctx.db.select().from(tables.liveRequirements).where(eq(tables.liveRequirements.pactId, pactId)).all();
  const sessions = ctx.db.select().from(tables.liveSessions).where(eq(tables.liveSessions.pactId, pactId)).orderBy(desc(tables.liveSessions.createdAt)).all();
  const mids = new Set([...reqs.map((r) => r.milestoneId), ...sessions.map((s) => s.milestoneId)]);
  return {
    plan: LIVE_PLAN,
    milestones: Object.fromEntries(
      [...mids].map((mid) => [
        mid,
        {
          required: reqs.some((r) => r.milestoneId === mid),
          failedAttempts: failedAttempts(ctx, pactId, mid),
          sessions: sessions.filter((s) => s.milestoneId === mid).map(sessionSummary),
        },
      ]),
    ),
  };
}

export function createLiveSession(ctx: AppContext, pacts: PactService, pactId: string, milestoneId: string, actor: string) {
  const view = pacts.view(pactId);
  const m = view.milestones.find((x) => x.id === milestoneId);
  if (!m) throw new ServiceError('MILESTONE_NOT_FOUND', `Milestone ${milestoneId} not found`, 404);
  if (!isLiveRequired(ctx, pactId, milestoneId)) throw new ServiceError('LIVE_NOT_REQUIRED', 'Live video proof is not enabled on this milestone.', 409);
  if (!['funded', 'in_progress', 'disputed'].includes(view.status) || !OPEN_MILESTONE.includes(m.status))
    throw new ServiceError('LIVE_NOT_OPEN', `The milestone cannot take evidence now (pact ${view.status}, milestone ${m.status}).`, 409);
  if (failedAttempts(ctx, pactId, milestoneId) >= LIVE_PLAN.maxFailedAttempts)
    throw new ServiceError('LIVE_ATTEMPTS_EXHAUSTED', `${LIVE_PLAN.maxFailedAttempts} live recordings failed on this milestone: open a dispute so the Arbiter or a human decides.`, 409);
  const now = ctx.now();
  const row = {
    id: newId('live'),
    token: randomBytes(16).toString('hex'),
    pactId,
    milestoneId,
    status: 'open',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + LIVE_PLAN.linkValidMs).toISOString(),
    createdBy: actor,
  };
  ctx.db.insert(tables.liveSessions).values(row).run();
  appendAudit(ctx, { pactId, actor, type: 'live.session.created', data: { milestoneId, sessionId: row.id, expiresAt: row.expiresAt } });
  return { sessionId: row.id, token: row.token, url: `${ctx.config.app.baseUrl.replace(/\/$/, '')}/live/${row.token}`, expiresAt: row.expiresAt };
}

function sessionByToken(ctx: AppContext, token: string): SessionRow {
  if (!/^[0-9a-f]{32}$/.test(token)) throw new ServiceError('LIVE_NOT_FOUND', 'Unknown or invalid capture link', 404);
  const s = ctx.db.select().from(tables.liveSessions).where(eq(tables.liveSessions.token, token)).get();
  if (!s) throw new ServiceError('LIVE_NOT_FOUND', 'Unknown or invalid capture link', 404);
  if (s.status === 'open' && ctx.now().toISOString() > s.expiresAt) {
    ctx.db.update(tables.liveSessions).set({ status: 'expired' }).where(eq(tables.liveSessions.id, s.id)).run();
    return { ...s, status: 'expired' };
  }
  return s;
}

/** What the capture page shows. Instructions stay secret until the recording starts. */
export function publicLiveSession(ctx: AppContext, pacts: PactService, token: string) {
  const s = sessionByToken(ctx, token);
  const view = pacts.view(s.pactId);
  const m = view.milestones.find((x) => x.id === s.milestoneId)!;
  const latest = m.verdicts.at(-1);
  return {
    status: s.status,
    expiresAt: s.expiresAt,
    pact: { id: view.id, title: view.title, buyer: view.buyer.name, seller: view.seller.name },
    milestone: { id: m.id, title: m.title, status: m.status, criteria: m.criteria, amountMinor: m.amountMinor, currency: view.currency },
    plan: LIVE_PLAN,
    challenges: s.status === 'open' || s.status === 'expired' ? [] : (JSON.parse(s.challengesJson ?? '[]') as LiveChallenge[]),
    failures: JSON.parse(s.failuresJson) as string[],
    check: s.checkJson ? (JSON.parse(s.checkJson) as LiveCheck) : null,
    error: s.error,
    verdict: s.status === 'passed' || s.status === 'failed' ? (latest ? { status: latest.status, confidence: latest.confidence, reasoning: latest.reasoning } : null) : null,
    attemptsLeft: Math.max(0, LIVE_PLAN.maxFailedAttempts - failedAttempts(ctx, s.pactId, s.milestoneId)),
  };
}

export function startLiveSession(ctx: AppContext, token: string) {
  const s = sessionByToken(ctx, token);
  if (s.status !== 'open') throw new ServiceError('LIVE_NOT_OPEN', s.status === 'expired' ? 'This capture link has expired. Ask for a new one.' : `This capture link was already used (${s.status}).`, 409);
  const challenges = pickChallenges(() => randomInt(0, 2 ** 32) / 2 ** 32);
  const startedAt = ctx.now().toISOString();
  ctx.db.update(tables.liveSessions).set({ status: 'recording', startedAt, challengesJson: JSON.stringify(challenges) }).where(eq(tables.liveSessions.id, s.id)).run();
  appendAudit(ctx, { pactId: s.pactId, actor: 'seller:live-capture', type: 'live.session.started', data: { sessionId: s.id, milestoneId: s.milestoneId, challenges: challenges.map((c) => c.id) } });
  return { startedAt, challenges, plan: LIVE_PLAN };
}

export interface LiveSubmission {
  video: string; // base64
  videoMime: string;
  frames: { slot: string; atMs: number; data: string }[]; // base64 JPEG
}

const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const videoKind = (b: Buffer) =>
  b.length > 12 && b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) ? { mime: 'video/webm', ext: 'webm' } : b.length > 12 && b.subarray(4, 8).toString('ascii') === 'ftyp' ? { mime: 'video/mp4', ext: 'mp4' } : null;

function fail(ctx: AppContext, s: SessionRow, status: 'expired' | 'failed', reason: string, code: string, http = 422): never {
  ctx.db.update(tables.liveSessions).set({ status, failuresJson: JSON.stringify([reason]), submittedAt: ctx.now().toISOString() }).where(eq(tables.liveSessions.id, s.id)).run();
  appendAudit(ctx, { pactId: s.pactId, actor: 'system:live', type: 'live.rejected', data: { sessionId: s.id, reason } });
  throw new ServiceError(code, reason, http);
}

export async function submitLiveSession(ctx: AppContext, pacts: PactService, token: string, body: LiveSubmission) {
  const s = sessionByToken(ctx, token);
  if (s.status !== 'recording' || !s.startedAt) throw new ServiceError('LIVE_NOT_RECORDING', `Nothing is being recorded on this link (${s.status}).`, 409);
  const elapsed = ctx.now().getTime() - Date.parse(s.startedAt);
  if (elapsed > LIVE_PLAN.submitWithinMs) fail(ctx, s, 'expired', `The recording arrived ${Math.round(elapsed / 1000)} s after it started; it must arrive within ${LIVE_PLAN.submitWithinMs / 1000} s.`, 'LIVE_TOO_LATE', 409);
  if (elapsed < LIVE_PLAN.durationMs - 1_500) fail(ctx, s, 'failed', `The recording lasted ${Math.round(elapsed / 1000)} s; it must cover the full ${LIVE_PLAN.durationMs / 1000} s.`, 'LIVE_TOO_SHORT');

  // Frames: exactly the planned slots, JPEG, near their planned time.
  const frames = LIVE_PLAN.frames.map((p) => {
    const f = body.frames.find((x) => x.slot === p.slot);
    if (!f) fail(ctx, s, 'failed', `Frame ${p.slot} is missing from the recording.`, 'LIVE_BAD_FRAMES');
    const bytes = Buffer.from(f.data, 'base64');
    if (!isJpeg(bytes) || bytes.length > MAX_FRAME_BYTES) fail(ctx, s, 'failed', `Frame ${p.slot} is not a JPEG under 2 MB.`, 'LIVE_BAD_FRAMES');
    if (Math.abs(f.atMs - p.atMs) > 2_000) fail(ctx, s, 'failed', `Frame ${p.slot} was taken at ${f.atMs} ms instead of about ${p.atMs} ms.`, 'LIVE_BAD_FRAMES');
    return { ...p, atMs: f.atMs, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  const video = Buffer.from(body.video ?? '', 'base64');
  const kind = videoKind(video);
  if (!kind || video.length > MAX_VIDEO_BYTES) fail(ctx, s, 'failed', 'The video is missing, not WebM/MP4, or larger than 12 MB.', 'LIVE_BAD_VIDEO');

  const dir = resolve(ctx.evidenceDir, 'live');
  mkdirSync(dir, { recursive: true });
  const videoPath = resolve(dir, `${s.id}.${kind.ext}`);
  writeFileSync(videoPath, video);
  const videoSha256 = createHash('sha256').update(video).digest('hex');
  ctx.db.update(tables.liveSessions).set({ status: 'checking', submittedAt: ctx.now().toISOString(), videoPath, videoMime: kind.mime, videoSha256 }).where(eq(tables.liveSessions.id, s.id)).run();

  // Four frames become the milestone's photo evidence (wide shot + one per instruction).
  const evidenceIds: string[] = [];
  for (const f of frames.filter((x) => (LIVE_PLAN.evidenceSlots as readonly string[]).includes(x.slot))) {
    const ev = await pacts.submitEvidence(s.pactId, s.milestoneId, { filename: `live-${f.slot}.jpg`, bytes: f.bytes, type: 'photo', note: null }, 'seller:live-capture', { live: true });
    evidenceIds.push(ev.id);
  }
  ctx.db.update(tables.liveSessions).set({ evidenceIdsJson: JSON.stringify(evidenceIds) }).where(eq(tables.liveSessions.id, s.id)).run();

  // Muse checks the instructions, then the deterministic policy decides.
  const challenges = JSON.parse(s.challengesJson!) as LiveChallenge[];
  let check: LiveCheck;
  try {
    const r = await checkLiveChallenges(ctx.llm, { challenges, frames, pactId: s.pactId });
    check = r.value;
    appendAudit(ctx, { pactId: s.pactId, actor: 'ai:live-check', type: 'ai.live.checked', data: { sessionId: s.id, model: r.model, mode: r.mode, check } });
  } catch (e) {
    const message = e instanceof LlmReplayMissError || e instanceof LlmConfigError ? 'Live proof needs Muse live (META_API_KEY and LLM_MODE=live): a new recording has no recorded answer.' : e instanceof LlmOutputError ? 'Muse returned an invalid answer for the live check.' : (e as Error).message;
    ctx.db.update(tables.liveSessions).set({ status: 'error', error: message }).where(eq(tables.liveSessions.id, s.id)).run();
    throw new ServiceError('AI_UNAVAILABLE', message, 503);
  }
  const failures = liveCheckFailures(check, challenges);
  const status = failures.length ? 'failed' : 'passed';
  ctx.db.update(tables.liveSessions).set({ status, checkJson: JSON.stringify(check), failuresJson: JSON.stringify(failures) }).where(eq(tables.liveSessions.id, s.id)).run();
  appendAudit(ctx, { pactId: s.pactId, actor: 'system:live', type: 'live.checked', data: { sessionId: s.id, status, failures, videoSha256 } });

  // The usual Verifier: a failed live check is a pre-check failure (rejected without model cost).
  const result = await pacts.verifyMilestone(s.pactId, s.milestoneId, 'seller:live-capture');
  return { session: publicLiveSession(ctx, pacts, token), verdict: { status: result.verdict.status, confidence: result.verdict.confidence, reasoning: result.verdict.reasoning }, release: result.release };
}

/** A fresh link with new instructions after a failed or expired recording. */
export function retryLiveSession(ctx: AppContext, pacts: PactService, token: string) {
  const s = sessionByToken(ctx, token);
  if (!['failed', 'expired', 'error'].includes(s.status)) throw new ServiceError('LIVE_NOT_RETRYABLE', `This recording is ${s.status}.`, 409);
  return createLiveSession(ctx, pacts, s.pactId, s.milestoneId, 'seller:live-capture');
}

export function liveVideo(ctx: AppContext, sessionId: string) {
  const s = ctx.db.select().from(tables.liveSessions).where(eq(tables.liveSessions.id, sessionId)).get();
  if (!s?.videoPath) throw new ServiceError('LIVE_NOT_FOUND', 'No video for this session', 404);
  return { path: s.videoPath, mime: s.videoMime ?? 'video/webm' };
}
