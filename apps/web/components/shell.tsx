'use client';
// App chrome: brand seal, navigation, the honest runtime-mode banner and the theme toggle.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSyncExternalStore } from 'react';
import { useLive, useLiveConnection } from '@/lib/api';
import { cx } from './ui';

export interface RuntimeStatus {
  paymentMode: 'sandbox' | 'simulated';
  paypalSimulatedReason: string | null;
  llmMode: 'live' | 'replay';
  llmModel: string;
  llmLiveAvailable: boolean;
  agStudioLicense: boolean;
  webhookVerification: boolean;
}

export function Seal({ size = 30, className }: { size?: number; className?: string }) {
  // An original mark: a notary seal with a stylised clasp. No third-party marks.
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" className={className} aria-hidden>
      <circle cx="20" cy="20" r="18" fill="var(--pact-navy)" />
      <circle cx="20" cy="20" r="14.5" fill="none" stroke="var(--pact-paper)" strokeOpacity=".35" strokeDasharray="1.6 2.2" />
      <path d="M13 21.5c2.2 2.6 4.4 3.9 7 3.9s4.8-1.3 7-3.9M15 16.5h10" stroke="var(--pact-paper)" strokeWidth="2.4" strokeLinecap="round" fill="none" />
      <circle cx="20" cy="16.5" r="2.4" fill="var(--pact-held)" />
    </svg>
  );
}

const NAV = [
  { href: '/pacts/new', label: 'New pact', short: 'New' },
  { href: '/pacts', label: 'Pacts', short: 'Pacts' },
  { href: '/control-tower', label: 'Control Tower', short: 'Tower' },
  { href: '/agents', label: 'Agents', short: 'Agents' },
  { href: '/admin', label: 'Admin', short: 'Admin' },
];

const readTheme = (): 'light' | 'dark' =>
  (document.documentElement.dataset.theme as 'light' | 'dark' | undefined) ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const subscribeTheme = (cb: () => void) => {
  window.addEventListener('pact-theme', cb);
  const mq = matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', cb);
  return () => {
    window.removeEventListener('pact-theme', cb);
    mq.removeEventListener('change', cb);
  };
};

function ThemeToggle() {
  // The saved theme is applied before paint by the inline script in app/layout.tsx.
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => null);
  const flip = () => {
    const t = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem('pact-theme', t);
    } catch {
      /* private mode */
    }
    window.dispatchEvent(new CustomEvent('pact-theme', { detail: t }));
  };
  return (
    <button onClick={flip} className="grid size-9 place-items-center rounded-full text-ink-2 hover:bg-paper-2" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
      {theme === 'dark' ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
      )}
    </button>
  );
}

/** Honest labelling of what is real and what is simulated, visible on every page. */
export function ModeBanner() {
  const { data, error } = useLive<RuntimeStatus>('/api/status', () => false);
  const live = useLiveConnection();
  if (error) return <div className="bg-refund px-4 py-1.5 text-center text-[12px] text-white">PACT API unreachable ({error.message}). Start it with <code className="hash">npm run dev</code>.</div>;
  if (!data) return <div className="h-7" />;
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1 border-b border-line bg-paper-2/70 px-4 py-1.5 text-[12px] text-ink-2">
      <span className="inline-flex items-center gap-1.5">
        <span className={cx('size-1.5 rounded-full', data.paymentMode === 'sandbox' ? 'bg-released' : 'bg-held')} />
        {data.paymentMode === 'sandbox' ? (
          <>PayPal: <b>real sandbox</b></>
        ) : (
          <>PayPal: <b>SIMULATED adapter</b> — not real PayPal ({data.paypalSimulatedReason})</>
        )}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className={cx('size-1.5 rounded-full', data.llmMode === 'live' ? 'bg-released' : 'bg-held')} />
        AI: {data.llmModel} {data.llmMode === 'replay' ? <b>Replay mode: recorded model responses</b> : <b>live</b>}
        {data.llmMode === 'live' && !data.llmLiveAvailable && <span className="text-refund">(META_API_KEY missing)</span>}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className={cx('size-1.5 rounded-full', live ? 'bg-released animate-pulse' : 'bg-void')} />
        {live ? 'Live feed' : 'Live feed offline'}
      </span>
    </div>
  );
}

export function TopNav() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-paper/85 backdrop-blur">
      <ModeBanner />
      <nav className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-4 sm:px-6" aria-label="Main">
        <Link href="/" className="mr-1 flex shrink-0 items-center gap-2.5 sm:mr-4" aria-label="PACT home">
          <Seal />
          <span className="hidden font-display text-xl tracking-tight text-ink sm:inline">PACT</span>
        </Link>
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto sm:gap-1">
          {NAV.map((n) => {
            const active = n.href === '/pacts' ? path === '/pacts' || (path.startsWith('/pacts/') && path !== '/pacts/new') : path.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? 'page' : undefined}
                className={cx('rounded-full px-1.5 py-1.5 text-[12.5px] whitespace-nowrap transition-colors min-[400px]:px-2 sm:px-3 sm:text-sm', active ? 'bg-ink text-paper' : 'text-ink-2 hover:bg-paper-2')}
              >
                <span className="hidden sm:inline">{n.label}</span>
                <span className="sm:hidden">{n.short}</span>
              </Link>
            );
          })}
        </div>
        <ThemeToggle />
      </nav>
    </header>
  );
}
