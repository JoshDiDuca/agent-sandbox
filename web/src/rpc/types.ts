// The RPC client's types, inferred from the definitions (features/defs.ts): an id names its input and output, so a
// typo or a wrong field is a compile error in the browser code too.
import type { z } from 'zod';
import type { OperationById, OperationId, QueryById, QueryId } from '../../../src/app/features/defs';
import type { CallHandlers, RpcClient } from './client';

export type DefinitionId = OperationId | QueryId;
type DefinitionById<Id extends DefinitionId> = Id extends OperationId
  ? OperationById<Id>
  : Id extends QueryId
    ? QueryById<Id>
    : never;

export type InputOf<Id extends DefinitionId> = z.input<DefinitionById<Id>['input']>;
export type OutputOf<Id extends DefinitionId> = z.output<DefinitionById<Id>['output']>;

/** Runs a definition by id with its typed input; resolves with its typed output. */
export async function run<Id extends DefinitionId>(
  client: RpcClient,
  id: Id,
  input: InputOf<Id>,
  handlers: CallHandlers,
): Promise<OutputOf<Id>> {
  return (await client.call(id, input, handlers)) as OutputOf<Id>;
}
