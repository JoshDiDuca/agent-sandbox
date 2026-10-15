import { useCallback, useEffect, useState } from 'react';
import type { WebInfo, WebSession } from '../../../src/shared/web/index';
import { api } from '../api';
import { navigate } from '../router';
import { ago } from '../time';
import { Badge, Button, Card, Empty, Layout, Spinner, useToast, type Variant } from '../ui';
import { NewSessionDialog } from './NewSessionDialog';

const REFRESH_MS = 4000;
const PHASE: Record<WebSession['phase'], Variant> = {
  starting: 'info',
  running: 'success',
  exited: 'secondary',
  failed: 'danger',
};

interface Loaded {
  readonly info: WebInfo;
  readonly sessions: readonly WebSession[];
}

function viewersText(viewers: number | null): string {
  if (viewers === null) return 'Viewers unknown';
  return viewers + (viewers === 1 ? ' viewer' : ' viewers');
}

function SessionCard({ session }: { readonly session: WebSession }) {
  return (
    <Card
      title={session.harness}
      badge={<Badge variant={PHASE[session.phase]}>{session.phase}</Badge>}
      footer={
        <>
          <Button small disabled={!session.canOpen} onClick={() => navigate('/s/' + session.id)}>
            Open
          </Button>
          <span className="small text-secondary ms-auto">{ago(session.startedAt)}</span>
        </>
      }
    >
      <div className="fw-semibold">{session.project}</div>
      <div className="small text-secondary text-break">{session.cwd}</div>
      <div className="small mt-2">{viewersText(session.viewers)}</div>
      {!session.canOpen && session.phase === 'running' && (
        <div className="small text-warning mt-1">Not reachable from this PC.</div>
      )}
    </Card>
  );
}

export function SessionsPage() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false);
  const toast = useToast();

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [info, sessions] = await Promise.all([api.info(), api.sessions()]);
      setLoaded({ info, sessions });
      setFailure(null);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : 'The server did not answer.');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const info = loaded?.info;
  return (
    <Layout active="sessions">
      <div className="d-flex align-items-center gap-2 mb-3">
        <h1 className="h4 m-0">Sessions</h1>
        <span className="ms-auto" />
        <Button small outline variant="secondary" onClick={() => void refresh()}>
          Refresh
        </Button>
        <Button small disabled={!info?.canUse || info.projects.length === 0} onClick={() => setDialog(true)}>
          New session
        </Button>
      </div>
      {info?.owner && <div className="alert alert-info py-2">{info.owner}</div>}
      {failure && <div className="alert alert-danger py-2">{failure}</div>}
      {!loaded && !failure && <Spinner />}
      {info && info.sandbox === 'stopped' && (
        <Empty title="No sandbox is running">Start one on this PC with: sandbox claude</Empty>
      )}
      {info && info.sandbox === 'running' && !info.canUse && (
        <Empty title="This sandbox is not shared with you">Ask whoever started it to turn on sharing.</Empty>
      )}
      {info && info.canUse && loaded && loaded.sessions.length === 0 && (
        <Empty title="No sessions yet">Start one with New session.</Empty>
      )}
      <div className="row row-cols-1 row-cols-md-2 row-cols-xl-3 g-3">
        {loaded?.sessions.map((s) => (
          <div className="col" key={s.id}>
            <SessionCard session={s} />
          </div>
        ))}
      </div>
      {dialog && info && (
        <NewSessionDialog
          info={info}
          onClose={() => setDialog(false)}
          onCreated={(id) => {
            setDialog(false);
            toast('Session started.', 'success');
            navigate('/s/' + id);
          }}
        />
      )}
    </Layout>
  );
}
