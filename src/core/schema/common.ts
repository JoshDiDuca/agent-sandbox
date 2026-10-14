// Building blocks shared by the settings schemas.
import { z } from 'zod';
import { isValidGuestPath } from '../../shared/paths/index.js';

// Rules (and RESERVED_GUEST) live in shared/guest-paths.ts: the host re-checks them before writing the .wsb.
export const GuestPathSchema = z
  .string()
  .refine(
    isValidGuestPath,
    'reserved or invalid guest path (a folder under C:\\ other than Windows, Program Files, Users, AgentData, Mirror, ..., or on drive D: to Z:)',
  );
export const NameSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, 'letters, numbers, - and _ only');
export const StringsSchema = z.array(z.string());
export function toggle(description: string): z.ZodObject<{ enabled: z.ZodBoolean }, z.core.$strict> {
  return z.strictObject({ enabled: z.boolean().describe(description) });
}
export const SchemaRefSchema = z.string().describe('Path or URL of the JSON Schema for editor autocomplete and docs.');

export const GitAccessSchema = z
  .enum(['full', 'readonly', 'none'])
  .describe(
    'full: normal git. readonly: status/log/diff/show/blame only (no commit, push, checkout, ...). none: no git at all; .git is hidden from the agent.',
  );

/**
 * true, false, or "auto": only when the project uses it (found from files like go.mod in the workspace or one level
 * down).
 */
export const EnabledSchema = z.union([z.boolean(), z.literal('auto')]);
export function enabled(what: string, markers: string): typeof EnabledSchema {
  return EnabledSchema.describe(what + ' true, false, or "auto" = only when the project has ' + markers + '.');
}
export function Packages(what: string, example: string): typeof StringsSchema {
  return StringsSchema.describe(what + ', installed once and kept (e.g. ' + example + ').');
}
