import { useEffect, useRef, useState } from 'react';
import { api, type ScanPhase, type ScanTask } from '../api';
import { useI18n } from '../i18n';
import { Spinner } from './ui';

export interface ScanProgressState {
  scannedFiles: number;
  totalFiles: number;
  parsedFiles: number;
  failedFiles: number;
  findings: number;
  currentFile: string | null;
}

interface StreamEvent {
  scanId: string;
  type: 'status' | 'phase' | 'progress' | 'log' | 'done' | 'error';
  at: string;
  status?: ScanTask['status'];
  phase?: ScanPhase | null;
  message?: string;
  level?: 'info' | 'warn' | 'error';
  progress?: ScanProgressState;
  error?: string;
}

export interface LogEntry {
  at: string;
  level: string;
  phase: string | null;
  message: string;
}

/**
 * Subscribes to the scan SSE stream and mirrors it into React state.
 * When the stream closes on completion the scan record is re-fetched from the API,
 * so the page always ends up with the persisted snapshot rather than a UI guess.
 */
export function useScanStream(scanId: string | null, initial: ScanTask | null): {
  scan: ScanTask | null;
  progress: ScanProgressState | null;
  logs: LogEntry[];
  live: boolean;
} {
  const [scan, setScan] = useState<ScanTask | null>(initial);
  const [progress, setProgress] = useState<ScanProgressState | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [live, setLive] = useState(false);
  const finishedRef = useRef(false);

  useEffect(() => {
    setScan(initial);
    if (!initial) return;
    setProgress({
      scannedFiles: initial.scannedFileCount,
      totalFiles: initial.totalFileCount || initial.scannedFileCount,
      parsedFiles: initial.parsedFileCount,
      failedFiles: initial.failedFileCount,
      findings: initial.findingCount,
      currentFile: initial.currentFile,
    });
  }, [initial]);

  useEffect(() => {
    if (!scanId) return undefined;
    finishedRef.current = false;
    const source = new EventSource(`/api/scans/${scanId}/events`);
    setLive(true);

    source.onmessage = (event: MessageEvent<string>) => {
      let payload: StreamEvent;
      try {
        payload = JSON.parse(event.data) as StreamEvent;
      } catch {
        return;
      }
      if (payload.progress) setProgress(payload.progress);
      if (payload.type === 'log' && payload.message) {
        setLogs((current) => [...current.slice(-400), { at: payload.at, level: payload.level ?? 'info', phase: payload.phase ?? null, message: payload.message as string }]);
      }
      if (payload.type === 'done' || payload.type === 'error') {
        finishedRef.current = true;
        source.close();
        setLive(false);
        void api
          .getScan(scanId)
          .then(setScan)
          .catch(() => undefined);
      }
    };

    source.onerror = () => {
      source.close();
      setLive(false);
      // The stream also closes when the scan process exits; refresh once so the UI
      // reflects the persisted status instead of a stale "running" badge.
      if (!finishedRef.current) {
        void api.getScan(scanId).then(setScan).catch(() => undefined);
      }
    };

    return () => {
      source.close();
      setLive(false);
    };
  }, [scanId]);

  useEffect(() => {
    if (!scanId) return;
    void api
      .scanLogs(scanId)
      .then((result) => {
        if (result.items.length) setLogs((current) => (current.length >= result.items.length ? current : result.items));
      })
      .catch(() => undefined);
  }, [scanId]);

  return { scan, progress, logs, live };
}

const PHASES: ScanPhase[] = [
  'FILE_DISCOVERY',
  'FILE_CLASSIFICATION',
  'PARSING',
  'IE_DETECTION',
  'REFERENCE_ANALYSIS',
  'FINDING_MERGE',
  'PERSISTENCE',
  'REPORT_GENERATION',
];

export function PhaseList({ active, status }: { active: ScanPhase | null; status: ScanTask['status'] }) {
  const { t } = useI18n();
  const finished = status === 'COMPLETED' || status === 'COMPLETED_WITH_WARNINGS';
  // A cancelled or failed scan reached some phase and stopped there. Colouring every phase
  // green would claim it produced a report, which is exactly what did not happen.
  const stopped = status === 'CANCELLED' || status === 'FAILED';
  const activeIndex = active ? PHASES.indexOf(active) : finished ? PHASES.length : -1;

  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {PHASES.map((phase, index) => {
        const state: 'done' | 'active' | 'stopped' | 'pending' = stopped
          ? index < activeIndex
            ? 'done'
            : index === activeIndex
              ? 'stopped'
              : 'pending'
          : index < activeIndex || (finished && index <= activeIndex)
            ? 'done'
            : index === activeIndex
              ? 'active'
              : 'pending';
        return (
          <li key={phase} className="row" style={{ fontSize: 12, color: state === 'pending' ? 'var(--text-3)' : 'var(--text)' }}>
            <span
              className="dot"
              style={{
                background:
                  state === 'done' ? 'var(--ok)' : state === 'stopped' ? 'var(--medium)' : state === 'active' ? 'var(--accent)' : 'var(--border-strong)',
                width: 7,
                height: 7,
              }}
            />
            <span className="grow" style={{ fontWeight: state === 'active' ? 600 : 400 }}>
              {t(`phase.${phase}`)}
            </span>
            {state === 'active' ? <Spinner /> : null}
            {state === 'stopped' ? <span className="muted" style={{ fontSize: 11 }}>{t('scans.stoppedHere')}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

export function ScanLog({ logs }: { logs: LogEntry[] }) {
  if (logs.length === 0) return <div className="muted" style={{ fontSize: 12 }}>—</div>;
  return (
    <div className="log">
      {logs.map((entry, index) => (
        <div key={`${entry.at}-${index}`}>
          <span className="t">{new Date(entry.at).toLocaleTimeString()}</span>
          <span className={entry.level === 'warn' ? 'warn' : entry.level === 'error' ? 'error' : ''}>{entry.message}</span>
        </div>
      ))}
    </div>
  );
}
