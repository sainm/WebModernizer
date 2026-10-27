import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Relation } from '../api';
import { useAsync, useScanSelection } from '../hooks';
import { useI18n } from '../i18n';
import { Card, Empty, ErrorBox, Loading, PageHead } from '../components/ui';
import { DependencyGraph } from '../components/Graph';

const KIND_KEYS: Record<Relation['kind'], string> = {
  SCRIPT_SRC: 'script src',
  STYLESHEET: 'stylesheet',
  JS_IMPORT: 'import',
  SHARED_FUNCTION: 'shared function',
  SHARED_FUNCTION_CALL: 'function call',
};

export default function Dependency() {
  const { scanId: routeScanId } = useParams();
  const { t } = useI18n();
  const selection = useScanSelection(routeScanId);
  const scanId = routeScanId ?? selection.scanId;
  const relations = useAsync(() => (scanId ? api.relations(scanId) : Promise.resolve({ items: [] })), [scanId]);
  const findings = useAsync(() => (scanId ? api.findings(scanId, { limit: 2000 }) : Promise.resolve({ total: 0, items: [] })), [scanId]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [confidenceFilter, setConfidenceFilter] = useState<'all' | 'CONFIRMED' | 'INFERRED' | 'UNKNOWN'>('all');

  const findingsByFile = useMemo(() => {
    const map = new Map<string, { total: number; high: number }>();
    for (const finding of findings.data?.items ?? []) {
      const entry = map.get(finding.filePath) ?? { total: 0, high: 0 };
      entry.total += 1;
      if (finding.severity === 'HIGH') entry.high += 1;
      map.set(finding.filePath, entry);
    }
    return map;
  }, [findings.data]);

  const items = useMemo(() => {
    const all = relations.data?.items ?? [];
    return confidenceFilter === 'all' ? all : all.filter((relation) => relation.confidence === confidenceFilter);
  }, [relations.data, confidenceFilter]);

  const visible = useMemo(() => {
    if (!selectedFile) return items;
    return items.filter((relation) => relation.fromPath === selectedFile || relation.toPath === selectedFile);
  }, [items, selectedFile]);

  if (selection.loading) return <Loading />;

  return (
    <div className="page">
      <PageHead
        title={t('deps.title')}
        subtitle={t('deps.subtitle')}
        actions={
          <select className="select" style={{ width: 260 }} value={scanId ?? ''} onChange={(event) => selection.setScanId(event.target.value)}>
            {selection.scans.map((scan) => (
              <option key={scan.id} value={scan.id}>
                {scan.projectName} · {new Date(scan.startedAt ?? scan.createdAt).toLocaleDateString()}
              </option>
            ))}
          </select>
        }
      />
      <ErrorBox error={relations.error} onRetry={relations.reload} />

      {!scanId ? (
        <Empty>{t('overview.noScans')}</Empty>
      ) : relations.loading ? (
        <Loading />
      ) : items.length === 0 ? (
        <Card>
          <Empty>{t('deps.empty')}</Empty>
        </Card>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 10 }}>
            <div className="seg">
              {(['all', 'CONFIRMED', 'INFERRED', 'UNKNOWN'] as const).map((value) => (
                <button key={value} className={confidenceFilter === value ? 'active' : ''} onClick={() => setConfidenceFilter(value)}>
                  {value === 'all' ? t('common.all') : value === 'CONFIRMED' ? t('deps.confirmed') : value === 'INFERRED' ? t('deps.inferred') : t('deps.unknown')}
                </button>
              ))}
            </div>
            <span className="muted" style={{ fontSize: 12 }}>
              {items.length} {t('deps.edges')}
            </span>
            <div className="spacer" />
            <div className="legend">
              <span className="legend-item">
                <span style={{ width: 18, height: 0, borderTop: '1.5px solid #8b93a3' }} /> {t('deps.confirmed')}
              </span>
              <span className="legend-item">
                <span style={{ width: 18, height: 0, borderTop: '1.5px dashed #b48a3a' }} /> {t('deps.inferred')}
              </span>
              <span className="legend-item">
                <span style={{ width: 18, height: 0, borderTop: '1.5px dotted #c0271d' }} /> {t('deps.unknown')}
              </span>
            </div>
          </div>

          <DependencyGraph relations={items} findingsByFile={findingsByFile} onSelectFile={setSelectedFile} selectedFile={selectedFile} />

          <div style={{ marginTop: 14 }}>
            <Card
              title={selectedFile ? `${t('deps.evidence')} · ${selectedFile}` : t('deps.edges')}
              actions={
                selectedFile ? (
                  <Link className="btn small" to={`/scans/${scanId}/findings?path=${encodeURIComponent(selectedFile)}`}>
                    {t('scan.viewFindings')}
                  </Link>
                ) : null
              }
              flush
            >
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('deps.from')}</th>
                    <th>{t('deps.to')}</th>
                    <th>{t('deps.kind')}</th>
                    <th>{t('deps.legend')}</th>
                    <th>{t('deps.evidence')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.slice(0, 60).map((relation, index) => (
                    <tr key={`${relation.fromPath}-${relation.toPath}-${index}`}>
                      <td className="mono" style={{ fontSize: 11 }}>
                        {relation.fromPath}
                        {relation.line ? `:${relation.line}` : ''}
                      </td>
                      <td className="mono" style={{ fontSize: 11 }}>{relation.toPath}</td>
                      <td className="muted">{KIND_KEYS[relation.kind]}</td>
                      <td>
                        <span
                          className={`badge ${
                            relation.confidence === 'CONFIRMED' ? 'neutral' : relation.confidence === 'INFERRED' ? 'warn' : 'high'
                          }`}
                        >
                          {relation.confidence === 'CONFIRMED' ? t('deps.confirmed') : relation.confidence === 'INFERRED' ? t('deps.inferred') : t('deps.unknown')}
                        </span>
                      </td>
                      <td className="dim" style={{ fontSize: 11.5 }}>{relation.evidence}</td>
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
