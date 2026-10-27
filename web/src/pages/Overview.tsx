import { Link, useNavigate } from 'react-router-dom';
import { api, formatDuration, formatTime, type ScanSummary } from '../api';
import { useAsync } from '../hooks';
import { useI18n } from '../i18n';
import { BarList, Card, Donut, Empty, ErrorBox, Icon, Loading, PageHead, Stat } from '../components/ui';

const SEVERITY_COLORS: Record<string, string> = {
  HIGH: '#c0271d',
  MEDIUM: '#d98216',
  LOW: '#2456d6',
  UNKNOWN: '#8b93a3',
};

export default function Overview() {
  const { t, severity, scanStatus, phase } = useI18n();
  const navigate = useNavigate();
  const projects = useAsync(() => api.listProjects(), []);
  const scans = useAsync(() => api.listScans(undefined, 8), []);
  const latest = scans.data?.items?.[0] ?? null;
  const summary = useAsync<ScanSummary | null>(() => (latest ? api.summary(latest.id) : Promise.resolve(null)), [latest?.id]);

  if (projects.loading || scans.loading) return <Loading />;

  return (
    <div className="page">
      <PageHead
        title={t('overview.title')}
        subtitle={t('overview.subtitle')}
        actions={
          <>
            <button className="btn" onClick={() => navigate('/projects')}>
              {t('overview.projects')}
            </button>
            <button className="btn primary" onClick={() => navigate('/projects?new=1')}>
              {t('overview.newProject')}
            </button>
          </>
        }
      />
      <ErrorBox error={projects.error ?? scans.error} onRetry={() => { projects.reload(); scans.reload(); }} />

      {!latest ? (
        <Card>
          <Empty>
            <div style={{ marginBottom: 12 }}>{t('overview.noScans')}</div>
            <Link className="btn primary" to="/projects?new=1">
              {t('overview.newProject')}
            </Link>
          </Empty>
        </Card>
      ) : (
        <>
          <div className="grid-stats">
            <Stat label={t('overview.files')} value={summary.data?.totals.files ?? latest.scannedFileCount} />
            <Stat label={t('overview.findings')} value={summary.data?.totals.findings ?? latest.findingCount} />
            <Stat label={t('overview.highRisk')} value={summary.data?.totals.highRisk ?? '—'} />
            <Stat label={t('overview.autoConvertible')} value={summary.data?.totals.autoConvertible ?? '—'} />
            <Stat label={t('overview.manual')} value={summary.data?.totals.manual ?? '—'} />
            <Stat label={t('overview.unsupported')} value={summary.data?.totals.unsupported ?? '—'} />
            <Stat label={t('overview.candidates')} value={summary.data?.totals.automationCandidates ?? '—'} />
            <Stat label={t('overview.parseFailures')} value={summary.data?.totals.parseFailures ?? latest.failedFileCount} />
          </div>

          <div className="grid-2" style={{ marginBottom: 16 }}>
            <Card title={t('overview.latestTitle')} actions={<span className="badge neutral">{scanStatus(latest.status)}</span>}>
              <div className="row" style={{ marginBottom: 12 }}>
                <div className="grow">
                  <div style={{ fontWeight: 620, fontSize: 14 }}>{latest.projectName}</div>
                  <div className="mono muted" style={{ fontSize: 11 }}>
                    {latest.rootPath}
                  </div>
                </div>
                <button className="btn small" onClick={() => navigate(`/scans/${latest.id}`)}>
                  {t('overview.openScan')}
                </button>
              </div>
              <dl className="kv">
                <dt>{t('scans.started')}</dt>
                <dd>{formatTime(latest.startedAt ?? latest.createdAt)}</dd>
                <dt>{t('scans.duration')}</dt>
                <dd>{formatDuration(latest.startedAt, latest.completedAt)}</dd>
                <dt>{t('scans.phase')}</dt>
                <dd>{latest.phase ? phase(latest.phase) : '—'}</dd>
                <dt>Scan ID</dt>
                <dd className="mono">{latest.id}</dd>
              </dl>
              <div className="row" style={{ marginTop: 12 }}>
                <Link className="btn small" to={`/scans/${latest.id}/findings`}>
                  {t('scan.viewFindings')}
                </Link>
                <Link className="btn small" to={`/scans/${latest.id}/dependencies`}>
                  {t('scan.viewDependencies')}
                </Link>
              </div>
            </Card>

            <Card title={t('findings.severity')}>
              {summary.data ? (
                <Donut
                  slices={summary.data.bySeverity.map((row) => ({
                    label: severity(row.severity),
                    value: row.count,
                    color: SEVERITY_COLORS[row.severity],
                  }))}
                  centerLabel={t('overview.findings')}
                />
              ) : (
                <Loading />
              )}
            </Card>
          </div>

          <div className="grid-2">
            <Card title={t('scan.dashboard')}>
              {summary.data ? (
                <BarList
                  items={summary.data.byCategory.map((row) => ({ label: row.label, value: row.count, key: row.category }))}
                  colorFor={() => 'var(--accent)'}
                />
              ) : (
                <Loading />
              )}
            </Card>

            <Card title={t('overview.recentScans')} flush>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('scans.project')}</th>
                    <th>{t('scans.status')}</th>
                    <th className="num">{t('scans.findings')}</th>
                    <th>{t('scans.started')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(scans.data?.items ?? []).map((scan) => (
                    <tr key={scan.id} className="clickable" onClick={() => navigate(`/scans/${scan.id}`)}>
                      <td>
                        <div style={{ fontWeight: 550 }}>{scan.projectName}</div>
                        <div className="mono muted" style={{ fontSize: 10.5 }}>
                          {scan.id}
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${scan.status === 'FAILED' ? 'high' : scan.status === 'RUNNING' ? 'accent' : 'neutral'}`}>
                          {scanStatus(scan.status)}
                        </span>
                      </td>
                      <td className="num">{scan.findingCount}</td>
                      <td className="muted nowrap">{formatTime(scan.startedAt ?? scan.createdAt)}</td>
                      <td className="right">
                        <Icon name="migration" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
