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
import { fetchScan, type SentinelScan } from './studio/widgets/sentinel';
import './tower.css';

if (process.env.NODE_ENV !== 'production') enableStudioDevValidations();

const ico = (d: React.ReactNode) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d}
  </svg>
);
const PAGE_ICONS: Record<string, React.ReactNode> = {
  overview: ico(<><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>),
  verdicts: ico(<><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" /><path d="M9 12l2 2 4-4" /></>),
  reputation: ico(<><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" /></>),
  reconciliation: ico(<><path d="M4 7h12l-3-3M20 17H8l3 3" /></>),
  sentinel: ico(<><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4.5" /><path d="M12 12l5.5-5.5" /></>),
};
const SPARK = ico(<><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></>);
const PENCIL = ico(<><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></>);

const STORAGE_KEY = 'pact-control-tower-report-v3';

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

  // The Sentinel's rules re-run with every ledger refresh; the toolbar shows the result.
  const [risk, setRisk] = useState<SentinelScan | null>(null);
  useEffect(() => {
    if (!dash) return;
    const ac = new AbortController();
    fetchScan(API_URL, ac.signal)
      .then(setRisk)
      .catch(() => {});
    return () => ac.abort();
  }, [dash]);

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
        openPact: (pactId, milestoneId, opts) => {
          const url = `/pacts/${pactId}${milestoneId ? `?milestone=${milestoneId}` : ''}`;
          if (opts?.newTab) window.open(url, '_blank', 'noopener');
          else router.push(url);
        },
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
  const localeText = useMemo(() => ({ panelTitleAi: 'PACT agents', aiMessageInputPlaceholder: 'Ask the PACT Auditor…' }), []);

  // Studio shows its AI panel in edit mode: open it with the Compose and Data panels folded away.
  const askAuditor = () => {
    setMode('edit');
    setTimeout(() => {
      const a = apiRef.current;
      if (!a) return;
      const s = a.getState();
      a.setState({ ...s, panels: { ...s.panels, edit: { collapsed: true }, data: { collapsed: true }, filters: { collapsed: true }, ai: { collapsed: false } } } as AgReportState);
    }, 60);
  };

  const goTo = (id: string) => {
    const a = apiRef.current;
    if (!a) return;
    a.setState({ ...a.getState(), selectedPageId: id });
    setPageId(id);
  };

  if (error) return <div className="p-10"><ErrorNote error={error} /></div>;

  return (
    <div className="pact-tower flex h-[calc(100vh-88px)] min-h-[640px] flex-col">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-line bg-surface/70 px-4 py-3 backdrop-blur sm:px-6">
        <div className="flex items-center gap-3">
          <div>
            <div className="text-[10.5px] font-semibold tracking-[0.18em] text-muted uppercase">Control Tower</div>
            <div className="font-display text-[19px] leading-tight">PACT escrow, live</div>
          </div>
        </div>
        <nav className="pact-tabs max-w-full overflow-x-auto" aria-label="Dashboard pages">
          {Object.entries(PAGE_TITLES).map(([id, t]) => (
            <button key={id} onClick={() => goTo(id)} aria-current={pageId === id ? 'page' : undefined} className="pact-tab">
              {PAGE_ICONS[id]}
              {t}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line-2 bg-paper/60 px-3 text-[12px] text-muted tabular-nums" title="Last update from the PACT API's live feed">
            <span className={cx('size-1.5 rounded-full', live ? 'animate-pulse bg-released' : 'bg-void')} />
            {live ? 'Live' : 'Offline'} · {dash ? new Date(dash.asOf).toLocaleTimeString('en-GB') : '—'}
          </span>
          <ChainBadge />
          {risk && (
            <button
              onClick={() => goTo('sentinel')}
              className={cx(
                'inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium whitespace-nowrap transition-opacity hover:opacity-80',
                risk.status === 'critical' ? 'bg-refund-soft text-refund' : risk.status === 'warning' ? 'bg-held-soft text-held' : 'bg-released-soft text-released',
              )}
              title={risk.anomalies.map((a) => `${a.severity}: ${a.title}`).join(' · ') || 'Every Sentinel rule passed'}
            >
              <span className={cx('size-1.5 rounded-full bg-current', risk.status !== 'clear' && 'animate-pulse')} />
              Sentinel · {risk.anomalies.length ? `${risk.anomalies.length} finding${risk.anomalies.length === 1 ? '' : 's'}` : 'all clear'}
            </button>
          )}
          {dash?.paymentMode === 'simulated' && <Badge tone="held">SIMULATED PayPal</Badge>}
          {dash?.llmMode === 'replay' && <Badge tone="held">Replay: recorded responses</Badge>}
          {!licenseKey && <Badge tone="neutral">No AG Studio licence (watermark)</Badge>}
          <span className="mx-1 hidden h-6 w-px bg-line sm:block" aria-hidden />
          {aiEnabled && mode === 'view' && (
            <Button size="sm" onClick={askAuditor}>
              {SPARK}
              Ask the PACT Auditor
            </Button>
          )}
          <Button size="sm" variant={mode === 'edit' ? 'primary' : 'secondary'} onClick={() => setMode((m) => (m === 'edit' ? 'view' : 'edit'))} aria-pressed={mode === 'edit'}>
            {mode === 'edit' ? null : PENCIL}
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
          <div className="grid grid-cols-4 gap-[18px] p-[27px]">
            <Skeleton className="h-[126px] rounded-2xl" />
            <Skeleton className="h-[126px] rounded-2xl" />
            <Skeleton className="h-[126px] rounded-2xl" />
            <Skeleton className="h-[126px] rounded-2xl" />
            <Skeleton className="col-span-2 h-64 rounded-2xl" />
            <Skeleton className="col-span-2 h-64 rounded-2xl" />
            <Skeleton className="col-span-4 h-72 rounded-2xl" />
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
              localeText={localeText}
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
