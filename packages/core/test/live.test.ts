import { describe, expect, it } from 'vitest';
import { LIVE_CHALLENGES, LIVE_PLAN, liveCheckFailures, pickChallenges } from '../src/index';

const seq = (...xs: number[]) => {
  let i = 0;
  return () => xs[i++ % xs.length];
};

describe('live video proof', () => {
  it('draws three distinct instructions from the pool', () => {
    for (let k = 0; k < 50; k++) {
      const c = pickChallenges(Math.random);
      expect(c).toHaveLength(3);
      expect(new Set(c.map((x) => x.id)).size).toBe(3);
      expect(c.every((x) => LIVE_CHALLENGES.some((y) => y.id === x.id))).toBe(true);
    }
    expect(pickChallenges(seq(0, 0, 0)).map((c) => c.id)).toEqual(['lift', 'two-fingers', 'three-fingers']);
  });

  it('plans a 20-second recording: a wide shot, then three 5-second windows with two frames each', () => {
    expect(LIVE_PLAN.durationMs).toBe(20_000);
    for (const [i, w] of LIVE_PLAN.windows.entries()) {
      expect(w.toMs - w.fromMs).toBe(5_000);
      const frames = LIVE_PLAN.frames.filter((f) => f.challenge === i);
      expect(frames).toHaveLength(2);
      expect(frames.every((f) => f.atMs > w.fromMs && f.atMs < w.toMs)).toBe(true);
    }
  });

  it('passes only when every instruction is performed with confidence, in one scene', () => {
    const challenges = pickChallenges(seq(0, 0, 0));
    const ok = { instructions: [1, 2, 3].map((index) => ({ index, performed: true, confidence: 0.9, observation: 'seen' })), sameScene: true, reasoning: '' };
    expect(liveCheckFailures(ok, challenges)).toEqual([]);
    expect(liveCheckFailures({ ...ok, instructions: ok.instructions.map((x) => (x.index === 3 ? { ...x, confidence: 0.5 } : x)) }, challenges)[0]).toMatch(/Instruction 3/);
    expect(liveCheckFailures({ ...ok, instructions: ok.instructions.slice(0, 2) }, challenges)[0]).toMatch(/Instruction 3 .* was not assessed/);
    expect(liveCheckFailures({ ...ok, sameScene: false }, challenges)).toEqual(['The frames do not look like one continuous recording of the same goods.']);
  });
});
