import { NavLink, useLocation } from 'react-router-dom';
import { useI18n, LOCALE_LABELS, type Locale } from '../i18n';
import { Icon } from './ui';

const NAV_ITEMS: Array<{ to: string; key: 'nav.overview' | 'nav.projects' | 'nav.scans' | 'nav.findings' | 'nav.dependencies' | 'nav.migration' | 'nav.rules' | 'nav.reports' | 'nav.settings'; icon: string; end?: boolean }> = [
  { to: '/', key: 'nav.overview', icon: 'overview', end: true },
  { to: '/projects', key: 'nav.projects', icon: 'projects' },
  { to: '/scans', key: 'nav.scans', icon: 'scans' },
  { to: '/findings', key: 'nav.findings', icon: 'findings' },
  { to: '/dependencies', key: 'nav.dependencies', icon: 'dependencies' },
  { to: '/migration', key: 'nav.migration', icon: 'migration' },
  { to: '/rules', key: 'nav.rules', icon: 'rules' },
  { to: '/reports', key: 'nav.reports', icon: 'reports' },
  { to: '/settings', key: 'nav.settings', icon: 'settings' },
];

export function AppShell({ children, version }: { children: React.ReactNode; version: string | null }) {
  const { t, locale, setLocale } = useI18n();
  const location = useLocation();

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-name">
            <span className="brand-mark">WL</span>
            {t('app.name')}
          </div>
          <div className="brand-tagline">{t('app.tagline')}</div>
        </div>

        <nav className="nav">
          {NAV_ITEMS.map((item) => {
            // Global entries stay active for their scan-scoped counterparts, so the
            // sidebar always shows where the user is.
            const active =
              item.to === '/'
                ? location.pathname === '/'
                : location.pathname === item.to || location.pathname.startsWith(`${item.to}/`) ||
                  (item.to === '/findings' && location.pathname.endsWith('/findings')) ||
                  (item.to === '/dependencies' && location.pathname.endsWith('/dependencies')) ||
                  (item.to === '/migration' && location.pathname.endsWith('/migration')) ||
                  (item.to === '/scans' && location.pathname.startsWith('/scans'));
            return (
              <NavLink key={item.to} to={item.to} className={active ? 'nav-item active' : 'nav-item'} end={item.end}>
                <Icon name={item.icon} className="nav-icon" />
                {t(item.key)}
              </NavLink>
            );
          })}
        </nav>

        <div className="sidebar-foot">
          <div className="seg" role="group" aria-label="language">
            {(Object.keys(LOCALE_LABELS) as Locale[]).map((code) => (
              <button
                key={code}
                className={locale === code ? 'active' : ''}
                onClick={() => setLocale(code)}
                title={LOCALE_LABELS[code]}
                style={{ flex: 1 }}
              >
                {code === 'zh' ? '中' : code === 'ja' ? '日' : 'EN'}
              </button>
            ))}
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            v{version ?? '0.1.0'} · local only
          </div>
        </div>
      </aside>

      <main className="main">{children}</main>
    </div>
  );
}
