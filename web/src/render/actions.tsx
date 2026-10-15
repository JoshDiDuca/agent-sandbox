// What a page's action does in the browser: an operation runs over RPC (its fields asked first), a terminal link opens
// the session's terminal page, "start an agent" opens the new-session dialog, a view link goes there. Command links
// belong to areas that are not features yet: the web does not offer them.
import { Button, type ButtonProps } from '@mantine/core';
import { useCallback } from 'react';
import type { Action } from '../../../src/app/kernel/index';
import { openNewSession } from '../pages/NewSessionModal';
import { navigate, viewPath } from '../router';
import { useRunAction } from '../rpc/hooks';
import { askFields } from './ActionForm';

/** Can the web do this action? */
export function offered(action: Action | undefined): action is Action {
  return action !== undefined && !(action.kind === 'link' && action.target.kind === 'command');
}

/** Does an action. */
export function useAct(): (action: Action) => Promise<void> {
  const run = useRunAction();
  return useCallback(
    async (action) => {
      if (action.kind === 'operation') {
        const values = action.fields?.length ? await askFields(action) : {};
        if (values) await run(action, values);
        return;
      }
      const target = action.target;
      if (target.kind === 'terminal') navigate('/s/' + target.session);
      else if (target.kind === 'start-agent') openNewSession(target.agent);
      else if (target.kind === 'view') navigate(viewPath(target.view));
    },
    [run],
  );
}

export function ActionButton({ action, ...props }: { readonly action: Action } & ButtonProps) {
  const act = useAct();
  if (!offered(action)) return null;
  const danger = action.kind === 'operation' && action.danger;
  return (
    <Button
      size="xs"
      variant={danger ? 'light' : 'default'}
      color={danger ? 'red' : undefined}
      title={action.description}
      onClick={() => void act(action)}
      {...props}
    >
      {action.label}
    </Button>
  );
}
