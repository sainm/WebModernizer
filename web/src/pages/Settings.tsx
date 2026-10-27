import { api } from '../api';
import { useAsync } from '../hooks';
import { LOCALE_LABELS, useI18n, type Locale } from '../i18n';
import { Card, ErrorBox, Loading, PageHead } from '../components/ui';

export default function Settings() {
  const { t, locale, setLocale } = useI18n();
  const health = useAsync(() => api.health(), []);
  const meta = useAsync(() => api.meta(), []);

  return (
    <div className="page">
      <PageHead title={t('settings.title')} />
      <ErrorBox error={health.error ?? meta.error} onRetry={() => { health.reload(); meta.reload(); }} />

      <div className="grid-2">
        <Card title={t('settings.language')}>
          <div className="col" style={{ gap: 8 }}>
            {(Object.keys(LOCALE_LABELS) as Locale[]).map((code) => (
              <label key={code} className="check">
                <input type="radio" checked={locale === code} onChange={() => setLocale(code)} />
                <span style={{ color: 'var(--text)' }}>{LOCALE_LABELS[code]}</span>
                <span className="muted">{code}</span>
              </label>
            ))}
          </div>
          <div className="hint" style={{ marginTop: 10 }}>
            {t('settings.languageHint')}
          </div>
        </Card>

        <Card title={t('settings.about')}>
          {health.loading || meta.loading ? (
            <Loading />
          ) : (
            <dl className="kv">
              <dt>{t('settings.version')}</dt>
              <dd className="mono">{health.data?.version ?? '—'}</dd>
              <dt>{t('settings.rules')}</dt>
              <dd>{health.data?.rules ?? '—'}</dd>
              <dt>{t('settings.recipes')}</dt>
              <dd>{health.data?.recipes ?? '—'}</dd>
              <dt>{t('settings.encodings')}</dt>
              <dd className="mono" style={{ wordBreak: 'break-all' }}>
                {(meta.data?.defaultEncodings ?? []).join(', ')}
              </dd>
              <dt>{t('settings.dataDir')}</dt>
              <dd className="mono">./data</dd>
            </dl>
          )}
          <div className="hint" style={{ marginTop: 8 }}>
            {t('settings.dataDirHint')}
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 14 }}>
        <Card title={t('settings.security')}>
          <div className="callout ok">{t('settings.securityBody')}</div>
        </Card>
      </div>
    </div>
  );
}
