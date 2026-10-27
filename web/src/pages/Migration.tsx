import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  api,
  type Finding,
  type MigrationExecution,
  type MigrationPlan,
  type ValidationReport,
  type VisualValidationResult,
} from '../api';
import { useAsync, useScanSelection } from '../hooks';
import { useI18n } from '../i18n';
import { Card, Empty, ErrorBox, LevelBadge, Loading, PageHead, SeverityBadge, useToast } from '../components/ui';
import { DiffViewer, languageForPath } from '../components/editors';

export default function Migration() {
  const { scanId: routeScanId } = useParams();
  const { t, level, findingMessage } = useI18n();
  const [params] = useSearchParams();
  const selection = useScanSelection(routeScanId);
  const scanId = routeScanId ?? selection.scanId;
  const candidate = params.get('finding');

  const candidates = useAsync(
    () => (scanId ? api.findings(scanId, { limit: 1000 }) : Promise.resolve({ total: 0, items: [] })),
    [scanId],
  );
  const history = useAsync(() => (scanId ? api.migrations(scanId) : Promise.resolve({ items: [] })), [scanId]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [validation, setValidation] = useState<ValidationReport | null>(null);
  const [visualUrl, setVisualUrl] = useState('http://localhost:5173/');
  const [visualKey, setVisualKey] = useState('index');
  const [visual, setVisual] = useState<VisualValidationResult | null>(null);
  const { toast, node } = useToast();

  const automatable = useMemo(
    () => (candidates.data?.items ?? []).filter((finding) => finding.migrationLevel === 'SAFE' || finding.migrationLevel === 'CONDITIONAL'),
    [candidates.data],
  );

  useEffect(() => {
    if (!candidate) return;
    const finding = candidates.data?.items.find((item) => item.id === candidate);
    if (finding && (finding.migrationLevel === 'SAFE' || finding.migrationLevel === 'CONDITIONAL')) {
      setSelected(new Set([candidate]));
    }
  }, [candidate, candidates.data]);

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setPlan(null);
  };

  const runPreview = async (): Promise<void> => {
    if (!scanId || selected.size === 0) return;
    setBusy(true);
    try {
      const next = await api.preview(scanId, [...selected]);
      setPlan(next);
      if (next.items.every((item) => !item.applicable)) {
        toast(next.items.flatMap((item) => item.blockedReasons).join(' · ') || t('migration.blocked'));
      }
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const execute = async (): Promise<void> => {
    if (!scanId || selected.size === 0) return;
    if (!window.confirm(t('migration.confirmExecute'))) return;
    setBusy(true);
    try {
      const result = await api.execute(scanId, [...selected]);
      toast(
        result.aborted
          ? t('migration.aborted')
          : result.ok
            ? `${t('migration.applied')}: ${result.executions.length}`
            : `${t('migration.failures')}: ${result.failures.length}`,
      );
      setPlan(null);
      setSelected(new Set());
      candidates.reload();
      history.reload();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rollbackTransaction = async (id: string, scope: 'session' | 'batch', summary: string): Promise<void> => {
    const question = scope === 'session' ? t('migration.rollbackSessionConfirm') : t('migration.rollbackConfirm');
    if (!window.confirm(question)) return;
    try {
      const result = scope === 'session' ? await api.rollbackSession(id) : await api.rollbackBatch(id);
      toast(
        result.ok
          ? `${t('migration.rolledBack')}: ${summary} · ${t('migration.batchFindings', { count: result.affectedFindings ?? 0 })}`
          : (result.reason ?? t('common.error')),
      );
      history.reload();
      candidates.reload();
    } catch (err) {
      toast((err as Error).message);
    }
  };

  const runVisual = async (updateBaseline: boolean): Promise<void> => {
    if (!scanId) return;
    setBusy(true);
    try {
      const result = await api.validateVisual(scanId, {
        url: visualUrl.trim(),
        pageKey: visualKey.trim() || 'page',
        updateBaseline,
      });
      setVisual(result);
      if (!result.available) toast(result.reason ?? t('visual.unavailable'));
      else if (result.baselineCreated) toast(t('visual.baselineCreated'));
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const validate = async (): Promise<void> => {
    if (!scanId) return;
    setBusy(true);
    try {
      const report = await api.validateStatic(scanId);
      setValidation(report);
      toast(`${t('migration.validation')}: ${report.passed ? 'PASSED' : 'FAILED'}`);
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!scanId) return <div className="page"><Empty>{t('overview.noScans')}</Empty></div>;

  return (
    <div className="page">
      <PageHead
        title={t('migration.title')}
        subtitle={t('migration.subtitle')}
        actions={
          <>
            <select className="select" style={{ width: 240 }} value={scanId} onChange={(event) => selection.setScanId(event.target.value)}>
              {selection.scans.map((scan) => (
                <option key={scan.id} value={scan.id}>
                  {scan.projectName} · {new Date(scan.startedAt ?? scan.createdAt).toLocaleDateString()}
                </option>
              ))}
            </select>
            <button className="btn small" onClick={validate} disabled={busy}>
              {t('migration.validate')}
            </button>
          </>
        }
      />
      <ErrorBox error={candidates.error} onRetry={candidates.reload} />

      {validation ? (
        <div className={`callout ${validation.passed ? 'ok' : 'danger'}`} style={{ marginBottom: 12 }}>
          <div className="row wrap" style={{ fontSize: 12 }}>
            <strong>{t('migration.validation')}</strong>
            <span>
              checked {validation.findingsChecked} · resolved {validation.findingsResolved} · remaining {validation.findingsStillPresent}
            </span>
            <div className="spacer" />
            <span className={`badge ${validation.passed ? 'ok' : 'high'}`}>{validation.passed ? 'PASSED' : 'FAILED'}</span>
          </div>
          {validation.postConditionFailures.slice(0, 4).map((failure) => (
            <div key={failure} className="prose" style={{ fontSize: 11.5, marginTop: 4 }}>
              {failure}
            </div>
          ))}
          {validation.newSyntaxErrors.length ? (
            <div className="prose" style={{ fontSize: 11.5, marginTop: 4 }}>
              {validation.newSyntaxErrors.length} new syntax error(s)
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <Card
          title={`${t('migration.candidates')} · ${automatable.length}`}
          actions={
            <div className="row">
              <button
                className="btn small"
                onClick={() => {
                  setSelected(new Set(automatable.map((item) => item.id)));
                  setPlan(null);
                }}
              >
                {t('migration.selectAll')}
              </button>
              <button
                className="btn small ghost"
                onClick={() => {
                  setSelected(new Set());
                  setPlan(null);
                }}
              >
                {t('migration.clear')}
              </button>
            </div>
          }
          flush
        >
          {candidates.loading ? (
            <Loading />
          ) : automatable.length === 0 ? (
            <Empty>{t('migration.empty')}</Empty>
          ) : (
            <div style={{ maxHeight: 420, overflow: 'auto' }}>
              <table className="table">
                <tbody>
                  {automatable.map((finding: Finding) => (
                    <tr key={finding.id} className={selected.has(finding.id) ? 'selected' : ''}>
                      <td style={{ width: 26 }}>
                        <input type="checkbox" checked={selected.has(finding.id)} onChange={() => toggle(finding.id)} />
                      </td>
                      <td>
                        <div className="row" style={{ gap: 6, marginBottom: 2 }}>
                          <SeverityBadge value={finding.severity} />
                          <span className="mono muted" style={{ fontSize: 10.5 }}>{finding.ruleId}</span>
                          <LevelBadge value={finding.migrationLevel} />
                        </div>
                        <div style={{ fontSize: 12 }}>{findingMessage(finding)}</div>
                        <div className="mono muted" style={{ fontSize: 10.5 }}>
                          {finding.filePath}:{finding.startLine}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="row" style={{ padding: 10, borderTop: '1px solid var(--border)' }}>
            <span className="muted" style={{ fontSize: 12 }}>
              {t('migration.selected')}: {selected.size}
            </span>
            <div className="spacer" />
            <button className="btn" onClick={runPreview} disabled={busy || selected.size === 0}>
              {busy ? <span className="spinner" /> : null} {t('migration.preview')}
            </button>
          </div>
        </Card>

        <div className="col">
          {plan ? (
            <Card
              title={`${t('migration.diff')} · ${plan.items.filter((item) => item.applicable).length}/${plan.items.length}`}
              actions={
                <button className="btn primary small" onClick={execute} disabled={busy || !plan.items.some((item) => item.applicable)}>
                  {t('migration.execute')}
                </button>
              }
              flush
            >
              {plan.warnings.length ? (
                <div className="callout warn" style={{ margin: 10 }}>
                  {plan.warnings.map((warning) => (
                    <div key={warning} style={{ fontSize: 11.5 }}>
                      {warning}
                    </div>
                  ))}
                </div>
              ) : null}
              <div style={{ maxHeight: 480, overflow: 'auto', padding: 10 }}>
                {plan.items.map((item) => (
                  <div key={item.findingId} style={{ marginBottom: 14 }}>
                    <div className="row" style={{ marginBottom: 5, fontSize: 12 }}>
                      <span className="badge accent">{item.recipeId}</span>
                      <span className="mono muted" style={{ fontSize: 10.5 }}>
                        {item.filePath}:{item.startLine}
                      </span>
                      <div className="spacer" />
                      <span className={`badge ${item.applicable ? 'ok' : 'high'}`}>
                        {item.applicable ? t('migration.applicable') : t('migration.blocked')}
                      </span>
                    </div>
                    {item.applicable ? (
                      <DiffViewer
                        original={item.previewBefore}
                        modified={item.previewAfter}
                        language={languageForPath(item.filePath)}
                        height={190}
                      />
                    ) : (
                      <div className="callout warn" style={{ fontSize: 11.5 }}>
                        {item.blockedReasons.join(' · ') || t('migration.noRecipe')}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          ) : (
            <Card title={t('migration.history')} flush>
              {history.loading ? <Loading /> : null}
              {(history.data?.items.length ?? 0) === 0 ? (
                <Empty>{t('migration.empty')}</Empty>
              ) : (
                <HistoryTable items={history.data?.items ?? []} onRollback={rollbackTransaction} />
              )}
            </Card>
          )}
        </div>
      </div>

      {plan && history.data && history.data.items.length > 0 ? (
        <div style={{ marginTop: 14 }}>
          <Card title={t('migration.executions')} flush>
            <HistoryTable items={history.data.items} onRollback={rollbackTransaction} />
          </Card>
        </div>
      ) : null}

      <div style={{ marginTop: 14 }}>
        <Card title={t('visual.title')}>
          <div className="hint" style={{ marginBottom: 10 }}>{t('visual.hint')}</div>
          <div className="row wrap" style={{ alignItems: 'flex-end', gap: 8 }}>
            <div className="field" style={{ marginBottom: 0, minWidth: 320, flex: 1 }}>
              <label>{t('visual.url')}</label>
              <input className="input mono" value={visualUrl} onChange={(event) => setVisualUrl(event.target.value)} placeholder="http://localhost:5173/" />
            </div>
            <div className="field" style={{ marginBottom: 0, width: 180 }}>
              <label>{t('visual.pageKey')}</label>
              <input className="input mono" value={visualKey} onChange={(event) => setVisualKey(event.target.value)} placeholder="index" />
            </div>
            <button className="btn" disabled={busy || !visualUrl.trim()} onClick={() => runVisual(false)}>
              {busy ? <span className="spinner" /> : null} {t('visual.compare')}
            </button>
            <button className="btn small ghost" disabled={busy || !visualUrl.trim()} onClick={() => runVisual(true)}>
              {t('visual.updateBaseline')}
            </button>
          </div>

          {visual ? (
            visual.available ? (
              <div style={{ marginTop: 12 }}>
                <div className="row wrap" style={{ gap: 8, marginBottom: 8 }}>
                  {visual.baselineCreated ? (
                    <span className="badge accent">{t('visual.baselineCreated')}</span>
                  ) : visual.changedPixels === 0 && !visual.dimensionMismatch ? (
                    <span className="badge ok">{t('visual.unchanged')}</span>
                  ) : (
                    <span className="badge high">{t('visual.changed')}</span>
                  )}
                  <span className="badge neutral">
                    {t('visual.diffPercent')}: {visual.diffPercent}%
                  </span>
                  <span className="mono muted" style={{ fontSize: 11 }}>
                    {visual.changedPixels} / {visual.totalPixels} px · {visual.width}×{visual.height} · {visual.durationMs} ms
                  </span>
                  {visual.dimensionMismatch ? <span className="badge high">{t('visual.dimension')}</span> : null}
                </div>
                {visual.consoleErrors.length ? (
                  <div className="callout warn" style={{ marginBottom: 8, fontSize: 11.5 }}>
                    <strong>{t('visual.consoleErrors')}</strong>
                    <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                      {visual.consoleErrors.slice(0, 4).map((error) => (
                        <li key={error} className="mono">{error}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <div className="grid-2">
                  <div>
                    <div className="section-title">{t('visual.baseline')}</div>
                    {visual.baselineDataUrl ? (
                      <img
                        src={visual.baselineDataUrl}
                        alt={t('visual.baseline')}
                        style={{ width: '100%', border: '1px solid var(--border)', borderRadius: 6, background: '#fff' }}
                      />
                    ) : (
                      <Empty />
                    )}
                  </div>
                  <div>
                    <div className="section-title">{t('visual.current')}</div>
                    {visual.screenshotDataUrl ? (
                      <img
                        src={visual.screenshotDataUrl}
                        alt={t('visual.current')}
                        style={{ width: '100%', border: '1px solid var(--border)', borderRadius: 6, background: '#fff' }}
                      />
                    ) : (
                      <Empty />
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="callout warn" style={{ marginTop: 12 }}>
                <strong>{t('visual.unavailable')}</strong> — {visual.reason}
              </div>
            )
          ) : null}
        </Card>
      </div>
      {node}
    </div>
  );

  function HistoryTable({
    items,
    onRollback,
  }: {
    items: MigrationExecution[];
    onRollback: (id: string, scope: 'session' | 'batch', summary: string) => void;
  }) {
    // A row per execute() call: that is what the user confirmed, and what can actually
    // be rolled back. Rows written before sessions existed fall back to their batch.
    const groups = new Map<
      string,
      { scope: 'session' | 'batch'; id: string; files: string[]; rows: MigrationExecution[] }
    >();
    for (const item of items) {
      const scope: 'session' | 'batch' = item.sessionId ? 'session' : 'batch';
      const id = item.sessionId ?? item.batchId ?? item.id;
      const group = groups.get(id) ?? { scope, id, files: [], rows: [] };
      if (!group.files.includes(item.filePath)) group.files.push(item.filePath);
      group.rows.push(item);
      groups.set(id, group);
    }

    return (
      <table className="table">
        <thead>
          <tr>
            <th>{t('findings.file')}</th>
            <th>{t('migration.session')}</th>
            <th>{t('migration.validation')}</th>
            <th>{t('scans.started')}</th>
            <th className="right">{t('common.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {[...groups.values()].map((group) => {
            const rules = [...new Set(group.rows.map((row) => row.ruleId))];
            const allRolledBack = group.rows.every((row) => row.executionStatus === 'ROLLED_BACK');
            const failed = group.rows.some((row) => row.validationStatus === 'FAILED');
            const passed = group.rows.every((row) => row.validationStatus === 'PASSED');
            return (
              <tr key={group.id}>
                <td>
                  <div
                    className="mono"
                    style={{ fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                    title={group.files.join('\n')}
                  >
                    {group.files[0]}
                  </div>
                  <div className="mono muted" style={{ fontSize: 10.5, marginTop: 2 }}>{rules.join(' · ')}</div>
                </td>
                <td>
                  <span className="badge neutral">
                    {t('migration.sessionFiles', { files: group.files.length, findings: group.rows.length })}
                  </span>
                </td>
                <td>
                  <span className={`badge ${allRolledBack ? 'neutral' : failed ? 'high' : passed ? 'ok' : 'warn'}`}>
                    {allRolledBack ? t('migration.rolledBack') : failed ? 'FAILED' : passed ? 'PASSED' : 'PENDING'}
                  </span>
                </td>
                <td className="muted nowrap" style={{ fontSize: 11 }}>{new Date(group.rows[0].executedAt).toLocaleString()}</td>
                <td className="right">
                  <button
                    className="btn small"
                    disabled={allRolledBack}
                    onClick={() =>
                      onRollback(
                        group.id,
                        group.scope,
                        group.files.length > 1 ? `${group.files.length} files` : group.files[0],
                      )
                    }
                  >
                    {group.scope === 'session' && group.files.length > 1
                      ? t('migration.rollbackSession')
                      : t('migration.rollback')}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }
}
