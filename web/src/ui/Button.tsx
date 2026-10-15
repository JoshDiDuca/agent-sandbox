import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type Variant = 'primary' | 'secondary' | 'success' | 'danger' | 'warning' | 'info';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: Variant;
  readonly outline?: boolean;
  readonly small?: boolean;
  readonly children: ReactNode;
}

export function Button({
  variant = 'primary',
  outline = false,
  small = false,
  className,
  children,
  ...rest
}: ButtonProps) {
  const style = 'btn btn-' + (outline ? 'outline-' : '') + variant + (small ? ' btn-sm' : '');
  return (
    <button type="button" className={style + (className ? ' ' + className : '')} {...rest}>
      {children}
    </button>
  );
}
