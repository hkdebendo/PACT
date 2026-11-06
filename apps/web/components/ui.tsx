// Small shadcn-style primitives (Tailwind, no runtime dependency): Button, Card, Badge, Field.
import clsx from 'clsx';
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';

export const cx = clsx;

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-full font-medium transition-[background,box-shadow,transform,opacity] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' && 'h-8 px-3 text-[13px]',
        size === 'md' && 'h-10 px-4 text-sm',
        size === 'lg' && 'h-12 px-6 text-[15px]',
        variant === 'primary' && 'bg-navy text-paper shadow-card hover:bg-navy-2',
        variant === 'secondary' && 'border border-line bg-surface text-ink hover:border-ink/30',
        variant === 'ghost' && 'text-ink-2 hover:bg-paper-2',
        variant === 'danger' && 'bg-refund text-white hover:opacity-90',
        variant === 'success' && 'bg-released text-white hover:opacity-90',
        className,
      )}
    >
      {loading && <span className="size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden />}
      {children}
    </button>
  );
}

export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cx('rounded-2xl border border-line bg-surface shadow-card', className)}>
      {children}
    </div>
  );
}

export type Tone = 'neutral' | 'held' | 'released' | 'refund' | 'navy' | 'void';

export function Badge({ tone = 'neutral', children, className, dot }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-medium whitespace-nowrap',
        tone === 'neutral' && 'bg-paper-2 text-ink-2',
        tone === 'held' && 'bg-held-soft text-held',
        tone === 'released' && 'bg-released-soft text-released',
        tone === 'refund' && 'bg-refund-soft text-refund',
        tone === 'navy' && 'bg-navy text-paper',
        tone === 'void' && 'bg-paper-2 text-void',
        className,
      )}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

export function SectionTitle({ eyebrow, title, action }: { eyebrow?: string; title: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        {eyebrow && <div className="mb-1 text-[11px] font-semibold tracking-[0.18em] text-muted uppercase">{eyebrow}</div>}
        <h2 className="font-display text-2xl text-ink">{title}</h2>
      </div>
      {action}
    </div>
  );
}

export function ErrorNote({ error }: { error: { message: string; code?: string } | null | undefined }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded-xl border border-refund/30 bg-refund-soft px-4 py-3 text-sm text-refund">
      {error.code && <span className="hash mr-2 font-semibold">{error.code}</span>}
      {error.message}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-xl bg-paper-2', className)} aria-hidden />;
}

export const MILESTONE_TONE: Record<string, Tone> = {
  pending: 'neutral',
  evidence_submitted: 'navy',
  approved: 'released',
  rejected: 'refund',
  needs_more: 'held',
  released: 'released',
  disputed: 'refund',
  partially_released: 'held',
  refunded: 'refund',
  voided: 'void',
};

export const PACT_TONE: Record<string, Tone> = {
  draft: 'neutral',
  proposed: 'neutral',
  funded: 'held',
  in_progress: 'held',
  disputed: 'refund',
  completed: 'released',
  closed: 'released',
  cancelled: 'void',
  expired: 'void',
};

export const label = (s: string) => s.replace(/_/g, ' ');

export const money = (minor: number, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: minor % 100 === 0 ? 0 : 2 }).format(minor / 100);
