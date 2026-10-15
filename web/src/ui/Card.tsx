import type { ReactNode } from 'react';

interface CardProps {
  readonly title?: ReactNode;
  readonly badge?: ReactNode;
  readonly footer?: ReactNode;
  readonly children?: ReactNode;
}

export function Card({ title, badge, footer, children }: CardProps) {
  return (
    <div className="card h-100 shadow-sm">
      {title !== undefined && (
        <div className="card-header d-flex justify-content-between align-items-center gap-2">
          <strong className="text-truncate">{title}</strong>
          {badge}
        </div>
      )}
      <div className="card-body">{children}</div>
      {footer !== undefined && <div className="card-footer d-flex gap-2 align-items-center">{footer}</div>}
    </div>
  );
}
