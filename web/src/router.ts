// The app's pages: a view (/v/<view>, / is the first one) or a session's terminal (/s/<id>). A few lines of
// history-API routing are enough.
import { useEffect, useState } from 'react';

export type Route =
  | { readonly page: 'view'; readonly view: string; readonly params: Readonly<Record<string, string>> }
  | { readonly page: 'terminal'; readonly id: string };

/** The view the app opens on. */
export const HOME_VIEW = 'sessions';

export function parseRoute(path: string, search = ''): Route {
  const terminal = /^\/s\/([A-Za-z0-9_-]{1,64})\/?$/.exec(path);
  if (terminal) return { page: 'terminal', id: terminal[1] };
  const view = /^\/v\/([a-z][a-z0-9-]{0,40})\/?$/.exec(path);
  const params = Object.fromEntries(new URLSearchParams(search));
  return { page: 'view', view: view ? view[1] : HOME_VIEW, params };
}

export function viewPath(view: string, params: Readonly<Record<string, string>> = {}): string {
  const query = new URLSearchParams(params).toString();
  return '/v/' + view + (query ? '?' + query : '');
}

export function navigate(path: string): void {
  history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(): Route {
  const [where, setWhere] = useState({ path: location.pathname, search: location.search });
  useEffect(() => {
    const update = (): void => setWhere({ path: location.pathname, search: location.search });
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return parseRoute(where.path, where.search);
}
