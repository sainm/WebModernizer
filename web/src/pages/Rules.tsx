import { useMemo, useState } from 'react';
import { api, type RuleMeta } from '../api';
import { useAsync } from '../hooks';
import { useI18n } from '../i18n';
import { Card, Empty, ErrorBox, LevelBadge, Loading, Modal, PageHead, SeverityBadge, useToast } from '../components/ui';

export default function Rules() {
  const { t, category, level } = useI18n();
  const rules = useAsync(() => api.rules(), []);
  const scans = useAsync(() => api.listScans(undefined, 20), []);
  const latestScan = scans.data?.items.find((scan) => scan.status === 'COMPLETED') ?? scans.data?.items[0] ?? null;
  const summary = useAsync(() => (latestScan ? api.summary(latestScan.id) : Promise.resolve(null)), [latestScan?.id]);
  const [onlyFired, setOnlyFired] = useState(false);
  const [sortByHits, setSortByHits] = useState(false);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [detail, setDetail] = useState<RuleMeta | null>(null);
  const [detailRecipe, setDetailRecipe] = useState<{ id: string; name: string; level: 'SAFE' | 'CONDITIONAL'; summary: string; caveats: string[] } | null>(null);
  const { toast, node } = useToast();

  const hitsByRule = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of summary.data?.byRule ?? []) map.set(row.ruleId, row.count);
    return map;
  }, [summary.data]);

  const items = useMemo(() => {
    const all = rules.data?.items ?? [];
    const needle = search.trim().toLowerCase();
    const filtered = all.filter((rule) => {
      if (categoryFilter && rule.category !== categoryFilter) return false;
      if (onlyFired && !(hitsByRule.get(rule.id) ?? 0)) return false;
      if (!needle) return true;
      return (
        rule.id.toLowerCase().includes(needle) ||
        rule.name.toLowerCase().includes(needle) ||
        rule.description.toLowerCase().includes(needle) ||
        rule.tags.some((tag) => tag.includes(needle))
      );
    });
    return sortByHits ? [...filtered].sort((a, b) => (hitsByRule.get(b.id) ?? 0) - (hitsByRule.get(a.id) ?? 0)) : filtered;
  }, [rules.data, search, categoryFilter, onlyFired, sortByHits, hitsByRule]);

  const firedCount = (rules.data?.items ?? []).filter((rule) => (hitsByRule.get(rule.id) ?? 0) > 0).length;

  const toggle = async (rule: RuleMeta): Promise<void> => {
    try {
      await api.setRuleEnabled(rule.id, !rule.enabled);
      rules.reload();
    } catch (err) {
      toast((err as Error).message);
    }
  };

  const openDetail = async (rule: RuleMeta): Promise<void> => {
    setDetail(rule);
    try {
      const payload = await api.rule(rule.id);
      setDetailRecipe(payload.recipe);
    } catch {
      setDetailRecipe(null);
    }
  };

  if (rules.loading) return <Loading />;

  return (
    <div className="page">
      <PageHead
        title={t('rules.title')}
        subtitle={t('rules.subtitle')}
        actions={
          <>
            <span className="badge neutral">{items.length}</span>
            {latestScan ? <span className="hint">{firedCount} / {rules.data?.total ?? 0}</span> : null}
            <input className="input" style={{ width: 240 }} placeholder={t('common.search')} value={search} onChange={(event) => setSearch(event.target.value)} />
            <label className="check" title={latestScan ? t('rules.hitsHint', { scan: latestScan.id.slice(0, 12) }) : undefined}>
              <input type="checkbox" checked={onlyFired} onChange={(event) => setOnlyFired(event.target.checked)} />
              {t('rules.onlyFired')}
            </label>
            <button className={`btn small ${sortByHits ? 'primary' : ''}`} onClick={() => setSortByHits((value) => !value)}>
              {t('rules.sortByHits')}
            </button>
            <select className="select" style={{ width: 190 }} value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
              <option value="">{t('common.all')}</option>
              {['JS_API', 'DOM_API', 'HTML_COMPAT', 'CSS_COMPAT', 'ACTIVEX_VBSCRIPT', 'BROWSER_BEHAVIOR', 'DYNAMIC_CODE'].map((value) => (
                <option key={value} value={value}>
                  {category(value as RuleMeta['category'])}
                </option>
              ))}
            </select>
          </>
        }
      />
      <ErrorBox error={rules.error} onRetry={rules.reload} />

      <Card flush>
        {items.length === 0 ? (
          <Empty />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('rules.id')}</th>
                <th>{t('rules.name')}</th>
                <th>{t('rules.category')}</th>
                <th>{t('rules.severity')}</th>
                <th>{t('rules.level')}</th>
                <th className="num">{t('rules.hits')}</th>
                <th>{t('rules.tests')}</th>
                <th>{t('rules.enabled')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((rule) => (
                <tr key={rule.id} className="clickable" onClick={() => openDetail(rule)}>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {rule.id}
                  </td>
                  <td>
                    <div style={{ fontWeight: 550 }}>{rule.name}</div>
                    <div className="muted" style={{ fontSize: 11 }}>
                      v{rule.version} · {rule.language}
                    </div>
                  </td>
                  <td className="muted">{category(rule.category)}</td>
                  <td>
                    <SeverityBadge value={rule.defaultSeverity} />
                  </td>
                  <td>
                    <LevelBadge value={rule.defaultMigrationLevel} />
                  </td>
                  <td className="num">
                    {(hitsByRule.get(rule.id) ?? 0) > 0 ? (
                      <span className="badge accent">{hitsByRule.get(rule.id)}</span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${rule.testStatus === 'COVERED' ? 'ok' : rule.testStatus === 'PARTIAL' ? 'warn' : 'neutral'}`}>
                      {t(`rules.testStatus.${rule.testStatus}` as 'rules.testStatus.COVERED')}
                    </span>
                  </td>
                  <td onClick={(event) => event.stopPropagation()}>
                    <button className="btn small" onClick={() => toggle(rule)}>
                      {rule.enabled ? t('common.enabled') : t('common.disabled')}
                    </button>
                  </td>
                  <td className="right muted">
                    {rule.implemented ? <span className="badge accent">{t('rules.recipe')}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {detail ? (
        <Modal
          title={`${detail.id} · ${detail.name}`}
          onClose={() => {
            setDetail(null);
            setDetailRecipe(null);
          }}
          footer={
            <button
              className="btn"
              onClick={() => {
                setDetail(null);
                setDetailRecipe(null);
              }}
            >
              {t('common.close')}
            </button>
          }
        >
          <div className="row" style={{ marginBottom: 10, gap: 6 }}>
            <SeverityBadge value={detail.defaultSeverity} />
            <LevelBadge value={detail.defaultMigrationLevel} />
            <span className="badge outline">{category(detail.category)}</span>
            <span className="badge neutral">v{detail.version}</span>
          </div>
          <div className="section">
            <div className="section-title">{t('rules.description')}</div>
            <div className="prose">{detail.description}</div>
          </div>
          <div className="section">
            <div className="section-title">{t('rules.basis')}</div>
            <div className="prose">{detail.basis}</div>
          </div>
          {detailRecipe ? (
            <div className="section">
              <div className="section-title">{t('rules.recipe')}</div>
              <div className="callout">
                <div className="row" style={{ marginBottom: 4 }}>
                  <span className="badge accent">{detailRecipe.id}</span>
                  <span className="badge ok">{level(detailRecipe.level)}</span>
                </div>
                <div>{detailRecipe.summary}</div>
                {detailRecipe.caveats.length ? (
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    {detailRecipe.caveats.map((caveat) => (
                      <li key={caveat}>{caveat}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
          ) : null}
          <div className="section">
            <div className="hint">{t('rules.toggleHint')}</div>
          </div>
        </Modal>
      ) : null}
      {node}
    </div>
  );
}
