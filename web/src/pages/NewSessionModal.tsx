// "Start <agent>": an agent in a project of the running sandbox (POST /api/sessions), then its terminal page. Until the
// agents area is a feature of the shared core, this is the web's way to start one (docs/design/web-ui-tasks.md #1).
import { Alert, Button, Group, Loader, Select, Stack, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useEffect, useState, type FormEvent } from 'react';
import type { WebInfo } from '../../../src/shared/web/index';
import { api } from '../api';
import { navigate } from '../router';

function NewSessionForm({ agent, close }: { readonly agent?: string; readonly close: () => void }) {
  const [info, setInfo] = useState<WebInfo | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [harness, setHarness] = useState<string | null>(agent ?? null);
  const [project, setProject] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.info().then(
      (loaded) => {
        setInfo(loaded);
        setHarness((h) => h ?? loaded.defaultHarness);
        setProject(loaded.projects[0]?.name ?? null);
      },
      (e: unknown) => setFailure(e instanceof Error ? e.message : 'The server did not answer.'),
    );
  }, []);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!harness || !project) return;
    setBusy(true);
    api.create({ harness, project }).then(
      (session) => {
        close();
        notifications.show({ message: 'Session started.', color: 'green' });
        navigate('/s/' + session.id);
      },
      (e: unknown) => {
        setBusy(false);
        setFailure(e instanceof Error ? e.message : 'Could not start the session.');
      },
    );
  };

  if (!info && !failure) return <Loader size="sm" />;
  const usable = info && info.sandbox === 'running' && info.canUse;
  return (
    <form onSubmit={submit}>
      <Stack gap="md">
        {failure && <Alert color="red">{failure}</Alert>}
        {info && !usable && (
          <Alert color="orange">
            {info.sandbox === 'running'
              ? 'This sandbox is not shared with you.'
              : 'No sandbox is running. Start one on this PC with: sandbox ' + (agent ?? info.defaultHarness)}
          </Alert>
        )}
        {usable && (
          <>
            <Select label="Agent" data={[...info.harnesses]} value={harness} onChange={setHarness} disabled={busy} />
            <Select
              label="Project"
              data={info.projects.map((p) => ({ value: p.name, label: p.name + ' (' + p.guest + ')' }))}
              value={project}
              onChange={setProject}
              disabled={busy}
            />
          </>
        )}
        {busy && <Text size="sm">Starting the agent (the first time sets things up and can take a while)…</Text>}
        <Group justify="flex-end">
          <Button variant="default" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!usable || !project || !harness}>
            Start
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

export function openNewSession(agent?: string): void {
  const id = modals.open({
    title: 'New session',
    centered: true,
    children: <NewSessionForm agent={agent} close={() => modals.close(id)} />,
  });
}
