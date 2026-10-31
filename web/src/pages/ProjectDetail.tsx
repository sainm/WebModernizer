import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, formatDuration, formatTime, type IgnoreImpact } from '../api';
import { useAsync } from '../hooks';
import { useI18n } from '../i18n';
import { Card, Empty, ErrorBox, LineChart, Loading, PageHead, Stat } from '../components/ui';

export default function ProjectDetail() {
  const { projectId } = useParams();
  const { t, scanStatus } = useI18n();
  const navigate = useNavigate();
  const project = useAsync(() => api.getProject(projectId as string), [projectId]);
  const trend = useAsync(
    () => (projectId ? api.trend(projectId) : Promise.resolve({ points: [] as Array<never> })),
    [projectId],
  );
  const ignoreRules = useAsync(
    () => (projectId ? api.listIgnoreRules(projectId) : Promise.resolve({ items: [] })),
    [projectId],
  );
  const [ruleId, setRuleId] = useState('');
  const [pathPattern, setPathPattern] = useState('');
  const [reason, setReason] = useState('');
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [savingRule, setSavingRule] = useState(false);
  const [impact, setImpact] = useState<IgnoreImpact | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [ruleNotice, setRuleNotice] = useState<string | null>(null);

  // Preview what the typed rule would silence, before it is saved.
  useEffect(() => {
    if (!projectId) return undefined;
    const trimmedRule = ruleId.trim();
    const trimmedPath = pathPattern.trim();
    if (!trimmedRule && !trimmedPath) {
      setImpact(null);
      return undefined;
    }
    const timer = setTimeout(() => {
      setImpactLoading(true);
      api
        .previewIgnoreRule(projectId, { ruleId: trimmedRule || null, pathPattern: trimmedPath || null })
        .then(setImpact)
        .catch(() => setImpact(null))
        .finally(() => setImpactLoading(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [projectId, ruleId, pathPattern]);

  const addIgnoreRule = async (): Promise<void> => {
    if (!projectId || !reason.trim()) return;
    setSavingRule(true);
    setRuleError(null);
    try {
      await api.createIgnoreRule(projectId, {
        ruleId: ruleId.trim() || null,
        pathPattern: pathPattern.trim() || null,
        reason: reason.trim(),
      });
      setRuleId('');
      setPathPattern('');
      setReason('');
      ignoreRules.reload();
      await reapplyRules();
    } catch (err) {
      setRuleError((err as Error).message);
    } finally {
      setSavingRule(false);
    }
  };

  /** Rules otherwise only apply on the next scan; re-evaluate the newest one in place. */
  const reapplyRules = async (): Promise<void> => {
    if (!projectId) return;
    try {
      const applied = await api.applyIgnoreRules(projectId);
      setRuleNotice(t('ignore.applied', { ignored: applied.ignored, unignored: applied.unignored }));
      project.reload();
    } catch (err) {
      setRuleError((err as Error).message);
    }
  };

  const toggleIgnoreRule = async (id: string, enabled: boolean): Promise<void> => {
    try {
      await api.setIgnoreRuleEnabled(id, enabled);
      ignoreRules.reload();
      await reapplyRules();
    } catch (err) {
      setRuleError((err as Error).message);
    }
  };

  const removeIgnoreRule = async (id: string): Promise<void> => {
    try {
      await api.deleteIgnoreRule(id);
      ignoreRules.reload();
      await reapplyRules();
    } catch (err) {
      setRuleError((err as Error).message);
    }
  };

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

      {trend.data && trend.data.points.length >= 2 ? (
        <div style={{ marginBottom: 16 }}>
          <Card
            title={t('project.trend')}
            actions={
              <span className="row" style={{ gap: 12, fontSize: 11 }}>
                <span className="row" style={{ gap: 4 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--medium)' }} />
                  <span className="muted">{t('project.trendManual')}</span>
                </span>
                <span className="row" style={{ gap: 4 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--ok)' }} />
                  <span className="muted">{t('project.trendConvertible')}</span>
                </span>
              </span>
            }
          >
            <LineChart
              ariaLabel={t('project.trend')}
              series={[
                {
                  label: t('project.trendManual'),
                  color: 'var(--medium)',
                  values: trend.data.points.map((point) => point.byLevel.MANUAL),
                },
                {
                  label: t('project.trendConvertible'),
                  color: 'var(--ok)',
                  values: trend.data.points.map((point) => point.byLevel.SAFE + point.byLevel.CONDITIONAL),
                },
              ]}
            />
            <div className="row wrap" style={{ marginTop: 6, fontSize: 11 }}>
              <span className="muted grow">
                {formatTime(trend.data.points[0].at)} → {formatTime(trend.data.points[trend.data.points.length - 1].at)} ·{' '}
                {t('project.trendPoints', { count: trend.data.points.length })}
              </span>
              <span className="muted">{t('project.trendHint')}</span>
            </div>
          </Card>
        </div>
      ) : null}

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

      <div style={{ marginTop: 14 }}>
        <Card title={t('project.ignoreRules')} flush>
          <div style={{ padding: '12px 14px 4px' }}>
            <div className="hint" style={{ marginBottom: 10 }}>{t('project.ignoreRulesHint')}</div>
            {ruleError ? <div className="callout danger" style={{ marginBottom: 10 }}>{ruleError}</div> : null}
            <div className="row wrap" style={{ alignItems: 'flex-end', gap: 8 }}>
              <div className="field" style={{ marginBottom: 0, width: 170 }}>
                <label>{t('project.ignoreRuleRule')}</label>
                <input className="input mono" value={ruleId} onChange={(event) => setRuleId(event.target.value)} placeholder="WL-CSS-004" />
              </div>
              <div className="field" style={{ marginBottom: 0, width: 220 }}>
                <label>{t('project.ignoreRulePath')}</label>
                <input className="input mono" value={pathPattern} onChange={(event) => setPathPattern(event.target.value)} placeholder="vendor/**" />
              </div>
              <div className="field" style={{ marginBottom: 0, minWidth: 240, flex: 1 }}>
                <label>{t('project.ignoreRuleReason')}</label>
                <input className="input" value={reason} onChange={(event) => setReason(event.target.value)} />
              </div>
              <button className="btn primary" onClick={addIgnoreRule} disabled={savingRule || !reason.trim()}>
                {savingRule ? <span className="spinner" /> : null} {t('project.addIgnoreRule')}
              </button>
            </div>
            {ruleNotice ? (
              <div className="callout ok" style={{ marginTop: 10 }}>
                {ruleNotice}
              </div>
            ) : null}
            {impactLoading ? (
              <div className="hint" style={{ marginTop: 6 }}>
                <span className="spinner" /> {t('ignore.previewCounting')}
              </div>
            ) : impact ? (
              <div className={`callout ${impact.matched === 0 ? 'warn' : ''}`} style={{ marginTop: 10 }}>
                {impact.matched === 0 ? (
                  t('ignore.previewNone')
                ) : (
                  <div className="row wrap" style={{ gap: 6 }}>
                    <span className="grow">
                      {t('ignore.previewResult', {
                        new: impact.newlyIgnored,
                        total: impact.matched,
                        already: impact.alreadyIgnored,
                      })}
                    </span>
                    {impact.byRule.map((entry) => (
                      <span key={entry.ruleId} className="badge neutral">
                        {entry.ruleId} ×{entry.count}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
            <div className="hint" style={{ marginTop: 6 }}>{t('project.ignoreRuleApplies')}</div>
          </div>

          {(ignoreRules.data?.items.length ?? 0) === 0 ? (
            <Empty>{t('project.ignoreRulesEmpty')}</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('rules.id')}</th>
                  <th>{t('project.pathPattern')}</th>
                  <th>{t('project.ignoreRuleReason')}</th>
                  <th>{t('findings.status')}</th>
                  <th className="right">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {(ignoreRules.data?.items ?? []).map((rule) => (
                  <tr key={rule.id}>
                    <td className="mono" style={{ fontSize: 11 }}>
                      {rule.ruleId ?? <span className="muted">{t('project.ignoreRuleAny')}</span>}
                    </td>
                    <td className="mono" style={{ fontSize: 11 }}>
                      {rule.pathPattern ?? <span className="muted">{t('project.ignoreRuleAny')}</span>}
                    </td>
                    <td style={{ fontSize: 12 }}>{rule.reason}</td>
                    <td>
                      <span className={`badge ${rule.enabled ? 'ok' : 'neutral'}`}>
                        {rule.enabled ? t('common.enabled') : t('common.disabled')}
                      </span>
                    </td>
                    <td className="right nowrap">
                      <button className="btn small" onClick={() => toggleIgnoreRule(rule.id, !rule.enabled)}>
                        {rule.enabled ? t('common.disable') : t('common.enable')}
                      </button>{' '}
                      <button className="btn small danger" onClick={() => removeIgnoreRule(rule.id)}>
                        {t('common.delete')}
                      </button>
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
