// Signs in from the #k= fragment (then removes it from the address bar), and shows the page the address names.
import { useEffect, useState } from 'react';
import { api } from './api';
import { SessionsPage } from './pages/SessionsPage';
import { TerminalPage } from './pages/TerminalPage';
import { useRoute } from './router';
import { Empty, Spinner } from './ui';

type Auth = 'checking' | 'in' | 'out';

/** The token from #k=<token>, or null. */
export function tokenFromFragment(hash: string): string | null {
  const match = /^#k=([0-9a-f]{64})$/.exec(hash);
  return match ? match[1] : null;
}

async function signIn(): Promise<Auth> {
  const token = tokenFromFragment(location.hash);
  if (token) {
    // The fragment never goes to the server, and must not stay in the address bar or the history.
    history.replaceState(null, '', location.pathname + location.search);
    try {
      await api.login(token);
    } catch {
      return 'out';
    }
  }
  try {
    await api.info();
    return 'in';
  } catch {
    return 'out';
  }
}

export function App() {
  const [auth, setAuth] = useState<Auth>('checking');
  const route = useRoute();
  useEffect(() => {
    void signIn().then(setAuth);
  }, []);

  if (auth === 'checking')
    return (
      <div className="p-4">
        <Spinner />
      </div>
    );
  if (auth === 'out')
    return (
      <Empty title="Not signed in">
        Open this page with <code>sandbox web open</code> on this PC. It signs you in.
      </Empty>
    );
  return route.page === 'terminal' ? <TerminalPage id={route.id} /> : <SessionsPage />;
}
