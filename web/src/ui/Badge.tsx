import type { ReactNode } from 'react';
import type { Variant } from './Button';

export function Badge({
  variant = 'secondary',
  children,
}: {
  readonly variant?: Variant;
  readonly children: ReactNode;
}) {
  return <span className={'badge text-bg-' + variant}>{children}</span>;
}
