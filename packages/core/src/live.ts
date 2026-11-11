// Live video proof: instead of uploading a file, the seller films the goods for 20 seconds through a
// one-time link, while PACT shows three random instructions that must be performed on camera.
// Frames taken at fixed moments of the recording are checked by Muse, instruction by instruction.
import { z } from 'zod';

/** Instructions that can be done with one hand while filming with the other, for any goods. */
export const LIVE_CHALLENGES = [
  { id: 'lift', text: 'Lift one item up towards the camera' },
  { id: 'two-fingers', text: 'Show two fingers (a V sign) next to the goods' },
  { id: 'three-fingers', text: 'Show three fingers next to the goods' },
  { id: 'thumb-up', text: 'Give a thumbs-up next to the goods' },
  { id: 'flat-hand', text: 'Put your open hand flat on top of the goods' },
  { id: 'point', text: 'Point at one item with one finger' },
  { id: 'close-up', text: 'Move in close on one item until it fills the screen' },
  { id: 'turn', text: 'Turn one item around or over' },
  { id: 'side', text: 'Film the goods from the side' },
] as const;
export type LiveChallengeId = (typeof LIVE_CHALLENGES)[number]['id'];
export interface LiveChallenge {
  id: LiveChallengeId;
  text: string;
}

/** Recording plan, in milliseconds from the start: a wide shot, then three 5-second instructions. */
export const LIVE_PLAN = {
  durationMs: 20_000,
  wide: { fromMs: 0, toMs: 4_000, text: 'Film all the goods' },
  windows: [
    { fromMs: 4_000, toMs: 9_000 },
    { fromMs: 9_000, toMs: 14_000 },
    { fromMs: 14_000, toMs: 19_000 },
  ],
  /** When frames are taken: one in the wide shot, two inside each instruction window. */
  frames: [
    { slot: 'wide', atMs: 2_000, challenge: null },
    { slot: 'c1a', atMs: 7_000, challenge: 0 },
    { slot: 'c1b', atMs: 8_500, challenge: 0 },
    { slot: 'c2a', atMs: 12_000, challenge: 1 },
    { slot: 'c2b', atMs: 13_500, challenge: 1 },
    { slot: 'c3a', atMs: 17_000, challenge: 2 },
    { slot: 'c3b', atMs: 18_500, challenge: 2 },
  ] as { slot: string; atMs: number; challenge: number | null }[],
  /** Frames that also become photo evidence for the milestone criteria. */
  evidenceSlots: ['wide', 'c1b', 'c2b', 'c3b'],
  /** The upload must arrive within this time after the recording started (recording + upload). */
  submitWithinMs: 20_000 + 90_000,
  linkValidMs: 30 * 60_000,
  maxFailedAttempts: 3,
} as const;

/** Three distinct instructions; `random` returns a float in [0, 1) (crypto-backed on the server). */
export function pickChallenges(random: () => number, n = 3): LiveChallenge[] {
  const pool = [...LIVE_CHALLENGES];
  const out: LiveChallenge[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
  return out;
}

export const LiveCheck = z.object({
  instructions: z.array(
    z.object({
      index: z.number().int().describe('1, 2 or 3'),
      performed: z.boolean(),
      confidence: z.number().min(0).max(1),
      observation: z.string().describe('What the frames of this window show, in one sentence'),
    }),
  ),
  sameScene: z.boolean().describe('All frames come from one continuous recording of the same place and goods'),
  reasoning: z.string().describe('One or two sentences for the seller and the buyer'),
});
export type LiveCheck = z.infer<typeof LiveCheck>;

export const LIVE_PASS_CONFIDENCE = 0.7;

/** Deterministic policy over the model's answer: every instruction performed with confidence, one scene. */
export function liveCheckFailures(check: LiveCheck, challenges: LiveChallenge[]): string[] {
  const failures: string[] = [];
  challenges.forEach((c, i) => {
    const r = check.instructions.find((x) => x.index === i + 1);
    if (!r) failures.push(`Instruction ${i + 1} ("${c.text}") was not assessed.`);
    else if (!r.performed || r.confidence < LIVE_PASS_CONFIDENCE) failures.push(`Instruction ${i + 1} ("${c.text}") was not seen on camera: ${r.observation}`);
  });
  if (!check.sameScene) failures.push('The frames do not look like one continuous recording of the same goods.');
  return failures;
}
