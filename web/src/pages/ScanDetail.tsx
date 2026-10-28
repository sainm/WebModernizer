import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, formatDuration, formatTime, type ScanSummary } from '../api';
import { useAsync } from '../hooks';
import { useI18n } from '../i18n';
import { BarList, Card, Donut, Empty, ErrorBox, Loading, PageHead, SeverityBadge, Stat } from '../components/ui';
import { PhaseList, ScanLog, useScanStream } from '../components/ScanProgress';

const SEVERITY_COLORS: Record<string, string> = { HIGH: '#c0271d', MEDIUM: '#d98216', LOW: '#2456d6', UNKNOWN: '#8b93a3' };

type Tab = 'dashboard' | 'files' | 'logs';

export default function ScanDetail() {
  const { scanId } = useParams();
  const { t, severity, scanStatus, level, phase } = useI18n();
  const scan = useAsync(() => api.getScan(scanId as string), [scanId]);
  const { scan: liveScan, progress, logs, live } = useScanStream(scanId ?? null, scan.data ?? null);
  const summary = useAsync<ScanSummary>(() => api.summary(scanId as string), [scanId, liveScan?.status]);
  const files = useAsync(() => api.scanFiles(scanId as string), [scanId]);
  const [tab, setTab] = useState<Tab>('dashboard');

  if (scan.loading) return <Loading />;
  if (scan.error) return <div className="page"><ErrorBox error={scan.error} onRetry={scan.reload} /></div>;
  const current = liveScan ?? scan.data;
  if (!current) return <div className="page"><Empty>{t('scan.noScan')}</Empty></div>;

  const running = current.status === 'RUNNING' || current.status === 'QUEUED';
  const total = progress?.totalFiles ?? current.scannedFileCount;
  const done = progress?.scannedFiles ?? current.scannedFileCount;
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

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
          <PhaseList active={current.phase} done={!running} />
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
                items={summary.data.byCategory.map((row) => ({ label: row.label, value: row.count, key: row.category }))}
                onSelect={(key) => window.location.assign(`/scans/${current.id}/findings?category=${key}`)}
              />
            ) : (
              <Loading />
            )}
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
                    </span>
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
