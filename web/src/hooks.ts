import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type ScanTask } from './api';

export interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
}

/** Minimal async hook: keeps the last successful value while a reload is in flight. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loaderRef
      .current()
      .then((value) => {
        if (cancelled) return;
        setData(value);
        setError(null);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, error, loading, reload };
}

export interface ScanSelection {
  scanId: string | null;
  setScanId: (id: string) => void;
  scans: ScanTask[];
  loading: boolean;
  error: Error | null;
  current: ScanTask | null;
}

/**
 * Resolves the scan a page works on. Pages can be opened either globally
 * (/findings picks the newest completed scan) or scoped (/scans/:id/findings).
 */
export function useScanSelection(explicitId?: string): ScanSelection {
  const { data, error, loading } = useAsync(() => api.listScans(undefined, 60), []);
  const scans = useMemo(() => data?.items ?? [], [data]);
  const [picked, setPicked] = useState<string | null>(explicitId ?? null);

  useEffect(() => {
    if (explicitId) {
      setPicked(explicitId);
      return;
    }
    if (picked && scans.some((scan) => scan.id === picked)) return;
    const preferred =
      scans.find((scan) => scan.status === 'COMPLETED') ??
      scans.find((scan) => scan.status === 'COMPLETED_WITH_WARNINGS') ??
      scans[0];
    setPicked(preferred?.id ?? null);
  }, [explicitId, scans, picked]);

  const current = scans.find((scan) => scan.id === picked) ?? null;
  return { scanId: picked, setScanId: setPicked, scans, loading, error, current };
}

export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
