import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, type Category, type Finding, type FindingStatus, type MigrationLevel, type RuleMeta, type Severity } from '../api';
import { useAsync, useDebounced, useScanSelection } from '../hooks';
import { useI18n } from '../i18n';
import {
  CategoryBadge,
  Empty,
  ErrorBox,
  Icon,
  LevelBadge,
  Loading,
  Modal,
  SeverityBadge,
  StatusBadge,
  useToast,
} from '../components/ui';
import { CodeViewer, languageForPath } from '../components/editors';

const SEVERITIES: Severity[] = ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];
const LEVELS: MigrationLevel[] = ['SAFE', 'CONDITIONAL', 'MANUAL', 'UNSUPPORTED'];
const STATUSES: FindingStatus[] = [
  'DETECTED',
  'READY_FOR_MIGRATION',
  'MIGRATED',
  'REVIEW_REQUIRED',
  'VALIDATED',
  'VALIDATION_FAILED',
  'IGNORED',
];
const CATEGORIES: Category[] = ['JS_API', 'DOM_API', 'HTML_COMPAT', 'CSS_COMPAT', 'ACTIVEX_VBSCRIPT', 'BROWSER_BEHAVIOR', 'DYNAMIC_CODE'];
const SORTS = ['risk', 'path', 'type', 'priority'] as const;

export default function Findings() {
  const { scanId: routeScanId } = useParams();
  const { t, severity, level, status, category: categoryLabel, findingMessage } = useI18n();
  const confidenceLabel = (value: Finding['confidence']): string =>
    ({ CONFIRMED: t('confidence.CONFIRMED'), POSSIBLE: t('confidence.POSSIBLE'), NEEDS_ANALYSIS: t('confidence.NEEDS_ANALYSIS') })[value];
  const [params, setParams] = useSearchParams();
  const selection = useScanSelection(routeScanId);
  const scanId = routeScanId ?? selection.scanId;

  const [search, setSearch] = useState(params.get('q') ?? '');
  const debouncedSearch = useDebounced(search, 250);
  const [selectedId, setSelectedId] = useState<string | null>(params.get('id'));
  const [ignoreOpen, setIgnoreOpen] = useState(false);
  const [ignoreReason, setIgnoreReason] = useState('');
  const [ruleOpen, setRuleOpen] = useState(false);
  const [ruleScope, setRuleScope] = useState<'file' | 'dir' | 'any'>('file');
  const [ruleReason, setRuleReason] = useState('');
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [ruleSaving, setRuleSaving] = useState(false);
  const [ruleCreated, setRuleCreated] = useState<string | null>(null);
  const navigate = useNavigate();
  const { toast, node } = useToast();

  const filters = {
    severity: params.get('severity') ?? undefined,
    migrationLevel: params.get('level') ?? undefined,
    status: params.get('status') ?? undefined,
    category: params.get('category') ?? undefined,
    ruleId: params.get('rule') ?? undefined,
    path: params.get('path') ?? undefined,
    sort: (params.get('sort') as (typeof SORTS)[number] | null) ?? 'risk',
  };

  const list = useAsync(
    () => (scanId ? api.findings(scanId, { ...filters, q: debouncedSearch || undefined, limit: 300 }) : Promise.resolve({ total: 0, items: [] })),
    [scanId, filters.severity, filters.migrationLevel, filters.status, filters.category, filters.ruleId, filters.path, filters.sort, debouncedSearch],
  );

  const detail = useAsync(() => (selectedId ? api.finding(selectedId) : Promise.resolve(null)), [selectedId]);
  const source = useAsync(() => (selectedId ? api.findingSource(selectedId) : Promise.resolve(null)), [selectedId]);

  const items = list.data?.items ?? [];
  const current: Finding | null = detail.data?.finding ?? null;

  // Keep a valid selection when filters change: pick the first visible finding.
  useEffect(() => {
    if (!items.length) return;
    if (selectedId && items.some((item) => item.id === selectedId)) return;
    setSelectedId(items[0].id);
  }, [items, selectedId]);

  const updateParam = (key: string, value: string | undefined): void => {
    const next = new URLSearchParams(params);
    if (value === undefined || value === '') next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const select = (id: string): void => {
    setSelectedId(id);
    updateParam('id', id);
  };

  const reset = (): void => {
    const next = new URLSearchParams();
    if (scanId) next.set('id', selectedId ?? '');
    setParams(next, { replace: true });
    setSearch('');
  };

  const scopePattern = (filePath: string | undefined, scope: 'file' | 'dir' | 'any'): string | null => {
    if (!filePath || scope === 'any') return null;
    if (scope === 'file') return filePath;
    const slash = filePath.lastIndexOf('/');
    return slash <= 0 ? '**' : `${filePath.slice(0, slash)}/**`;
  };

  const submitIgnoreRule = async (): Promise<void> => {
    const projectId = detail.data?.projectId;
    if (!current || !projectId || !ruleReason.trim()) return;
    setRuleSaving(true);
    setRuleError(null);
    try {
      const pattern = scopePattern(current.filePath, ruleScope);
      await api.createIgnoreRule(projectId, {
        ruleId: current.ruleId,
        pathPattern: pattern,
        reason: ruleReason.trim(),
      });
      setRuleCreated(pattern ?? t('findings.ignoreRuleAny'));
      setRuleOpen(false);
      setRuleReason('');
      toast(t('findings.ignoreRuleCreated', { pattern: pattern ?? t('findings.ignoreRuleAny') }));
    } catch (err) {
      setRuleError((err as Error).message);
    } finally {
      setRuleSaving(false);
    }
  };

  const activeFilterCount = useMemo(
    () => ['severity', 'level', 'status', 'category', 'rule', 'path'].filter((key) => params.get(key)).length,
    [params],
  );

  const setStatus = async (next: FindingStatus, note?: string): Promise<void> => {
    if (!current) return;
    try {
      await api.setFindingStatus(current.id, next, note);
      detail.reload();
      list.reload();
      toast(`${current.ruleId} → ${status(next)}`);
    } catch (err) {
      toast((err as Error).message);
    }
  };

  if (!scanId) {
    return (
      <div className="page">
        <Empty>{t('overview.noScans')}</Empty>
      </div>
    );
  }

  return (
    <div className="explorer">
      {/* ---------------- filters ---------------- */}
      <aside className="explorer-filters">
        <div className="row" style={{ marginBottom: 10 }}>
          <strong style={{ fontSize: 12 }}>{t('findings.filters')}</strong>
          {activeFilterCount > 0 ? (
            <span className="badge accent">{activeFilterCount}</span>
          ) : null}
          <div className="spacer" />
          <button className="btn ghost small" onClick={reset}>
            {t('common.reset')}
          </button>
        </div>

        <div className="filter-group">
          <div className="filter-label">{t('scans.title')}</div>
          <select className="select" value={scanId} onChange={(event) => selection.setScanId(event.target.value)}>
            {selection.scans.map((scan) => (
              <option key={scan.id} value={scan.id}>
                {scan.projectName} · {new Date(scan.startedAt ?? scan.createdAt).toLocaleDateString()} · {scan.findingCount}
              </option>
            ))}
          </select>
        </div>

        <div className="filter-group">
          <div className="filter-label">{t('findings.severity')}</div>
          <div className="row wrap" style={{ gap: 4 }}>
            {SEVERITIES.map((value) => (
              <button
                key={value}
                className={`chip ${filters.severity === value ? 'on' : ''}`}
                onClick={() => updateParam('severity', filters.severity === value ? undefined : value)}
              >
                {severity(value)}
              </button>
            ))}
          </div>
        </div>

        <div className="filter-group">
          <div className="filter-label">{t('findings.level')}</div>
          <div className="row wrap" style={{ gap: 4 }}>
            {LEVELS.map((value) => (
              <button
                key={value}
                className={`chip ${filters.migrationLevel === value ? 'on' : ''}`}
                onClick={() => updateParam('level', filters.migrationLevel === value ? undefined : value)}
              >
                {level(value)}
              </button>
            ))}
          </div>
        </div>

        <div className="filter-group">
          <div className="filter-label">{t('findings.category')}</div>
          <select className="select" value={filters.category ?? ''} onChange={(event) => updateParam('category', event.target.value || undefined)}>
            <option value="">{t('common.all')}</option>
            {CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {categoryLabel(value)}
              </option>
            ))}
          </select>
        </div>

        <div className="filter-group">
          <div className="filter-label">{t('findings.status')}</div>
          <select className="select" value={filters.status ?? ''} onChange={(event) => updateParam('status', event.target.value || undefined)}>
            <option value="">{t('common.all')}</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {status(value)}
              </option>
            ))}
          </select>
        </div>

        <div className="filter-group">
          <div className="filter-label">{t('findings.file')}</div>
          <input
            className="input mono"
            placeholder="js/common.js"
            defaultValue={filters.path ?? ''}
            onBlur={(event) => updateParam('path', event.target.value || undefined)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') updateParam('path', (event.target as HTMLInputElement).value || undefined);
            }}
          />
        </div>

        <div className="filter-group">
          <div className="filter-label">{t('findings.rule')}</div>
          <input
            className="input mono"
            placeholder="WL-JS-001"
            defaultValue={filters.ruleId ?? ''}
            onBlur={(event) => updateParam('rule', event.target.value || undefined)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') updateParam('rule', (event.target as HTMLInputElement).value || undefined);
            }}
          />
        </div>

        <div className="filter-group">
          <div className="filter-label">{t('findings.sort')}</div>
          <select className="select" value={filters.sort} onChange={(event) => updateParam('sort', event.target.value)}>
            <option value="risk">{t('findings.sortRisk')}</option>
            <option value="path">{t('findings.sortPath')}</option>
            <option value="type">{t('findings.sortType')}</option>
            <option value="priority">{t('findings.sortPriority')}</option>
          </select>
        </div>
      </aside>

      {/* ---------------- list ---------------- */}
      <section className="explorer-list">
        <div className="list-toolbar">
          <Icon name="search" />
          <input
            className="input"
            style={{ border: 'none', background: 'transparent', height: 24 }}
            placeholder={t('findings.search')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <span className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
            {list.data?.total ?? 0} {t('findings.results')}
          </span>
        </div>

        {list.loading && items.length === 0 ? <Loading /> : null}
        {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : null}
        {!list.loading && items.length === 0 ? <Empty>{t('findings.empty')}</Empty> : null}

        {items.map((finding) => (
          <button
            key={finding.id}
            className={`finding-row ${selectedId === finding.id ? 'active' : ''}`}
            onClick={() => select(finding.id)}
          >
            <div className="finding-row-top">
              <SeverityBadge value={finding.severity} />
              <span className="mono muted" style={{ fontSize: 10.5 }}>
                {finding.ruleId}
              </span>
              <div className="spacer" />
              <LevelBadge value={finding.migrationLevel} />
            </div>
            <div className="finding-row-msg">{findingMessage(finding)}</div>
            <div className="finding-row-meta">
              <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {finding.filePath}:{finding.startLine}
              </span>
              {finding.evidence.touchesDynamicRegion ? <span className="badge warn">dyn</span> : null}
            </div>
          </button>
        ))}
      </section>

      {/* ---------------- detail ---------------- */}
      <section className="explorer-detail">
        {!current ? (
          <Empty>{t('findings.selectPrompt')}</Empty>
        ) : (
          <div className="detail-pane fade-in">
            <div className="row" style={{ marginBottom: 6 }}>
              <SeverityBadge value={current.severity} />
              <LevelBadge value={current.migrationLevel} />
              <StatusBadge value={current.status} />
              <span className="badge outline">{confidenceLabel(current.confidence)}</span>
              {current.automationCandidate ? (
                <span className="badge warn" title={current.automationHint ?? undefined}>
                  {t('findings.candidateBadge')}
                </span>
              ) : null}
              {current.recipeBlocked ? (
                <span className="badge neutral" title={t('findings.blockedHint')}>
                  {t('findings.blockedBadge')}
                </span>
              ) : null}
              <div className="spacer" />
              <Link className="btn small" to={`/scans/${current.scanTaskId}/migration?finding=${current.id}`}>
                {t('findings.openMigration')}
              </Link>
            </div>

            <h2 className="detail-title">{findingMessage(current)}</h2>
            <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
              <span className="detail-loc">
                {current.filePath}:{current.startLine}:{current.startColumn}
                {current.endLine !== current.startLine ? `–${current.endLine}` : ''}
              </span>
              <span className="mono muted" style={{ fontSize: 11 }}>
                {current.ruleId} v{current.ruleVersion}
              </span>
            </div>

            <div className="section">
              <div className="section-title">{t('findings.why')}</div>
              <div className="prose">{current.risk}</div>
            </div>

            <div className="section">
              <div className="section-title">{t('findings.evidence')}</div>
              <dl className="kv">
                <dt>{t('findings.kind')}</dt>
                <dd className="mono">{current.evidence.kind}</dd>
                <dt>{t('findings.category')}</dt>
                <dd>
                  <CategoryBadge value={current.category} />
                </dd>
                {current.evidence.container ? (
                  <>
                    <dt>{t('findings.container')}</dt>
                    <dd className="mono">{current.evidence.container}</dd>
                  </>
                ) : null}
                {Object.entries(current.evidence.detail ?? {})
                  // touchesDynamicRegion is already surfaced as a badge above.
                  .filter(([key, value]) => key !== 'touchesDynamicRegion' && value !== null && value !== '')
                  .slice(0, 8)
                  .map(([key, value]) => (
                    <div key={key} style={{ display: 'contents' }}>
                      <dt>{key.replace(/([A-Z])/g, ' $1').toLowerCase()}</dt>
                      <dd className="mono" style={{ wordBreak: 'break-all' }}>
                        {String(value)}
                      </dd>
                    </div>
                  ))}
              </dl>
              <pre
                className="mono"
                style={{
                  marginTop: 8,
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '8px 10px',
                  overflow: 'auto',
                  maxHeight: 120,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {current.snippet}
              </pre>
            </div>

            <div className="section">
              <div className="section-title">{t('findings.recommendation')}</div>
              <div className="callout">{current.recommendation}</div>
            </div>

            {current.automationCandidate && current.automationHint ? (
              <div className="section">
                <div className="section-title">{t('findings.candidateBadge')}</div>
                <div className="callout">{current.automationHint}</div>
              </div>
            ) : null}

            {detail.data?.recipe ? (
              <div className="section">
                <div className="section-title">{t('findings.recipe')}</div>
                <div className="row" style={{ marginBottom: 6 }}>
                  <span className="badge accent">{detail.data.recipe.id}</span>
                  <span className="dim" style={{ fontSize: 12 }}>{detail.data.recipe.summary}</span>
                </div>
                {detail.data.recipe.caveats.length ? (
                  <>
                    <div className="section-title" style={{ marginTop: 8 }}>{t('findings.caveats')}</div>
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.6 }}>
                      {detail.data.recipe.caveats.map((caveat) => (
                        <li key={caveat}>{caveat}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </div>
            ) : null}

            <div className="section">
              <div className="section-title">
                {t('findings.source')}
                {source.data?.stale ? <span className="badge high" style={{ marginLeft: 8 }}>{t('findings.stale')}</span> : null}
              </div>
              {source.data?.stale ? <div className="callout warn" style={{ marginBottom: 8 }}>{t('findings.staleHint')}</div> : null}
              {source.data ? (
                <CodeViewer
                  value={source.data.content}
                  language={languageForPath(source.data.path)}
                  startLine={current.startLine}
                  endLine={current.endLine}
                  height={300}
                />
              ) : (
                <Loading />
              )}
            </div>

            <div className="section">
              <div className="section-title">{t('common.actions')}</div>
              <div className="row wrap">
                <button className="btn small" onClick={() => setStatus('REVIEW_REQUIRED')}>
                  {t('findings.markReview')}
                </button>
                <button className="btn small danger" onClick={() => setIgnoreOpen(true)}>
                  {t('findings.ignore')}
                </button>
                {detail.data?.projectId ? (
                  <button
                    className="btn small"
                    onClick={() => {
                      setRuleError(null);
                      setRuleOpen(true);
                    }}
                  >
                    {t('findings.ignoreRule')}
                  </button>
                ) : null}
                {items.findIndex((item) => item.id === current.id) > 0 ? (
                  <button
                    className="btn small ghost"
                    onClick={() => select(items[items.findIndex((item) => item.id === current.id) - 1].id)}
                  >
                    ← {t('findings.prev')}
                  </button>
                ) : null}
                {items.findIndex((item) => item.id === current.id) < items.length - 1 ? (
                  <button
                    className="btn small ghost"
                    onClick={() => select(items[items.findIndex((item) => item.id === current.id) + 1].id)}
                  >
                    {t('findings.next')} →
                  </button>
                ) : null}
              </div>
            </div>

            {ruleCreated ? (
              <div className="callout ok" style={{ marginTop: 12 }}>
                <div className="row wrap">
                  <span className="grow">{t('findings.ignoreRuleCreated', { pattern: ruleCreated })}</span>
                  <button
                    className="btn small"
                    onClick={async () => {
                      const projectId = detail.data?.projectId;
                      if (!projectId) return;
                      const scan = await api.startScan(projectId);
                      navigate(`/scans/${scan.id}`);
                    }}
                  >
                    {t('findings.ignoreRuleRescan')}
                  </button>
                </div>
              </div>
            ) : null}

            {(detail.data?.history.length ?? 0) > 0 ? (
              <div className="section">
                <div className="section-title">{t('findings.history')}</div>
                <table className="table">
                  <tbody>
                    {detail.data?.history.map((entry) => (
                      <tr key={entry.id}>
                        <td className="mono" style={{ fontSize: 11 }}>
                          {new Date(entry.at).toLocaleString()}
                        </td>
                        <td>
                          {entry.fromStatus ? `${entry.fromStatus} → ` : ''}
                          {entry.toStatus}
                        </td>
                        <td className="muted">{entry.actor}</td>
                        <td className="muted" style={{ fontSize: 11 }}>{entry.note ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        )}
      </section>

      {ruleOpen && current ? (
        <Modal
          title={t('findings.ignoreRule')}
          onClose={() => setRuleOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setRuleOpen(false)}>
                {t('common.cancel')}
              </button>
              <button className="btn primary" disabled={ruleSaving || !ruleReason.trim()} onClick={submitIgnoreRule}>
                {ruleSaving ? <span className="spinner" /> : null} {t('findings.ignoreRuleCreate')}
              </button>
            </>
          }
        >
          {ruleError ? <div className="callout danger" style={{ marginBottom: 10 }}>{ruleError}</div> : null}
          <dl className="kv" style={{ marginBottom: 12 }}>
            <dt>{t('findings.rule')}</dt>
            <dd className="mono">{current.ruleId}</dd>
            <dt>{t('findings.file')}</dt>
            <dd className="mono">{current.filePath}</dd>
          </dl>
          <div className="filter-group">
            <div className="filter-label">{t('findings.ignoreRuleScope')}</div>
            <div className="row wrap" style={{ gap: 4 }}>
              {(['file', 'dir', 'any'] as const).map((scope) => (
                <button
                  key={scope}
                  className={`chip ${ruleScope === scope ? 'on' : ''}`}
                  onClick={() => setRuleScope(scope)}
                >
                  {scope === 'file' ? t('findings.ignoreRuleFile') : scope === 'dir' ? t('findings.ignoreRuleDir') : t('findings.ignoreRuleAny')}
                </button>
              ))}
            </div>
            <div className="hint mono" style={{ marginTop: 6 }}>
              {scopePattern(current.filePath, ruleScope) ?? '*'}
            </div>
          </div>
          <div className="field">
            <label>{t('findings.ignoreRuleReason')}</label>
            <textarea className="textarea" rows={3} value={ruleReason} onChange={(event) => setRuleReason(event.target.value)} />
          </div>
          <div className="hint">{t('project.ignoreRuleApplies')}</div>
        </Modal>
      ) : null}

      {ignoreOpen ? (
        <Modal
          title={t('findings.ignore')}
          onClose={() => setIgnoreOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setIgnoreOpen(false)}>
                {t('common.cancel')}
              </button>
              <button
                className="btn danger"
                disabled={!ignoreReason.trim()}
                onClick={async () => {
                  await setStatus('IGNORED', ignoreReason.trim());
                  setIgnoreOpen(false);
                  setIgnoreReason('');
                }}
              >
                {t('findings.ignore')}
              </button>
            </>
          }
        >
          <div className="field">
            <label>{t('findings.ignoreReason')}</label>
            <textarea className="textarea" rows={3} value={ignoreReason} onChange={(event) => setIgnoreReason(event.target.value)} />
          </div>
        </Modal>
      ) : null}
      {node}
    </div>
  );
}
