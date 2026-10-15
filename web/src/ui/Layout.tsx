import type { ReactNode } from 'react';
import { navigate } from '../router';

interface LayoutProps {
  readonly active: 'sessions' | 'terminal';
  /** The terminal fills the whole area and has its own toolbar. */
  readonly bare?: boolean;
  readonly children: ReactNode;
}

const ITEMS = [{ page: 'sessions', label: 'Sessions', path: '/' }] as const;

function Nav({ active, className }: { readonly active: string; readonly className: string }) {
  return (
    <nav className={className} aria-label="Main">
      {ITEMS.map((item) => (
        <a
          key={item.page}
          href={item.path}
          className={
            'nav-link' + (active === item.page || (active === 'terminal' && item.page === 'sessions') ? ' active' : '')
          }
          onClick={(e) => {
            e.preventDefault();
            navigate(item.path);
          }}
        >
          {item.label}
        </a>
      ))}
    </nav>
  );
}

export function Layout({ active, bare = false, children }: LayoutProps) {
  return (
    <div className="app-shell">
      <aside className="app-nav d-none d-md-flex flex-column border-end p-3">
        <div className="fw-bold fs-5 mb-3">Sandbox</div>
        <Nav active={active} className="nav nav-pills flex-column" />
      </aside>
      <div className="app-main">
        <header className="d-md-none d-flex align-items-center gap-3 border-bottom px-3 py-2">
          <span className="fw-bold">Sandbox</span>
          <Nav active={active} className="nav nav-pills" />
        </header>
        <main className={bare ? 'app-bare' : 'container-fluid py-4 px-3 px-md-4'}>{children}</main>
      </div>
    </div>
  );
}
