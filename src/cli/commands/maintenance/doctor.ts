import { table } from '../../output/index.js';
import { HealthService } from '../../services/index.js';
import { type Context } from '../context.js';

export function doctor(ctx: Context): number {
  table(new HealthService(ctx).doctor());
  return 0;
}
