import type { ReactNode } from 'react';

export function PageHead({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        {subtitle != null && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {actions != null && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Panel({
  children,
  label,
  className,
}: {
  children: ReactNode;
  label?: string;
  className?: string;
}) {
  return (
    <section className={['panel', className].filter(Boolean).join(' ')} aria-label={label}>
      {children}
    </section>
  );
}

export function RailCard({
  title,
  meta,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rail-card">
      <div className="rail-card__head">
        <h2 className="rail-card__title">{title}</h2>
        {meta}
      </div>
      <div className="rail-card__body">{children}</div>
    </section>
  );
}

export function InlineCode({ children }: { children: ReactNode }) {
  return <span className="code-inline">{children}</span>;
}

export function Notice({
  tone,
  title,
  children,
}: {
  tone: 'info' | 'success' | 'warning' | 'error';
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className={`notice notice--${tone}`} role="status">
      <strong>{title}</strong>
      {children != null && <span>{children}</span>}
    </div>
  );
}