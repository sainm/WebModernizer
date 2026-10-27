import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatTime } from '../api';
import { useAsync } from '../hooks';
import { useI18n } from '../i18n';
import { Card, Empty, ErrorBox, Loading, PageHead } from '../components/ui';

export default function Reports() {
  const { t, scanStatus } = useI18n();
  const scans = useAsync(() => api.listScans(undefined, 200), []);
  const [search, setSearch] = useState('');

  if (scans.loading) return <Loading />;

  const items = (scans.data?.items ?? []).filter((scan) => {
    if (!search.trim()) return true;
    const needle = search.toLowerCase();
    return scan.projectName.toLowerCase().includes(needle) || scan.id.toLowerCase().includes(needle);
  });

  return (
    <div className="page">
      <PageHead
        title={t('reports.title')}
        subtitle={t('reports.subtitle')}
        actions={<input className="input" style={{ width: 240 }} placeholder={t('common.search')} value={search} onChange={(event) => setSearch(event.target.value)} />}
      />
      <ErrorBox error={scans.error} onRetry={scans.reload} />

      <Card flush>
        {items.length === 0 ? (
          <Empty>{t('reports.empty')}</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('reports.scan')}</th>
                <th>{t('scans.status')}</th>
                <th className="num">{t('scans.findings')}</th>
                <th>{t('reports.generated')}</th>
                <th className="right">{t('reports.export')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((scan) => (
                <tr key={scan.id}>
                  <td>
                    <Link to={`/scans/${scan.id}`} style={{ fontWeight: 550 }}>
                      {scan.projectName}
                    </Link>
                    <div className="mono muted" style={{ fontSize: 10.5 }}>
                      {scan.id}
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${scan.status === 'FAILED' ? 'high' : scan.status === 'COMPLETED_WITH_WARNINGS' ? 'warn' : 'neutral'}`}>
                      {scanStatus(scan.status)}
                    </span>
                  </td>
                  <td className="num">{scan.findingCount}</td>
                  <td className="muted nowrap">{formatTime(scan.completedAt ?? scan.startedAt ?? scan.createdAt)}</td>
                  <td className="right nowrap">
                    <a className="btn small" href={api.reportUrl(scan.id, 'json')}>
                      {t('reports.json')}
                    </a>{' '}
                    <a className="btn small" href={api.reportUrl(scan.id, 'csv')}>
                      {t('reports.csv')}
                    </a>{' '}
                    <a className="btn small" href={api.reportUrl(scan.id, 'html')} target="_blank" rel="noreferrer">
                      {t('reports.html')}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
