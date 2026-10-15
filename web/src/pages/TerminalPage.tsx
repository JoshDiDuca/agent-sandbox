import { useCallback, useRef, useState } from 'react';
import { navigate } from '../router';
import { TerminalView } from '../terminal/TerminalView';
import type { ConnectionState } from '../terminal/connection';
import { Badge, Button, Layout, type Variant } from '../ui';

const STATE_TEXT: Record<ConnectionState, { text: string; variant: Variant }> = {
  connecting: { text: 'Connecting', variant: 'secondary' },
  connected: { text: 'Connected', variant: 'success' },
  reconnecting: { text: 'Reconnecting', variant: 'warning' },
  ended: { text: 'Ended', variant: 'secondary' },
  failed: { text: 'Cannot connect', variant: 'danger' },
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
    navigate('/');
  };
  return (
    <Layout active="terminal" bare>
      <div className="terminal-page">
        <div className="terminal-toolbar d-flex align-items-center gap-2 border-bottom px-2 py-1">
          <Button small outline variant="secondary" onClick={leave}>
            Back
          </Button>
          <span className="text-truncate fw-semibold">Session {id}</span>
          <Badge variant={shown.variant}>{shown.text}</Badge>
          {detail && <span className="small text-secondary text-truncate">{detail}</span>}
          <span className="ms-auto" />
          <Button small outline variant="secondary" onClick={leave} title="Close this view; the session keeps running">
            Detach
          </Button>
        </div>
        <TerminalView sessionId={id} onState={onState} onReady={onReady} />
      </div>
    </Layout>
  );
}
