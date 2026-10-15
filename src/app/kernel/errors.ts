// How a failure crosses a surface: a UserError (fail(message, fix)) stays a message and a fix everywhere, a declined
// question is "cancelled" (nothing changed), a value that does not fit a schema is "invalid", and anything else is a
// bug whose details stay on this PC.
import { z } from 'zod';
import { UserError } from '../../core/util/errors.js';

export const ErrorKindSchema = z.enum(['user', 'cancelled', 'invalid', 'bug']);
export type ErrorKind = z.output<typeof ErrorKindSchema>;

/** A failure as every surface shows it (and as the web receives it). */
export const WireErrorSchema = z.strictObject({
  kind: ErrorKindSchema,
  message: z.string().max(2000),
  fix: z.string().max(2000).optional(),
});
export type WireError = z.output<typeof WireErrorSchema>;

/** The user said no to a question the operation needed: nothing changed. */
export class Cancelled extends Error {
  constructor(message = 'Nothing changed.') {
    super(message);
    this.name = 'Cancelled';
  }
}

/** Ends an operation because a question was declined. */
export function cancelled(message?: string): never {
  throw new Cancelled(message);
}

/** What the user is told about a bug (its stack never leaves this PC). */
export const BUG_MESSAGE = 'Something went wrong.';

/** Any thrown value as message + fix. */
export function toWireError(e: unknown): WireError {
  if (e instanceof Cancelled) return { kind: 'cancelled', message: e.message };
  if (e instanceof UserError) return { kind: 'user', message: e.message, ...(e.fix ? { fix: e.fix } : {}) };
  if (e instanceof z.ZodError) return { kind: 'invalid', message: issuesText(e) };
  return { kind: 'bug', message: BUG_MESSAGE };
}

/** The error to throw on the receiving side (the web client, a test). */
export function fromWireError(w: WireError): Error {
  if (w.kind === 'cancelled') return new Cancelled(w.message);
  return new UserError(w.message, w.fix);
}

/** "key: problem; other: problem" for a value that did not fit its schema. */
export function issuesText(e: z.ZodError): string {
  return e.issues.map((i) => (i.path.length ? i.path.join('.') + ': ' : '') + i.message).join('; ');
}
