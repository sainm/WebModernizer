import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, formatDuration, formatTime, type ScanSummary } from '../api';
import { useAsync } from '../hooks';
import { useI18n } from '../i18n';
import { BarList, Card, Donut, Empty, ErrorBox, Loading, PageHead, SeverityBadge, Stat } from '../components/ui';
import { PhaseList, ScanLog, useScanStream } from '../components/ScanProgress';

const SEVERITY_COLORS: Record<string, string> = { HIGH: '#c0271d', MEDIUM: '#d98216', LOW: '#2456d6', UNKNOWN: '#8b93a3' };

type Tab = 'dashboard' | 'files' | 'logs';

export default function ScanDetail() {
  const { scanId } = useParams();
  const { t, severity, scanStatus, level, phase, category } = useI18n();
  const scan = useAsync(() => api.getScan(scanId as string), [scanId]);
  const { scan: liveScan, progress, logs, live } = useScanStream(scanId ?? null, scan.data ?? null);
  const summary = useAsync<ScanSummary>(() => api.summary(scanId as string), [scanId, liveScan?.status]);
  const files = useAsync(() => api.scanFiles(scanId as string), [scanId]);
  const meta = useAsync(() => api.meta(), []);
  const [tab, setTab] = useState<Tab>('dashboard');
  const [applying, setApplying] = useState(false);
  const [resuming, setResuming] = useState(false);
  const navigate = useNavigate();
  const [applyNotice, setApplyNotice] = useState<string | null>(null);

  if (scan.loading) return <Loading />;
  if (scan.error) return <div className="page"><ErrorBox error={scan.error} onRetry={scan.reload} /></div>;
  const current = liveScan ?? scan.data;
  if (!current) return <div className="page"><Empty>{t('scan.noScan')}</Empty></div>;

  const running = current.status === 'RUNNING' || current.status === 'QUEUED';
  // totalFileCount is written before parsing starts, so an interrupted scan keeps the real
  // denominator instead of presenting its partial count as if it were the whole project.
  const total = progress?.totalFiles ?? (current.totalFileCount || current.scannedFileCount);
  const done = progress?.scannedFiles ?? current.scannedFileCount;
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  const interrupted = current.status === 'CANCELLED' || current.status === 'FAILED';
  // Only files that were fully analysed are stored, so this is a safe resume point.
  const keptFiles = files.data?.items.length ?? 0;

  const resume = async (): Promise<void> => {
    setResuming(true);
    try {
      const next = await api.startScan(current.projectId);
      navigate(`/scans/${next.id}`);
    } finally {
      setResuming(false);
    }
  };

  const rulesChanged = Boolean(
    current.ruleSignature && meta.data?.ruleSignature && current.ruleSignature !== meta.data.ruleSignature,
  );

  const applyRules = async (): Promise<void> => {
    setApplying(true);
    try {
      const result = await api.applyScanRules(current.id);
      setApplyNotice(
        t('scan.appliedRules', { ignored: result.ignored, disabled: result.disabled, restored: result.unignored }),
      );
      scan.reload();
      summary.reload();
    } finally {
      setApplying(false);
    }
  };

  const cancel = async (): Promise<void> => {
    if (!window.confirm(t('scans.cancelConfirm'))) return;
    await api.cancelScan(current.id);
    scan.reload();
  };

  return (
    <div className="page" style={{ paddingBottom: 20 }}>
      <PageHead
        title={`${current.projectName} · ${t('scan.title')}`}
        subtitle={current.rootPath}
        actions={
          <>
            {running ? (
              <button className="btn danger small" onClick={cancel}>
                {t('scans.cancel')}
              </button>
            ) : null}
            <Link className="btn small" to={`/scans/${current.id}/findings`}>
              {t('scan.viewFindings')}
            </Link>
            <Link className="btn small" to={`/scans/${current.id}/dependencies`}>
              {t('scan.viewDependencies')}
            </Link>
            <Link className="btn small" to={`/scans/${current.id}/compare`}>
              {t('compare.withPrevious')}
            </Link>
            <a className="btn small" href={api.reportUrl(current.id, 'html')} target="_blank" rel="noreferrer">
              {t('scan.export')} · HTML
            </a>
            <a className="btn small" href={api.reportUrl(current.id, 'csv')}>
              CSV
            </a>
            <a className="btn small" href={api.reportUrl(current.id, 'json')}>
              JSON
            </a>
          </>
        }
      />

      {interrupted ? (
        <div className="callout warn" style={{ marginBottom: 14 }}>
          <div className="row wrap">
            <span className="grow">
              {keptFiles > 0 ? t('scan.interruptedHint', { count: keptFiles }) : t('scan.interruptedEmpty')}
            </span>
            <button className="btn small primary" onClick={resume} disabled={resuming}>
              {resuming ? <span className="spinner" /> : null}{' '}
              {keptFiles > 0 ? t('scan.resume') : t('project.runScan')}
            </button>
          </div>
        </div>
      ) : null}

      {rulesChanged ? (
        <div className="callout warn" style={{ marginBottom: 14 }}>
          <div className="row wrap">
            <span className="grow">{t('scan.rulesChanged')}</span>
            <button className="btn small" onClick={applyRules} disabled={applying}>
              {applying ? <span className="spinner" /> : null} {t('scan.applyRules')}
            </button>
          </div>
          {applyNotice ? <div className="hint" style={{ marginTop: 6 }}>{applyNotice}</div> : null}
        </div>
      ) : null}

      <div className="grid-2" style={{ marginBottom: 14 }}>
        <Card
          title={t('scan.progress')}
          actions={
            <span className={`badge ${current.status === 'FAILED' ? 'high' : running ? 'accent' : 'neutral'}`}>
              {scanStatus(current.status)} {live ? '· live' : ''}
            </span>
          }
        >
          <div className="row" style={{ marginBottom: 8, fontSize: 12 }}>
            <span className="mono">
              {done} / {total || '?'}
            </span>
            <span className="muted">{current.phase ? phase(current.phase) : '—'}</span>
            <div className="spacer" />
            <span className="muted">{percent}%</span>
          </div>
          <div className="progress-track" style={{ marginBottom: 10 }}>
            <div className={total ? 'progress-fill' : 'progress-fill indeterminate'} style={{ width: total ? `${percent}%` : undefined }} />
          </div>
          <dl className="kv">
            <dt>{t('scan.mode')}</dt>
            <dd>
              {(() => {
                const all = files.data?.items ?? [];
                const reused = all.filter((file) => file.reused).length;
                if (all.length === 0) return <span className="muted">—</span>;
                return reused > 0 ? (
                  <span className="row" style={{ gap: 6 }}>
                    <span className="badge accent">{t('scan.incremental')}</span>
                    <span className="muted" style={{ fontSize: 11.5 }}>
                      {t('scan.reusedOf', { reused, total: all.length })}
                    </span>
                  </span>
                ) : (
                  <span className="badge neutral">{t('scan.fullScan')}</span>
                );
              })()}
            </dd>
            <dt>{t('scan.currentFile')}</dt>
            <dd className="mono" style={{ wordBreak: 'break-all' }}>
              {progress?.currentFile ?? '—'}
            </dd>
            <dt>{t('scans.findings')}</dt>
            <dd>{progress?.findings ?? current.findingCount}</dd>
            <dt>{t('overview.parseFailures')}</dt>
            <dd>{progress?.failedFiles ?? current.failedFileCount}</dd>
            <dt>{t('scans.started')}</dt>
            <dd>{formatTime(current.startedAt ?? current.createdAt)}</dd>
            <dt>{t('scans.duration')}</dt>
            <dd>{formatDuration(current.startedAt, current.completedAt)}</dd>
          </dl>
          {current.errorSummary ? <div className="callout danger" style={{ marginTop: 10 }}>{current.errorSummary}</div> : null}
        </Card>

        <Card title={t('scans.phase')}>
          <PhaseList active={current.phase} status={current.status} />
        </Card>
      </div>

      <div className="grid-stats">
        <Stat label={t('overview.files')} value={summary.data?.totals.files ?? current.scannedFileCount} />
        <Stat label={t('overview.findings')} value={summary.data?.totals.findings ?? current.findingCount} />
        <Stat label={t('overview.highRisk')} value={summary.data?.totals.highRisk ?? '—'} />
        <Stat label={t('overview.autoConvertible')} value={summary.data?.totals.autoConvertible ?? '—'} />
        <Stat label={t('overview.manual')} value={summary.data?.totals.manual ?? '—'} />
        <Stat label={t('overview.unsupported')} value={summary.data?.totals.unsupported ?? '—'} />
        <Stat label={t('overview.candidates')} value={summary.data?.totals.automationCandidates ?? '—'} />
        {summary.data && summary.data.totals.ignored > 0 ? (
          <Stat label={t('overview.ignored')} value={summary.data.totals.ignored} />
        ) : null}
      </div>

      <div className="tabs" style={{ padding: 0, marginBottom: 14, borderBottom: 'none', gap: 4 }}>
        {(['dashboard', 'files', 'logs'] as Tab[]).map((item) => (
          <button key={item} className={tab === item ? 'tab active' : 'tab'} onClick={() => setTab(item)}>
            {item === 'dashboard' ? t('scan.dashboard') : item === 'files' ? t('scan.filesTab') : t('scan.logs')}
          </button>
        ))}
      </div>

      {tab === 'dashboard' ? (
        <div className="grid-2">
          <Card title={t('findings.category')}>
            {summary.data ? (
              <BarList
                items={summary.data.byCategory.map((row) => ({ label: category(row.category), value: row.count, key: row.category }))}
                onSelect={(key) => window.location.assign(`/scans/${current.id}/findings?category=${key}`)}
              />
            ) : (
              <Loading />
            )}
            <div className="splitter" />
            {(summary.data?.byModule.length ?? 0) > 1 ? (
              <>
                <div className="splitter" />
                <div className="section-title">{t('scan.byModule')}</div>
                <BarList
                  items={(summary.data?.byModule ?? []).map((row) => ({ label: row.module, value: row.count, key: row.module }))}
                  onSelect={(key) => window.location.assign(`/scans/${current.id}/findings?module=${encodeURIComponent(key)}`)}
                  colorFor={() => 'var(--ok)'}
                />
              </>
            ) : null}
            <div className="splitter" />
            <div className="section-title">{t('findings.level')}</div>
            {summary.data ? (
              <BarList
                items={summary.data.byMigrationLevel.map((row) => ({ label: level(row.level), value: row.count, key: row.level }))}
                colorFor={(key) =>
                  key === 'SAFE' ? 'var(--ok)' : key === 'CONDITIONAL' ? '#d98216' : key === 'MANUAL' ? '#8b93a3' : 'var(--purple)'
                }
              />
            ) : null}
          </Card>

          <Card title={t('findings.severity')}>
            {summary.data ? (
              <Donut
                slices={summary.data.bySeverity.map((row) => ({ label: severity(row.severity), value: row.count, color: SEVERITY_COLORS[row.severity] }))}
                centerLabel={t('overview.findings')}
              />
            ) : (
              <Loading />
            )}
            <div className="splitter" />
            <div className="section-title">{t('findings.sameFile')}</div>
            <div className="col" style={{ gap: 4 }}>
              {(summary.data?.topFiles ?? []).slice(0, 6).map((file) => (
                <Link
                  key={file.filePath}
                  to={`/scans/${current.id}/findings?path=${encodeURIComponent(file.filePath)}`}
                  className="row"
                  style={{ fontSize: 12, color: 'var(--text-2)' }}
                >
                  <span className="mono grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {file.filePath}
                  </span>
                  <span className="badge high">{file.highRisk}</span>
                  <span className="badge neutral">{file.count}</span>
                </Link>
              ))}
            </div>
          </Card>

          <Card title={t('scan.parseProblems')} flush>
            {(summary.data?.parseProblems.length ?? 0) === 0 ? (
              <Empty>{t('common.none')}</Empty>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('findings.file')}</th>
                    <th>{t('scan.recovered')}</th>
                    <th>Message</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.data?.parseProblems.slice(0, 20).map((problem, index) => (
                    <tr key={`${problem.filePath}-${index}`}>
                      <td className="mono" style={{ fontSize: 11 }}>
                        {problem.filePath}
                        {problem.line ? `:${problem.line}` : ''}
                      </td>
                      <td>
                        <span className={`badge ${problem.recovered ? 'warn' : 'high'}`}>
                          {problem.recovered ? t('scan.recovered') : t('scan.hard')}
                        </span>
                      </td>
                      <td className="dim" style={{ fontSize: 11.5 }}>{problem.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      ) : null}

      {tab === 'files' ? (
        <Card flush>
          <table className="table">
            <thead>
              <tr>
                <th>{t('findings.file')}</th>
                <th>{t('scan.encoding')}</th>
                <th>{t('findings.language')}</th>
                <th className="num">{t('scan.size')}</th>
                <th className="num">{t('scans.findings')}</th>
                <th>{t('scans.status')}</th>
              </tr>
            </thead>
            <tbody>
              {(files.data?.items ?? []).map((file) => (
                <tr key={file.id}>
                  <td className="mono" style={{ fontSize: 11.5 }}>
                    <Link to={`/scans/${current.id}/findings?path=${encodeURIComponent(file.path)}`}>{file.path}</Link>
                  </td>
                  <td>
                    <span className={`badge ${file.encoding === 'utf-8' ? 'neutral' : 'accent'}`}>{file.encoding}</span>
                  </td>
                  <td className="muted">{file.language}</td>
                  <td className="num muted">{Math.round(file.size / 1024)} KB</td>
                  <td className="num">{file.findingCount}</td>
                  <td>
                    <span className={`badge ${file.parseStatus === 'FAILED' ? 'high' : file.parseStatus === 'PARTIAL' ? 'warn' : 'ok'}`}>
                      {file.parseStatus}
                    </span>{' '}
                    {file.reused ? <span className="badge neutral">{t('scan.reused')}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {tab === 'logs' ? (
        <Card title={t('scan.logs')}>
          <ScanLog logs={logs} />
        </Card>
      ) : null}
    </div>
  );
}
