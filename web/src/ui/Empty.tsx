import type { ReactNode } from 'react';

export function Empty({ title, children }: { readonly title: string; readonly children?: ReactNode }) {
  return (
    <div className="text-center text-secondary py-5 px-3">
      <h2 className="h5 text-body">{title}</h2>
      <div>{children}</div>
    </div>
  );
}
