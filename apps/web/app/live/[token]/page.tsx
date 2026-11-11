'use client';
// Live video proof capture page (one-time link). No file input anywhere: the camera films the goods
// for 20 seconds while PACT shows three random instructions, revealed only when recording starts.
// Frames are grabbed at the planned moments; video + frames go to the API, which has Muse check
// each instruction and then runs the usual Verifier on the milestone.
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveChallenge, LiveCheck } from '@pact/core/browser';
import { api, ApiError, fileToBase64 } from '@/lib/api';
import { Badge, Button, Card, cx, ErrorNote, money, Skeleton, type Tone } from '@/components/ui';

interface Plan {
  durationMs: number;
  wide: { fromMs: number; toMs: number; text: string };
  windows: { fromMs: number; toMs: number }[];
  frames: { slot: string; atMs: number; challenge: number | null }[];
}
interface SessionView {
  status: 'open' | 'recording' | 'checking' | 'passed' | 'failed' | 'expired' | 'error';
  expiresAt: string;
  pact: { id: string; title: string; buyer: string; seller: string };
  milestone: { id: string; title: string; status: string; criteria: { id: string; text: string }[]; amountMinor: number; currency: string };
  plan: Plan;
  challenges: LiveChallenge[];
  failures: string[];
  check: LiveCheck | null;
  error: string | null;
  verdict: { status: string; confidence: number; reasoning: string } | null;
  attemptsLeft: number;
}
interface SubmitResult {
  session: SessionView;
  verdict: { status: string; confidence: number; reasoning: string };
  release: { amountMinor?: number } | null;
}

type Stage = 'loading' | 'ready' | 'camera' | 'recording' | 'uploading' | 'done' | 'closed';

const VERDICT_TONE: Record<string, Tone> = { approved: 'released', rejected: 'refund', needs_more: 'held' };

function pickMime() {
  const options = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  return options.find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) ?? '';
}

export default function LiveCapturePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [view, setView] = useState<SessionView | null>(null);
  const [stage, setStage] = useState<Stage>('loading');
  const [error, setError] = useState<ApiError | { message: string; code?: string } | null>(null);
  const [challenges, setChallenges] = useState<LiveChallenge[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timers = useRef<number[]>([]);

  const apply = useCallback((v: SessionView) => {
    setView(v);
    setStage(v.status === 'open' ? 'ready' : v.status === 'passed' || v.status === 'failed' ? 'done' : 'closed');
  }, []);
  const onLoadError = useCallback((e: ApiError) => {
    setError(e);
    setStage('closed');
  }, []);
  const load = useCallback(() => api<SessionView>('GET', `/api/live/${token}`).then(apply, onLoadError), [token, apply, onLoadError]);

  useEffect(() => {
    const pendingTimers = timers.current;
    const stream = streamRef;
    void api<SessionView>('GET', `/api/live/${token}`).then(apply, onLoadError);
    return () => {
      pendingTimers.forEach((t) => clearTimeout(t));
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, [token, apply, onLoadError]);

  const openCamera = async () => {
    setError(null);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError({ code: 'CAMERA_UNAVAILABLE', message: 'The camera needs a secure page: open this link over HTTPS, or on this computer at localhost.' });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setStage('camera');
    } catch {
      setError({ code: 'CAMERA_DENIED', message: 'Camera access was refused. Allow the camera for this page and try again.' });
    }
  };

  const grab = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const v = videoRef.current!;
      const scale = Math.min(1, 1280 / (v.videoWidth || 1280));
      const c = document.createElement('canvas');
      c.width = Math.round((v.videoWidth || 1280) * scale);
      c.height = Math.round((v.videoHeight || 720) * scale);
      c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
      c.toBlob((b) => (b ? fileToBase64(b).then(resolve, reject) : reject(new Error('frame capture failed'))), 'image/jpeg', 0.82);
    });

  const start = async () => {
    if (!view || !streamRef.current) return;
    setError(null);
    let started: { challenges: LiveChallenge[]; plan: Plan };
    try {
      started = await api('POST', `/api/live/${token}/start`);
    } catch (e) {
      setError(e as ApiError);
      return;
    }
    const plan = started.plan;
    setChallenges(started.challenges);
    const mimeType = pickMime();
    const recorder = new MediaRecorder(streamRef.current, { ...(mimeType && { mimeType }), videoBitsPerSecond: 1_500_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const frames: { slot: string; atMs: number; data: string }[] = [];
    const pending: Promise<void>[] = [];
    const t0 = performance.now();
    recorder.start(1000);
    setStage('recording');
    const tick = () => {
      const ms = performance.now() - t0;
      setElapsed(ms);
      if (ms < plan.durationMs) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    for (const f of plan.frames)
      timers.current.push(
        window.setTimeout(() => {
          const atMs = Math.round(performance.now() - t0);
          pending.push(grab().then((data) => void frames.push({ slot: f.slot, atMs, data })));
        }, f.atMs),
      );
    const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
    timers.current.push(window.setTimeout(() => recorder.stop(), plan.durationMs));
    await stopped;
    await Promise.allSettled(pending);
    streamRef.current.getTracks().forEach((t) => t.stop());
    setStage('uploading');
    try {
      const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
      const r = await api<SubmitResult>('POST', `/api/live/${token}/submit`, { video: await fileToBase64(blob), videoMime: blob.type, frames });
      setResult(r);
      setView(r.session);
      setStage('done');
    } catch (e) {
      setError(e as ApiError);
      await load();
      setStage('done');
    }
  };

  const retry = async () => {
    try {
      const r = await api<{ token: string }>('POST', `/api/live/${token}/retry`);
      setResult(null);
      setChallenges([]);
      setElapsed(0);
      setError(null);
      setStage('loading');
      router.push(`/live/${r.token}`);
    } catch (e) {
      setError(e as ApiError);
    }
  };

  if (stage === 'loading') return <div className="mx-auto max-w-xl space-y-4 px-4 py-10"><Skeleton className="h-10 w-2/3" /><Skeleton className="h-72" /></div>;

  const plan = view?.plan;
  const step = !plan ? -1 : elapsed < plan.wide.toMs ? -1 : plan.windows.findIndex((w) => elapsed >= w.fromMs && elapsed < w.toMs);
  const current = !plan ? null : elapsed < plan.wide.toMs ? { label: 'Get ready', text: plan.wide.text, from: plan.wide.fromMs, to: plan.wide.toMs } : step >= 0 ? { label: `Instruction ${step + 1} of 3`, text: challenges[step]?.text ?? '', from: plan.windows[step].fromMs, to: plan.windows[step].toMs } : { label: 'Almost done', text: 'Keep filming the goods', from: plan.windows[2].toMs, to: plan.durationMs };
  const windowPct = current ? Math.min(100, Math.max(0, ((elapsed - current.from) / (current.to - current.from)) * 100)) : 0;
  const performed = (i: number) => view?.check?.instructions.find((x) => x.index === i + 1);
  const shownChallenges = challenges.length ? challenges : (view?.challenges ?? []);

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-6 sm:py-10">
      <div className="text-[11px] font-semibold tracking-[0.18em] text-muted uppercase">Live video proof</div>
      <h1 className="font-display mt-1 text-3xl leading-tight text-ink">{view?.milestone.title ?? 'Capture link'}</h1>
      {view && (
        <p className="mt-1 text-[14px] text-ink-2">
          {view.pact.title} · {view.pact.seller} → {view.pact.buyer} · <b>{money(view.milestone.amountMinor, view.milestone.currency)}</b> released when verified
        </p>
      )}

      <div className="mt-4">
        <ErrorNote error={error} />
      </div>

      {view && (stage === 'ready' || stage === 'camera' || stage === 'recording') && (
        <>
          {stage === 'ready' && (
            <Card className="mt-4 p-5">
              <h2 className="font-semibold text-ink">How it works</h2>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-[14px] text-ink-2">
                <li>Film the goods for <b>20 seconds</b>. There is no upload: only a live recording counts.</li>
                <li>When you press Start, PACT shows <b>three random instructions</b>, 5 seconds each (for example: lift one item, show two fingers).</li>
                <li>Do each one on camera. Muse checks them, then checks the goods against the order.</li>
              </ol>
              <div className="mt-3 text-[13px] text-muted">The goods must show: {view.milestone.criteria.map((c) => c.text).join(' · ')}</div>
            </Card>
          )}

          <div className="relative mt-4 overflow-hidden rounded-2xl border border-line bg-ink">
            <video ref={videoRef} muted playsInline autoPlay className={cx('aspect-[3/4] w-full object-cover sm:aspect-video', stage === 'ready' && 'opacity-0')} />
            {stage === 'ready' && (
              <div className="absolute inset-0 grid place-items-center p-6 text-center">
                <Button size="lg" onClick={openCamera}>Turn on the camera</Button>
              </div>
            )}
            {stage === 'recording' && current && (
              <div className="absolute inset-x-0 top-0 bg-gradient-to-b from-ink/85 to-transparent p-4 pb-10 text-paper" aria-live="assertive">
                <div className="flex items-center justify-between text-[12px] font-semibold tracking-[0.14em] uppercase">
                  <span>{current.label}</span>
                  <span className="flex items-center gap-1.5"><span className="size-2 animate-pulse rounded-full bg-refund" />REC {Math.min(20, Math.floor(elapsed / 1000))}s / 20s</span>
                </div>
                <div className="font-display mt-2 text-2xl leading-snug sm:text-3xl">{current.text}</div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-paper/25">
                  <div className="h-full rounded-full bg-held" style={{ width: `${windowPct}%` }} />
                </div>
              </div>
            )}
            {stage === 'recording' && (
              <div className="absolute inset-x-0 bottom-0 flex justify-center gap-2 p-3">
                {[0, 1, 2].map((i) => (
                  <span key={i} className={cx('h-1.5 w-10 rounded-full', step > i || elapsed >= (plan?.windows[i].toMs ?? 0) ? 'bg-released' : step === i ? 'bg-held' : 'bg-paper/40')} />
                ))}
              </div>
            )}
          </div>

          {stage === 'camera' && (
            <div className="mt-4 space-y-2">
              <Button size="lg" className="w-full" onClick={start}>Start the 20-second recording</Button>
              <p className="text-center text-[12px] text-muted">Point the camera at all the goods first. The instructions appear once you start.</p>
            </div>
          )}
        </>
      )}

      {stage === 'uploading' && (
        <Card className="mt-6 p-6 text-center">
          <div className="mx-auto size-8 animate-spin rounded-full border-2 border-navy border-r-transparent" aria-hidden />
          <h2 className="font-display mt-4 text-2xl">Checking your recording</h2>
          <p className="mt-1 text-[14px] text-ink-2">Uploading the video, Muse checks the three instructions, then the goods against the order. This takes up to a minute.</p>
        </Card>
      )}

      {stage === 'done' && view && (
        <Card className="mt-6 p-5 sm:p-6">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={view.status === 'passed' ? 'released' : 'refund'} dot>{view.status === 'passed' ? 'Live proof accepted' : 'Live proof refused'}</Badge>
            {(result?.verdict ?? view.verdict) && (
              <Badge tone={VERDICT_TONE[(result?.verdict ?? view.verdict)!.status] ?? 'neutral'}>Verifier: {(result?.verdict ?? view.verdict)!.status.replace('_', ' ')}</Badge>
            )}
          </div>
          {shownChallenges.length > 0 && (
            <ul className="mt-4 space-y-2">
              {shownChallenges.map((c, i) => {
                const r = performed(i);
                return (
                  <li key={c.id} className="flex gap-3 rounded-xl border border-line-2 bg-paper p-3">
                    <span className={cx('grid size-6 shrink-0 place-items-center rounded-full text-[13px] font-bold text-white', r?.performed ? 'bg-released' : 'bg-refund')} aria-hidden>
                      {r?.performed ? '✓' : '✗'}
                    </span>
                    <div className="min-w-0 text-[14px]">
                      <div className="font-medium text-ink">{c.text}</div>
                      {r && <div className="text-[13px] text-muted">{r.observation}</div>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {!view.check && view.failures.length > 0 && (
            <ul className="mt-4 list-disc space-y-1 pl-5 text-[14px] text-refund">
              {view.failures.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
          {view.status === 'passed' && (result?.verdict ?? view.verdict) && <p className="mt-4 text-[14px] text-ink-2">{(result?.verdict ?? view.verdict)!.reasoning}</p>}
          {view.status !== 'passed' && view.check && <p className="mt-4 text-[14px] text-ink-2">{view.check.reasoning} The goods are judged once all three instructions are seen on camera.</p>}
          {result?.release && <p className="mt-2 font-semibold text-released">{money(view.milestone.amountMinor, view.milestone.currency)} released to {view.pact.seller}.</p>}
          <div className="mt-5 flex flex-wrap gap-2">
            {view.status !== 'passed' && view.attemptsLeft > 0 && <Button onClick={retry}>Try again with new instructions</Button>}
            <Link href={`/pacts/${view.pact.id}?milestone=${view.milestone.id}`} className="inline-flex h-10 items-center rounded-full border border-line bg-surface px-4 text-sm text-ink hover:border-ink/30">
              Open the pact
            </Link>
          </div>
          {view.status !== 'passed' && view.attemptsLeft === 0 && <p className="mt-3 text-[13px] text-muted">No attempts left on this milestone: open a dispute from the pact so the Arbiter or a person decides.</p>}
        </Card>
      )}

      {stage === 'closed' && view && (
        <Card className="mt-6 p-5">
          <h2 className="font-display text-2xl">{view.status === 'expired' ? 'This link has expired' : 'This link was already used'}</h2>
          <p className="mt-1 text-[14px] text-ink-2">{view.error ?? 'Each capture link works once, for 30 minutes.'}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {view.attemptsLeft > 0 && ['expired', 'error'].includes(view.status) && <Button onClick={retry}>Get a new link</Button>}
            <Link href={`/pacts/${view.pact.id}`} className="inline-flex h-10 items-center rounded-full border border-line bg-surface px-4 text-sm text-ink hover:border-ink/30">Open the pact</Link>
          </div>
        </Card>
      )}
    </div>
  );
}
