import { useState, type FormEvent } from 'react';
import type { WebInfo } from '../../../src/shared/web/index';
import { api } from '../api';
import { Button, Spinner, useToast } from '../ui';

interface NewSessionDialogProps {
  readonly info: WebInfo;
  readonly onClose: () => void;
  readonly onCreated: (id: string) => void;
}

export function NewSessionDialog({ info, onClose, onCreated }: NewSessionDialogProps) {
  const [harness, setHarness] = useState(info.defaultHarness);
  const [project, setProject] = useState(info.projects[0]?.name ?? '');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setBusy(true);
    api
      .create({ harness, project })
      .then((session) => onCreated(session.id))
      .catch((e: unknown) => {
        setBusy(false);
        toast(e instanceof Error ? e.message : 'Could not start the session.', 'danger');
      });
  };

  return (
    <>
      <div className="modal d-block" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="new-session-title">
        <div className="modal-dialog modal-dialog-centered">
          <form className="modal-content" onSubmit={submit}>
            <div className="modal-header">
              <h2 className="modal-title h5" id="new-session-title">
                New session
              </h2>
              <button type="button" className="btn-close" aria-label="Close" onClick={onClose} disabled={busy} />
            </div>
            <div className="modal-body">
              <label className="form-label" htmlFor="new-agent">
                Agent
              </label>
              <select
                id="new-agent"
                className="form-select mb-3"
                value={harness}
                onChange={(e) => setHarness(e.target.value)}
                disabled={busy}
              >
                {info.harnesses.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <label className="form-label" htmlFor="new-project">
                Project
              </label>
              <select
                id="new-project"
                className="form-select"
                value={project}
                onChange={(e) => setProject(e.target.value)}
                disabled={busy}
              >
                {info.projects.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name} ({p.guest})
                  </option>
                ))}
              </select>
              {busy && (
                <div className="mt-3">
                  <Spinner label="Starting the agent (the first time sets things up and can take a while)" />
                </div>
              )}
            </div>
            <div className="modal-footer">
              <Button variant="secondary" outline onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <button type="submit" className="btn btn-primary" disabled={busy || !project}>
                Start
              </button>
            </div>
          </form>
        </div>
      </div>
      <div className="modal-backdrop show" />
    </>
  );
}
