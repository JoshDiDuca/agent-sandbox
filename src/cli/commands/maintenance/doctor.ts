import { runDoctor } from '../repair/index.js';
import { type Context } from '../context.js';

export function doctor(ctx: Context): Promise<number> {
  return runDoctor(ctx);
}
