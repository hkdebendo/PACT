import type { Metadata } from 'next';
import { Composer } from './composer';

export const metadata: Metadata = { title: 'New pact' };

export default function NewPactPage() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6">
      <div className="mb-8 max-w-2xl">
        <div className="text-[11px] font-semibold tracking-[0.18em] text-muted uppercase">New pact</div>
        <h1 className="font-display mt-2 text-4xl text-ink">Write the deal. Muse drafts the contract.</h1>
        <p className="mt-3 text-[15px] text-ink-2">Ambiguous deals come back with questions instead of guesses. You can edit every field before proposing it to the seller.</p>
      </div>
      <Composer />
    </div>
  );
}
