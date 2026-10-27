import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, formatDuration, formatTime } from '../api';
import { useAsync } from '../hooks';
import { useI18n } from '../i18n';
import { Card, Empty, ErrorBox, Loading, PageHead } from '../components/ui';

export default function Scans() {
  const { t, scanStatus, phase } = useI18n();
  const navigate = useNavigate();
  const scans = useAsync(() => api.listScans(undefined, 200), []);
  const [filter, setFilter] = useState('');

  if (scans.loading) return <Loading />;

  const items = (scans.data?.items ?? []).filter((scan) => {
    if (!filter.trim()) return true;
    const needle = filter.toLowerCase();
    return (
      scan.projectName.toLowerCase().includes(needle) ||
      scan.id.toLowerCase().includes(needle) ||
      scan.status.toLowerCase().includes(needle)
    );
  });

  return (
    <div className="page">
      <PageHead title={t('scans.title')} subtitle={t('scans.subtitle')} />
      <ErrorBox error={scans.error} onRetry={scans.reload} />

      <div className="row" style={{ marginBottom: 12 }}>
        <input
          className="input"
          style={{ maxWidth: 320 }}
          placeholder={t('scans.searchPlaceholder')}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <span className="muted" style={{ fontSize: 12 }}>
          {items.length} {t('findings.results')}
        </span>
        <div className="spacer" />
        <button className="btn small" onClick={scans.reload}>
          {t('common.refresh')}
        </button>
      </div>

      <Card flush>
        {items.length === 0 ? (
          <Empty>{t('scans.empty')}</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('scans.project')}</th>
                <th>{t('scans.status')}</th>
                <th>{t('scans.phase')}</th>
                <th className="num">{t('scans.files')}</th>
                <th className="num">{t('scans.findings')}</th>
                <th>{t('scans.started')}</th>
                <th>{t('scans.duration')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((scan) => (
                <tr key={scan.id} className="clickable" onClick={() => navigate(`/scans/${scan.id}`)}>
                  <td>
                    <div style={{ fontWeight: 550 }}>{scan.projectName}</div>
                    <div className="mono muted" style={{ fontSize: 10.5 }}>{scan.id}</div>
                  </td>
                  <td>
                    <span className={`badge ${scan.status === 'FAILED' ? 'high' : scan.status === 'RUNNING' ? 'accent' : scan.status === 'COMPLETED_WITH_WARNINGS' ? 'warn' : 'neutral'}`}>
                      {scanStatus(scan.status)}
                    </span>
                  </td>
                  <td className="muted">{scan.phase ? phase(scan.phase) : '—'}</td>
                  <td className="num">{scan.scannedFileCount}</td>
                  <td className="num">{scan.findingCount}</td>
                  <td className="muted nowrap">{formatTime(scan.startedAt ?? scan.createdAt)}</td>
                  <td className="muted nowrap">{formatDuration(scan.startedAt, scan.completedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
