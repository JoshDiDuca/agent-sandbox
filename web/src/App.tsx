// Signs in from the #k= fragment (then removes it from the address bar), and shows the page the address names inside
// the shell: a view, or a session's terminal.
import { Center, Loader, Stack, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { api } from './api';
import { TerminalPage } from './pages/TerminalPage';
import { ViewPage } from './pages/ViewPage';
import { useRoute } from './router';
import { Shell } from './shell/Shell';

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
      <Center h="100dvh">
        <Loader />
      </Center>
    );
  if (auth === 'out')
    return (
      <Center h="100dvh" p="md">
        <Stack gap="xs" align="center">
          <Title order={3}>Not signed in</Title>
          <Text>Open this page with sandbox web open on this PC. It signs you in.</Text>
        </Stack>
      </Center>
    );
  if (route.page === 'terminal')
    return (
      <Shell active="sessions" bare>
        <TerminalPage id={route.id} />
      </Shell>
    );
  return (
    <Shell active={route.view}>
      <ViewPage view={route.view} params={route.params} />
    </Shell>
  );
}
