// A session's terminal inside the shell: a toolbar (back, the connection's state, detach) over xterm.js.
import { Badge, Button, Group, Text, type MantineColor } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import { useCallback, useRef, useState } from 'react';
import { navigate, viewPath } from '../router';
import { TerminalView } from '../terminal/TerminalView';
import type { ConnectionState } from '../terminal/connection';

const STATE_TEXT: Record<ConnectionState, { text: string; color: MantineColor }> = {
  connecting: { text: 'Connecting', color: 'gray' },
  connected: { text: 'Connected', color: 'green' },
  reconnecting: { text: 'Reconnecting', color: 'orange' },
  ended: { text: 'Ended', color: 'gray' },
  failed: { text: 'Cannot connect', color: 'red' },
};

export function TerminalPage({ id }: { readonly id: string }) {
  const [state, setState] = useState<ConnectionState>('connecting');
  const [detail, setDetail] = useState<string | undefined>();
  const detach = useRef<() => void>(() => undefined);
  const onState = useCallback((next: ConnectionState, text?: string) => {
    setState(next);
    setDetail(text);
  }, []);
  const onReady = useCallback((close: () => void) => {
    detach.current = close;
  }, []);
  const shown = STATE_TEXT[state];
  const leave = (): void => {
    detach.current();
    navigate(viewPath('sessions'));
  };
  return (
    <div className="terminal-page">
      <Group gap="xs" px="sm" py={6} wrap="nowrap" className="terminal-toolbar">
        <Button size="compact-sm" variant="default" leftSection={<IconArrowLeft size={14} />} onClick={leave}>
          Back
        </Button>
        <Text fw={600} size="sm" truncate>
          Session {id}
        </Text>
        <Badge color={shown.color} variant="light">
          {shown.text}
        </Badge>
        {detail && (
          <Text size="xs" c="dimmed" truncate>
            {detail}
          </Text>
        )}
        <Button
          size="compact-sm"
          variant="default"
          ml="auto"
          onClick={leave}
          title="Close this view; the session keeps running"
        >
          Detach
        </Button>
      </Group>
      <TerminalView sessionId={id} onState={onState} onReady={onReady} />
    </div>
  );
}
