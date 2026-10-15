// Two pages (the session list and a terminal), so a few lines of history-API routing are enough.
import { useEffect, useState } from 'react';

export type Route = { readonly page: 'sessions' } | { readonly page: 'terminal'; readonly id: string };

export function parseRoute(path: string): Route {
  const match = /^\/s\/([A-Za-z0-9_-]{1,64})\/?$/.exec(path);
  return match ? { page: 'terminal', id: match[1] } : { page: 'sessions' };
}

export function navigate(path: string): void {
  history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(): Route {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const update = (): void => setPath(location.pathname);
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return parseRoute(path);
}
