import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, formatTime, ApiError, type Finding } from '../api';
import { useAsync } from '../hooks';
import { useI18n } from '../i18n';
import { Card, Empty, ErrorBox, LevelBadge, Loading, PageHead, SeverityBadge, Stat } from '../components/ui';

function FindingTable({ items, empty }: { items: Finding[]; empty: string }) {
  const { t, findingMessage } = useI18n();
  if (items.length === 0) return <Empty>{empty}</Empty>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>{t('findings.severity')}</th>
          <th>{t('findings.rule')}</th>
          <th>{t('findings.location')}</th>
          <th>{t('findings.detail')}</th>
          <th>{t('findings.level')}</th>
        </tr>
      </thead>
      <tbody>
        {items.map((finding) => (
          <tr key={finding.id}>
            <td>
              <SeverityBadge value={finding.severity} />
            </td>
            <td className="mono" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
              {finding.ruleId}
            </td>
            <td className="mono" style={{ fontSize: 11 }}>
              <Link to={`/scans/${finding.scanTaskId}/findings?id=${finding.id}`}>
                {finding.filePath}:{finding.startLine}
              </Link>
            </td>
            <td style={{ fontSize: 12 }}>{findingMessage(finding)}</td>
            <td>
              <LevelBadge value={finding.migrationLevel} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function Compare() {
  const { scanId } = useParams();
  const [params] = useSearchParams();
  const { t } = useI18n();
  const baselineId = params.get('baseline') ?? undefined;
  const compare = useAsync(() => api.compareScans(scanId as string, baselineId), [scanId, baselineId]);

  if (compare.loading) return <Loading />;

  const notAvailable = compare.error instanceof ApiError && compare.error.status === 409;
  if (notAvailable) {
    return (
      <div className="page">
        <PageHead title={t('compare.title')} />
        <Card>
          <Empty>{t('compare.notAvailable')}</Empty>
        </Card>
      </div>
    );
  }
  if (compare.error) {
    return (
      <div className="page">
        <ErrorBox error={compare.error} onRetry={compare.reload} />
      </div>
    );
  }
  if (!compare.data) return <Loading />;

  const data = compare.data;
  const netChange = data.added.length - data.resolved.length;

  return (
    <div className="page">
      <PageHead
        title={t('compare.title')}
        subtitle={t('compare.subtitle')}
        actions={
          <>
            <Link className="btn small" to={`/scans/${data.baseline.id}`}>
              {t('compare.baselineLabel')}: {formatTime(data.baseline.createdAt)}
            </Link>
            <Link className="btn small primary" to={`/scans/${data.current.id}`}>
              {t('compare.currentLabel')}: {formatTime(data.current.createdAt)}
            </Link>
          </>
        }
      />

      <div className="grid-stats">
        <Stat label={t('compare.resolved')} value={data.resolved.length} foot={`${data.baselineTotal} → ${data.currentTotal}`} />
        <Stat label={t('compare.added')} value={data.added.length} foot={netChange >= 0 ? `+${netChange}` : String(netChange)} />
        <Stat label={t('compare.unchanged')} value={data.unchanged} />
        <Stat label={t('compare.currentTotal')} value={data.currentTotal} />
      </div>

      <div className={`callout ${data.sources.identical ? '' : 'warn'}`} style={{ marginBottom: 14 }}>
        {data.sources.identical
          ? t('compare.sourcesIdentical')
          : t('compare.sourcesChanged', { count: data.sources.changedFiles.length + data.sources.removedFiles.length })}
      </div>

      <Card title={t('compare.byRule')} flush>
        {data.byRule.length === 0 ? (
          <Empty>{t('compare.emptySide')}</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('findings.rule')}</th>
                <th className="num">{t('compare.resolved')}</th>
                <th className="num">{t('compare.added')}</th>
              </tr>
            </thead>
            <tbody>
              {data.byRule.map((row) => (
                <tr key={row.ruleId}>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {row.ruleId}
                  </td>
                  <td className="num" style={{ color: row.resolved > 0 ? 'var(--ok)' : undefined }}>
                    {row.resolved || '—'}
                  </td>
                  <td className="num" style={{ color: row.added > 0 ? 'var(--high)' : undefined }}>
                    {row.added || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div style={{ marginTop: 14 }}>
        <Card title={`${t('compare.resolvedList')} · ${data.resolved.length}`} flush>
          <FindingTable items={data.resolved} empty={t('compare.emptySide')} />
        </Card>
      </div>

      <div style={{ marginTop: 14 }}>
        <Card title={`${t('compare.addedList')} · ${data.added.length}`} flush>
          <FindingTable items={data.added} empty={t('compare.emptySide')} />
        </Card>
      </div>
    </div>
  );
}
