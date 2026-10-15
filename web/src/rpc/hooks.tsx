// React's way into the RPC client: the client for the page, a query's data (live queries follow their subscription,
// the rest are TanStack Query fetches), and running an action of a page with progress, questions and the result shown
// as notifications and modals.
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { operationById } from '../../../src/app/features/defs';
import { Cancelled, type OperationAction, type QueryDef } from '../../../src/app/kernel/index';
import { askInModal } from '../render/QuestionModal';
import type { RpcClient } from './client';

const RpcContext = createContext<RpcClient | null>(null);

export function RpcProvider({ client, children }: { readonly client: RpcClient; readonly children: ReactNode }) {
  return <RpcContext.Provider value={client}>{children}</RpcContext.Provider>;
}

export function useRpc(): RpcClient {
  const client = useContext(RpcContext);
  if (!client) throw new Error('useRpc needs an RpcProvider');
  return client;
}

/** A query never asks: a question from one is answered no. */
const noQuestions = { ask: () => Promise.resolve(undefined) };

export interface QueryData {
  readonly data: unknown;
  readonly error: Error | null;
  readonly pending: boolean;
}

/** A query's result: kept fresh by its subscription when it is live, fetched once (and after actions) otherwise. */
export function useQueryData(def: QueryDef, input: unknown): QueryData {
  const client = useRpc();
  const queryClient = useQueryClient();
  const live = def.live !== undefined;
  const inputKey = JSON.stringify(input ?? {});
  const [failure, setFailure] = useState<Error | null>(null);
  const query = useQuery({
    queryKey: [def.id, inputKey],
    queryFn: () => client.call(def.id, input, noQuestions),
    enabled: !live,
  });
  useEffect(() => {
    if (!live) return undefined;
    return client.subscribe(
      def.id,
      JSON.parse(inputKey) as unknown,
      (data) => {
        setFailure(null);
        queryClient.setQueryData([def.id, inputKey], data);
      },
      setFailure,
    );
  }, [client, queryClient, def.id, inputKey, live]);
  const error = failure ?? query.error;
  return { data: query.data, error, pending: query.data === undefined && !error };
}

/** Runs a page's operation action: questions in modals, progress and the result as notifications. */
export function useRunAction(): (action: OperationAction, values?: Readonly<Record<string, unknown>>) => Promise<void> {
  const client = useRpc();
  const queryClient = useQueryClient();
  return useCallback(
    async (action, values = {}) => {
      const def = operationById(action.op);
      const id = 'op-' + Date.now();
      const said: string[] = [];
      let shown = false;
      try {
        const output = await client.call(
          action.op,
          { ...action.input, ...values },
          {
            progress: (text) => {
              const note = { id, title: action.label, message: text, loading: true, autoClose: false } as const;
              if (shown) notifications.update(note);
              else notifications.show(note);
              shown = true;
            },
            log: (text) => said.push(text),
            ask: (question) => askInModal(question, said.splice(0)),
          },
        );
        const text = def?.text?.(output) ?? 'Done.';
        const result = { id, title: action.label, message: text, color: 'green', loading: false, autoClose: 5000 };
        if (shown) notifications.update(result);
        else notifications.show(result);
      } catch (e) {
        if (shown) notifications.hide(id);
        if (e instanceof Cancelled) return;
        const fix = (e as { fix?: string }).fix;
        notifications.show({
          title: e instanceof Error ? e.message : 'It did not work.',
          message: fix ?? said.join(' '),
          color: 'red',
          autoClose: 10000,
        });
      } finally {
        await queryClient.invalidateQueries();
      }
    },
    [client, queryClient],
  );
}
