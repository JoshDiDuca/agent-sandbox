// Secrets in settings: which values are marked `secret` in the schemas, and printing a config without them.
import { z } from 'zod';
import { ConfigSchema } from './config.js';

/** What is printed instead of a secret. */
export const REDACTED = '***';

/** A path through a config; "*" stands for any key of a map or any item of a list. */
type SecretPath = readonly string[];

let cached: SecretPath[] | null = null;

const walk = (node: unknown, at: SecretPath, out: SecretPath[]): void => {
  if (typeof node !== 'object' || node === null) return;
  const n = node as Record<string, unknown>;
  if (n.secret === true) out.push(at);
  for (const [k, v] of Object.entries((n.properties as object | undefined) ?? {})) walk(v, [...at, k], out);
  if (typeof n.additionalProperties === 'object') walk(n.additionalProperties, [...at, '*'], out);
  if (n.items) walk(n.items, [...at, '*'], out);
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const)
    if (Array.isArray(n[key])) for (const v of n[key]) walk(v, at, out);
};

/** Every setting marked secret, found from the schema itself (so a new secret setting needs no list). */
export function secretPaths(): readonly SecretPath[] {
  if (!cached) {
    const out: SecretPath[] = [];
    walk(z.toJSONSchema(ConfigSchema, { io: 'input', unrepresentable: 'any' }), [], out);
    cached = out;
  }
  return cached;
}

const blank = (value: unknown, path: SecretPath): unknown => {
  if (path.length === 0) return typeof value === 'string' && value !== '' ? REDACTED : value;
  if (typeof value !== 'object' || value === null) return value;
  const [head, ...rest] = path;
  if (Array.isArray(value)) return value.map((v) => (head === '*' ? blank(v, rest) : v));
  const o = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, head === '*' || head === k ? blank(v, rest) : v]));
};

/** A copy of `config` with every secret value replaced by ***. */
export function redactSecrets<T>(config: T): T {
  return secretPaths().reduce<unknown>((value, path) => blank(value, path), config) as T;
}

const collect = (value: unknown, path: SecretPath, out: string[]): void => {
  if (path.length === 0) {
    if (typeof value === 'string' && value !== '') out.push(value);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const [head, ...rest] = path;
  const o = value as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) if (head === '*' || head === k) collect(v, rest, out);
};

/** The secret values in `config` (for scrubbing text that was built from it). */
export function secretValues(config: unknown): string[] {
  const out: string[] = [];
  for (const path of secretPaths()) collect(config, path, out);
  return [...new Set(out)];
}

/** `text` with every secret value of `config` replaced by *** (a last safety net for output built from a config). */
export function scrubSecrets(text: string, config: unknown): string {
  return secretValues(config)
    .filter((v) => v.length >= 4)
    .sort((a, b) => b.length - a.length)
    .reduce((t, v) => t.split(v).join(REDACTED).split(JSON.stringify(v).slice(1, -1)).join(REDACTED), text);
}
