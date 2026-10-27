import { type ReactNode, useEffect, useState } from 'react';
import type { Category, FindingStatus, MigrationLevel, Severity } from '../api';
import { useI18n } from '../i18n';

/* ---------------------------------- icons ---------------------------------- */

const PATHS: Record<string, ReactNode> = {
  overview: (
    <>
      <rect x="1.5" y="1.5" width="5" height="5" rx="1" />
      <rect x="9.5" y="1.5" width="5" height="5" rx="1" />
      <rect x="1.5" y="9.5" width="5" height="5" rx="1" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
    </>
  ),
  projects: <path d="M1.5 4.5h4l1.2 1.6h7.8v6.9a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />,
  scans: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.6V8l2.2 1.6" />
    </>
  ),
  findings: (
    <>
      <path d="M8 2.2 14.2 13H1.8z" />
      <path d="M8 6v3" />
      <path d="M8 11v.01" />
    </>
  ),
  dependencies: (
    <>
      <circle cx="3.5" cy="3.5" r="2" />
      <circle cx="12.5" cy="3.5" r="2" />
      <circle cx="8" cy="12.5" r="2" />
      <path d="M5.4 4.4 6.8 11M10.6 4.4 9.2 11" />
    </>
  ),
  migration: (
    <>
      <path d="M2 8h9" />
      <path d="M8.5 4.5 12 8l-3.5 3.5" />
    </>
  ),
  rules: (
    <>
      <path d="M2 3.5h12" />
      <path d="M2 8h12" />
      <path d="M2 12.5h8" />
    </>
  ),
  reports: (
    <>
      <path d="M3.5 1.8h6L13 5.3v8.9h-9.5z" />
      <path d="M9.2 1.8v3.6H13" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.6v1.8M8 12.6v1.8M1.6 8h1.8M12.6 8h1.8M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.4" />
      <path d="M10.4 10.4 14 14" />
    </>
  ),
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  check: <path d="M3 8.4l3.2 3.2L13 4.8" />,
};

export function Icon({ name, size = 15, className }: { name: keyof typeof PATHS | string; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name] ?? null}
    </svg>
  );
}

/* ---------------------------------- badges ---------------------------------- */

const SEVERITY_CLASS: Record<Severity, string> = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  UNKNOWN: 'neutral',
};

const LEVEL_CLASS: Record<MigrationLevel, string> = {
  SAFE: 'ok',
  CONDITIONAL: 'warn',
  MANUAL: 'neutral',
  UNSUPPORTED: 'purple',
};

const STATUS_CLASS: Record<FindingStatus, string> = {
  DETECTED: 'neutral',
  READY_FOR_MIGRATION: 'accent',
  MIGRATED: 'ok',
  REVIEW_REQUIRED: 'warn',
  VALIDATED: 'ok',
  VALIDATION_FAILED: 'high',
  IGNORED: 'neutral',
};

export function SeverityBadge({ value }: { value: Severity }) {
  const { severity } = useI18n();
  return <span className={`badge ${SEVERITY_CLASS[value]}`}>{severity(value)}</span>;
}

export function LevelBadge({ value }: { value: MigrationLevel }) {
  const { level } = useI18n();
  return <span className={`badge ${LEVEL_CLASS[value]}`}>{level(value)}</span>;
}

export function StatusBadge({ value }: { value: FindingStatus }) {
  const { status } = useI18n();
  return <span className={`badge ${STATUS_CLASS[value]}`}>{status(value)}</span>;
}

export function CategoryBadge({ value }: { value: Category }) {
  const { category } = useI18n();
  return <span className="badge outline">{category(value)}</span>;
}

export function Tag({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

/* ---------------------------------- layout ---------------------------------- */

export function PageHead({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div className="grow">
        <h1 className="page-title">{title}</h1>
        {subtitle ? <p className="page-sub">{subtitle}</p> : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
  flush,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}) {
  return (
    <section className="card">
      {title ? (
        <header className="card-head">
          <span className="grow">{title}</span>
          {actions}
        </header>
      ) : null}
      <div className={flush ? 'card-body flush' : 'card-body'}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, foot, small }: { label: string; value: ReactNode; foot?: string; small?: boolean }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={small ? 'stat-value small' : 'stat-value'}>{value}</div>
      {foot ? <div className="stat-foot">{foot}</div> : null}
    </div>
  );
}

export function Empty({ children }: { children?: ReactNode }) {
  const { t } = useI18n();
  return <div className="empty">{children ?? t('common.empty')}</div>;
}

export function Spinner() {
  return <span className="spinner" />;
}

export function ErrorBox({ error, onRetry }: { error: Error | null; onRetry?: () => void }) {
  const { t } = useI18n();
  if (!error) return null;
  return (
    <div className="callout danger" style={{ marginBottom: 12 }}>
      <div className="row">
        <strong>{t('common.error')}</strong>
        <span className="grow mono">{error.message}</span>
        {onRetry ? (
          <button className="btn small" onClick={onRetry}>
            {t('common.retry')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function Loading({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <div className="row" style={{ padding: 20, color: 'var(--text-3)' }}>
      <Spinner /> {label ?? t('common.loading')}
    </div>
  );
}

/* ---------------------------------- charts ---------------------------------- */

export function BarList({
  items,
  onSelect,
  colorFor,
}: {
  items: Array<{ label: string; value: number; key?: string }>;
  onSelect?: (key: string) => void;
  colorFor?: (key: string | undefined) => string;
}) {
  const max = Math.max(1, ...items.map((item) => item.value));
  return (
    <div className="barlist">
      {items.map((item) => (
        <div
          key={item.key ?? item.label}
          className={onSelect ? 'barlist-row clickable' : 'barlist-row'}
          onClick={onSelect && item.key ? () => onSelect(item.key as string) : undefined}
        >
          <span className="barlist-label" title={item.label}>
            {item.label}
          </span>
          <span className="barlist-track">
            <span
              className="barlist-fill"
              style={{
                width: `${Math.round((item.value / max) * 100)}%`,
                background: colorFor?.(item.key) ?? 'var(--accent)',
                opacity: item.value === 0 ? 0.25 : 1,
              }}
            />
          </span>
          <span className="barlist-value">{item.value}</span>
        </div>
      ))}
    </div>
  );
}

const DONUT_COLORS = ['#c0271d', '#d98216', '#2456d6', '#8b93a3'];

export function Donut({
  slices,
  total,
  centerLabel,
}: {
  slices: Array<{ label: string; value: number; color?: string }>;
  total?: number;
  centerLabel?: string;
}) {
  const sum = total ?? slices.reduce((acc, slice) => acc + slice.value, 0);
  const radius = 46;
  const stroke = 13;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const visible = slices.filter((slice) => slice.value > 0);

  return (
    <div className="donut-wrap">
      <svg width="118" height="118" viewBox="0 0 118 118" role="img" aria-label={centerLabel ?? 'distribution'}>
        <circle cx="59" cy="59" r={radius} fill="none" stroke="#eef0f4" strokeWidth={stroke} />
        {visible.map((slice, index) => {
          const length = (slice.value / Math.max(1, sum)) * circumference;
          const element = (
            <circle
              key={slice.label}
              cx="59"
              cy="59"
              r={radius}
              fill="none"
              stroke={slice.color ?? DONUT_COLORS[index % DONUT_COLORS.length]}
              strokeWidth={stroke}
              strokeDasharray={`${length} ${circumference - length}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 59 59)"
            />
          );
          offset += length;
          return element;
        })}
        <text x="59" y="56" textAnchor="middle" fontSize="19" fontWeight="650" fill="#12161d">
          {sum}
        </text>
        <text x="59" y="72" textAnchor="middle" fontSize="9" fill="#78808f" letterSpacing="0.06em">
          {(centerLabel ?? 'TOTAL').toUpperCase()}
        </text>
      </svg>
      <div className="donut-legend">
        {slices.map((slice, index) => (
          <div className="donut-legend-row" key={slice.label}>
            <span className="dot" style={{ background: slice.color ?? DONUT_COLORS[index % DONUT_COLORS.length] }} />
            <span className="grow">{slice.label}</span>
            <span className="mono">{slice.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------- modal / toast ---------------------------------- */

export function Modal({
  title,
  children,
  onClose,
  footer,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <h3>{title}</h3>
        <div style={{ marginTop: 10 }}>{children}</div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          {footer}
        </div>
      </div>
    </div>
  );
}

export function useToast(): { toast: (message: string) => void; node: ReactNode } {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!message) return undefined;
    const timer = setTimeout(() => setMessage(null), 3800);
    return () => clearTimeout(timer);
  }, [message]);
  return {
    toast: setMessage,
    node: message ? <div className="toast">{message}</div> : null,
  };
}
