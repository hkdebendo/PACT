'use client';
// Browser client for the PACT API (apps/api) plus a shared Server-Sent Events connection.
// `useLive(path)` fetches JSON and re-fetches whenever a relevant SSE event arrives.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PactEventMessage } from '@pact/core/browser';

export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

let actor = 'web:visitor';
export const setActor = (a: string) => {
  actor = a;
};

export async function api<T = unknown>(method: 'GET' | 'POST', path: string, body?: unknown, opts: { idempotencyKey?: string } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        ...(body !== undefined && { 'content-type': 'application/json' }),
        'x-pact-actor': actor,
        ...(opts.idempotencyKey && { 'idempotency-key': opts.idempotencyKey }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'API_UNREACHABLE', `The PACT API is not reachable at ${API_URL}. Is "npm run dev" running?`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json.error ?? 'ERROR', json.message ?? res.statusText, json.details);
  return json as T;
}

export const fileToBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

// --- SSE ------------------------------------------------------------------------------

type Listener = (e: PactEventMessage) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;
let connected = false;
const connListeners = new Set<() => void>();

function ensureSource() {
  if (source || typeof window === 'undefined') return;
  source = new EventSource(`${API_URL}/api/events`);
  const setConnected = (v: boolean) => {
    connected = v;
    connListeners.forEach((l) => l());
  };
  source.addEventListener('hello', () => setConnected(true));
  source.onerror = () => setConnected(false);
  for (const type of ['pact.updated', 'audit.appended', 'verdict.created', 'payment.updated']) {
    source.addEventListener(type, (ev) => {
      try {
        const msg = JSON.parse((ev as MessageEvent).data) as PactEventMessage;
        listeners.forEach((l) => l(msg));
      } catch {
        /* ignore malformed */
      }
    });
  }
}

export function useEvents(listener: Listener) {
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => {
    ensureSource();
    const l: Listener = (e) => ref.current(e);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
}

export function useLiveConnection() {
  return useSyncExternalStore(
    (cb) => {
      ensureSource();
      connListeners.add(cb);
      return () => connListeners.delete(cb);
    },
    () => connected,
    () => false,
  );
}

export interface Live<T> {
  data: T | undefined;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

/** Fetch + live refresh. `filter` decides which SSE events trigger a reload (default: all). */
export function useLive<T>(path: string | null, filter?: (e: PactEventMessage) => boolean): Live<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    if (!path) return;
    api<T>('GET', path)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: ApiError) => setError(e))
      .finally(() => setLoading(false));
  }, [path]);

  useEffect(() => {
    load();
  }, [load]);

  useEvents((e) => {
    if (filter && !filter(e)) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(load, 200);
  });

  return { data, error, loading, reload: load };
}
