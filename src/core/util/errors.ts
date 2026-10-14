/** An expected problem the user can act on: what went wrong, and (optionally) how to fix it. */
export class UserError extends Error {
  constructor(
    message: string,
    readonly fix?: string,
  ) {
    super(message);
    this.name = 'UserError';
  }
}

/** Throws a UserError. Typed explicitly so TypeScript narrows after calls (arrow functions need it to act as never). */
export const fail: (message: string, fix?: string) => never = (message, fix) => {
  throw new UserError(message, fix);
};

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
