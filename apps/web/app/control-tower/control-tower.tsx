'use client';
// The PACT Control Tower: one AG Studio instance over PACT's ledger, kept live by the API's SSE
// feed (new rows are pushed into Studio's sync data sources), with PACT's custom widgets, the PACT
// theme (light + dark modes), page navigation, edit mode with saved layouts, and the PACT Auditor.
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AgStudioAiModule, enableStudioDevValidations, type AgReportState, type AgStudioApi, type AgStudioMode } from 'ag-studio';
import { AgStudio, AgStudioProvider } from 'ag-studio-react';
import { api, API_URL, useEvents, useLiveConnection } from '@/lib/api';
import { ChainBadge } from '@/components/pact-parts';
import { Badge, Button, ErrorNote, Skeleton, cx } from '@/components/ui';
import { buildAi } from './studio/ai';
import { buildStudioData, type DashboardPayload, type ReconciliationPayload } from './studio/data';
import { initialReport, PAGE_TITLES } from './studio/initial-report';
import { PACT_THEME_MODES, pactStudioTheme } from './studio/theme';
import { buildWidgets } from './studio/widgets';
import type { TowerContext } from './studio/widgets/common';

if (process.env.NODE_ENV !== 'production') enableStudioDevValidations();

const STORAGE_KEY = 'pact-control-tower-report-v1';

// The PACT Auditor's tools read the latest context lazily (one Control Tower per page).
let liveContext: TowerContext | null = null;
const loadSaved = (): AgReportState | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AgReportState) : null;
  } catch {
    return null;
  }
};
const save = (s: AgReportState) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
};

function useThemeMode() {
  return useSyncExternalStore(
    (cb) => {
      const mq = matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener('change', cb);
      window.addEventListener('pact-theme', cb);
      return () => {
        mq.removeEventListener('change', cb);
        window.removeEventListener('pact-theme', cb);
      };
    },
    () => (document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) as 'light' | 'dark',
    () => 'light' as const,
  );
}

export function ControlTower({ licenseKey, aiEnabled }: { licenseKey?: string; aiEnabled: boolean }) {
  const router = useRouter();
  const [dash, setDash] = useState<DashboardPayload | null>(null);
  const [rec, setRec] = useState<ReconciliationPayload | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [mode, setMode] = useState<AgStudioMode>('view');
  const [pageId, setPageId] = useState('overview');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [initialState] = useState<AgReportState>(() => (typeof window !== 'undefined' && loadSaved()) || initialReport());
  const apiRef = useRef<AgStudioApi | null>(null);
  const live = useLiveConnection();
  const theme = useThemeMode();

  // Studio reads its colour mode from data-ag-theme-mode on <html>.
  useEffect(() => {
    document.documentElement.dataset.agThemeMode = theme === 'dark' ? PACT_THEME_MODES.dark : PACT_THEME_MODES.light;
  }, [theme]);

  const loadDash = useCallback(() => api<DashboardPayload>('GET', '/api/dashboard').then(setDash).catch(setError), []);
  const loadRec = useCallback(() => api<ReconciliationPayload>('GET', '/api/reconciliation').then(setRec).catch(() => setRec(null)), []);
  useEffect(() => {
    void loadDash();
    void loadRec();
    const t = setInterval(loadRec, 60_000);
    return () => clearInterval(t);
  }, [loadDash, loadRec]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEvents(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(loadDash, 350);
  });

  // Data structure is fixed at init; later calls only replace rows (Studio's sync-data reload).
  const data = useMemo(() => (dash ? buildStudioData(dash, rec) : undefined), [dash, rec]);
  const widgets = useMemo(() => buildWidgets(), []);

  const context = useMemo<TowerContext | null>(
    () =>
      dash && {
        apiUrl: API_URL,
        asOf: dash.asOf,
        paymentMode: dash.paymentMode,
        llmMode: dash.llmMode,
        audit: dash.audit,
        reconciliation: rec && { asOf: rec.asOf, caveat: rec.caveat, balances: rec.balances, errors: rec.errors, pending: rec.notYetInTransactionSearch.length },
        openPact: (pactId, milestoneId) => router.push(`/pacts/${pactId}${milestoneId ? `?milestone=${milestoneId}` : ''}`),
        appeal: async (verdictId) => {
          await api('POST', `/api/verdicts/${verdictId}/appeal`, { party: 'buyer', note: 'Appeal requested from the Control Tower.' });
        },
      },
    [dash, rec, router],
  );
  useEffect(() => {
    liveContext = context;
  }, [context]);
  const ai = useMemo(() => (aiEnabled ? buildAi(() => liveContext!) : undefined), [aiEnabled]);
  const modules = useMemo(() => (aiEnabled ? [AgStudioAiModule] : undefined), [aiEnabled]);
  const style = useMemo(() => ({ height: '100%', width: '100%' }), []);
  // Every non-primitive Studio prop must keep its reference between renders.
  const layout = useMemo(() => ({ widgetBorderEnabled: true }), []);

  const goTo = (id: string) => {
    const a = apiRef.current;
    if (!a) return;
    a.setState({ ...a.getState(), selectedPageId: id });
    setPageId(id);
  };

  if (error) return <div className="p-10"><ErrorNote error={error} /></div>;

  return (
    <div className="flex h-[calc(100vh-88px)] min-h-[640px] flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface/60 px-4 py-2.5 sm:px-6">
        <div className="mr-2">
          <div className="text-[10.5px] font-semibold tracking-[0.18em] text-muted uppercase">Control Tower</div>
          <div className="font-display text-lg leading-tight">PACT escrow, live</div>
        </div>
        <nav className="flex flex-wrap gap-1" aria-label="Dashboard pages">
          {Object.entries(PAGE_TITLES).map(([id, t]) => (
            <button key={id} onClick={() => goTo(id)} aria-current={pageId === id ? 'page' : undefined} className={cx('rounded-full px-3 py-1 text-[13px]', pageId === id ? 'bg-ink text-paper' : 'text-ink-2 hover:bg-paper-2')}>
              {t}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-[12px] text-muted">
            <span className={cx('size-1.5 rounded-full', live ? 'animate-pulse bg-released' : 'bg-void')} />
            {live ? 'live' : 'offline'} · {dash ? new Date(dash.asOf).toLocaleTimeString() : '—'}
          </span>
          <ChainBadge />
          {dash?.paymentMode === 'simulated' && <Badge tone="held">SIMULATED PayPal</Badge>}
          {dash?.llmMode === 'replay' && <Badge tone="held">Replay: recorded responses</Badge>}
          {!licenseKey && <Badge tone="neutral">No AG Studio licence (watermark)</Badge>}
          <Button size="sm" variant={mode === 'edit' ? 'primary' : 'secondary'} onClick={() => setMode((m) => (m === 'edit' ? 'view' : 'edit'))} aria-pressed={mode === 'edit'}>
            {mode === 'edit' ? 'Done editing' : 'Edit layout'}
          </Button>
          {mode === 'edit' && (
            <>
              <Button size="sm" variant="secondary" onClick={() => apiRef.current && save(apiRef.current.getState()) && setSavedAt(new Date().toLocaleTimeString())}>
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  try {
                    localStorage.removeItem(STORAGE_KEY);
                  } catch {
                    /* ignore */
                  }
                  apiRef.current?.setState(initialReport());
                  setPageId('overview');
                }}
              >
                Reset
              </Button>
            </>
          )}
          {savedAt && <span className="text-[12px] text-released">saved {savedAt}</span>}
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {!data || !context ? (
          <div className="grid grid-cols-3 gap-4 p-6">
            <Skeleton className="h-48" />
            <Skeleton className="h-48" />
            <Skeleton className="h-48" />
            <Skeleton className="col-span-3 h-56" />
          </div>
        ) : (
          <AgStudioProvider licenseKey={licenseKey} modules={modules}>
            <AgStudio
              style={style}
              theme={pactStudioTheme}
              data={data}
              widgets={widgets as never}
              context={context}
              ai={ai}
              initialState={initialState}
              mode={mode}
              layout={layout}
              onApiReady={(e) => {
                apiRef.current = e.api;
              }}
              onStateUpdated={(e) => setPageId(e.state.selectedPageId)}
            />
          </AgStudioProvider>
        )}
      </div>
    </div>
  );
}
