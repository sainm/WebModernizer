import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, formatTime } from '../api';
import { useAsync } from '../hooks';
import { useI18n } from '../i18n';
import { Card, Empty, ErrorBox, Loading, Modal, PageHead, useToast } from '../components/ui';
import { Link } from 'react-router-dom';

export default function Projects() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const projects = useAsync(() => api.listProjects(), []);
  const [creating, setCreating] = useState(params.get('new') === '1');
  const [name, setName] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const { toast, node } = useToast();

  useEffect(() => {
    if (params.get('new') === '1') setCreating(true);
  }, [params]);

  const closeModal = (): void => {
    setCreating(false);
    if (params.get('new')) {
      params.delete('new');
      setParams(params, { replace: true });
    }
  };

  const create = async (): Promise<void> => {
    setBusy(true);
    setFormError(null);
    try {
      const project = await api.createProject({ name, rootPath });
      closeModal();
      projects.reload();
      toast(`${project.name} · ${t('projects.created')}`);
      navigate(`/projects/${project.id}`);
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const scanNow = async (projectId: string): Promise<void> => {
    try {
      const scan = await api.startScan(projectId);
      toast(t('projects.scanning'));
      navigate(`/scans/${scan.id}`);
    } catch (err) {
      toast((err as Error).message);
    }
  };

  const remove = async (projectId: string, name: string): Promise<void> => {
    if (!window.confirm(t('projects.deleteConfirm'))) return;
    try {
      await api.deleteProject(projectId);
      toast(`${t('projects.delete')}: ${name}`);
      projects.reload();
    } catch (err) {
      toast((err as Error).message);
    }
  };

  return (
    <div className="page">
      <PageHead
        title={t('projects.title')}
        subtitle={t('projects.subtitle')}
        actions={
          <button className="btn primary" onClick={() => setCreating(true)}>
            {t('projects.new')}
          </button>
        }
      />
      <ErrorBox error={projects.error} onRetry={projects.reload} />

      {projects.loading ? (
        <Loading />
      ) : (projects.data?.items.length ?? 0) === 0 ? (
        <Card>
          <Empty>{t('projects.empty')}</Empty>
        </Card>
      ) : (
        <Card flush>
          <table className="table">
            <thead>
              <tr>
                <th>{t('projects.name')}</th>
                <th>{t('projects.path')}</th>
                <th>{t('projects.lastScan')}</th>
                <th>{t('projects.created')}</th>
                <th className="right">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {(projects.data?.items ?? []).map((project) => (
                <tr key={project.id}>
                  <td>
                    <Link to={`/projects/${project.id}`} style={{ fontWeight: 600 }}>
                      {project.name}
                    </Link>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {project.config.includeExtensions.join(' ')}
                    </div>
                  </td>
                  <td className="mono" style={{ maxWidth: 320, wordBreak: 'break-all' }}>
                    {project.rootPath}
                  </td>
                  <td>
                    {project.lastScan ? (
                      <Link to={`/scans/${project.lastScan.id}`}>
                        {formatTime(project.lastScan.startedAt ?? project.lastScan.createdAt)} · {project.lastScan.findingCount}
                      </Link>
                    ) : (
                      <span className="muted">{t('projects.never')}</span>
                    )}
                  </td>
                  <td className="muted nowrap">{formatTime(project.createdAt)}</td>
                  <td className="right nowrap">
                    <button className="btn small" onClick={() => scanNow(project.id)}>
                      {t('projects.scanNow')}
                    </button>{' '}
                    <button className="btn small danger" onClick={() => remove(project.id, project.name)}>
                      {t('projects.delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {creating ? (
        <Modal
          title={t('projects.new')}
          onClose={closeModal}
          footer={
            <>
              <button className="btn" onClick={closeModal}>
                {t('common.cancel')}
              </button>
              <button className="btn primary" onClick={create} disabled={busy || !name.trim() || !rootPath.trim()}>
                {busy ? <span className="spinner" /> : null} {t('projects.new')}
              </button>
            </>
          }
        >
          {formError ? <div className="callout danger" style={{ marginBottom: 10 }}>{formError}</div> : null}
          <div className="field">
            <label>{t('projects.name')}</label>
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder={t('projects.namePlaceholder')} />
          </div>
          <div className="field">
            <label>{t('projects.path')}</label>
            <input className="input mono" value={rootPath} onChange={(event) => setRootPath(event.target.value)} placeholder="/srv/apps/legacy-orders" />
            <span className="hint">{t('projects.pathHint')}</span>
          </div>
          <div className="callout">{t('projects.excludeHint')}</div>
        </Modal>
      ) : null}
      {node}
    </div>
  );
}
