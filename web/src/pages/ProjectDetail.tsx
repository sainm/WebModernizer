import { useNavigate, useParams } from 'react-router-dom';
import { api, formatDuration, formatTime } from '../api';
import { useAsync } from '../hooks';
import { useI18n } from '../i18n';
import { Card, Empty, ErrorBox, Loading, PageHead, Stat } from '../components/ui';

export default function ProjectDetail() {
  const { projectId } = useParams();
  const { t, scanStatus } = useI18n();
  const navigate = useNavigate();
  const project = useAsync(() => api.getProject(projectId as string), [projectId]);

  if (project.loading) return <Loading />;
  if (project.error) return <div className="page"><ErrorBox error={project.error} onRetry={project.reload} /></div>;
  if (!project.data) return <div className="page"><Empty>{t('project.notFound')}</Empty></div>;

  const data = project.data;
  const scans = data.scans ?? [];

  const runScan = async (): Promise<void> => {
    const scan = await api.startScan(data.id);
    navigate(`/scans/${scan.id}`);
  };

  return (
    <div className="page">
      <PageHead
        title={data.name}
        subtitle={data.rootPath}
        actions={
          <button className="btn primary" onClick={runScan}>
            {t('project.runScan')}
          </button>
        }
      />

      <div className="grid-stats">
        <Stat label={t('scans.findings')} value={data.lastScan?.findingCount ?? scans[0]?.findingCount ?? '—'} />
        <Stat label={t('overview.files')} value={scans[0]?.scannedFileCount ?? '—'} />
        <Stat label={t('scans.started')} value={scans[0] ? formatTime(scans[0].startedAt ?? scans[0].createdAt) : '—'} small />
        <Stat label={t('scans.duration')} value={scans[0] ? formatDuration(scans[0].startedAt, scans[0].completedAt) : '—'} small />
      </div>

      <div className="grid-2">
        <Card title={t('project.config')}>
          <dl className="kv">
            <dt>{t('project.path')}</dt>
            <dd className="mono" style={{ wordBreak: 'break-all' }}>{data.rootPath}</dd>
            <dt>{t('project.fileTypes')}</dt>
            <dd className="mono">{data.config.includeExtensions.join(' ')}</dd>
            <dt>{t('project.encodings')}</dt>
            <dd className="mono">{data.config.encodingCandidates.join(', ')}</dd>
            <dt>{t('project.maxSize')}</dt>
            <dd>{Math.round(data.config.maxFileSizeBytes / 1024)} KB</dd>
            <dt>{t('project.modules')}</dt>
            <dd>
              {data.config.modules.map((module) => (
                <span key={module.name} className="badge neutral" style={{ marginRight: 4 }}>
                  {module.name} · <span className="mono">{module.path}</span>
                </span>
              ))}
            </dd>
            <dt>{t('projects.created')}</dt>
            <dd>{formatTime(data.createdAt)}</dd>
          </dl>
        </Card>

        <Card title={t('project.scanHistory')} flush>
          {scans.length === 0 ? (
            <Empty>{t('projects.never')}</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('scans.started')}</th>
                  <th>{t('scans.status')}</th>
                  <th className="num">{t('scans.files')}</th>
                  <th className="num">{t('scans.findings')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {scans.map((scan) => (
                  <tr key={scan.id} className="clickable" onClick={() => navigate(`/scans/${scan.id}`)}>
                    <td className="nowrap">{formatTime(scan.startedAt ?? scan.createdAt)}</td>
                    <td>
                      <span className={`badge ${scan.status === 'FAILED' ? 'high' : scan.status === 'RUNNING' ? 'accent' : 'neutral'}`}>
                        {scanStatus(scan.status)}
                      </span>
                    </td>
                    <td className="num">{scan.scannedFileCount}</td>
                    <td className="num">{scan.findingCount}</td>
                    <td className="right mono muted" style={{ fontSize: 10.5 }}>
                      {scan.id.slice(0, 10)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}
