// Readable validation messages and the JSON Schema documents generated from the settings schemas.
import { z } from 'zod';
import { ConfigSchema, LocalOverridesSchema } from './config.js';

/** One readable line per problem: "sandbox.memoryMb: Too small: expected number to be >=2048". */
export const describeIssues = (error: z.ZodError): string[] =>
  error.issues.map((issue) => {
    const at = issue.path.join('.');
    if (issue.code === 'unrecognized_keys')
      return issue.keys.map((k) => (at ? at + '.' : '') + k + ' is not allowed here').join('; ');
    return (at || 'value') + ': ' + issue.message;
  });

/** JSON Schema documents for editors. The user config only lists what it changes, so nothing in it is required. */
export const jsonSchemas = (): Record<string, object> => {
  const dropRequired = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(dropRequired);
    if (typeof node !== 'object' || node === null) return node;
    return Object.fromEntries(
      Object.entries(node)
        .filter(([k]) => k !== 'required')
        .map(([k, v]) => [k, dropRequired(v)]),
    );
  };
  const toSchema = (schema: z.ZodType, title: string): object => ({
    title,
    ...(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as object),
  });
  return {
    'config.schema.json': dropRequired(
      toSchema(ConfigSchema, 'windows-development-sandbox user config (~/.agent-sandbox/config.json)'),
    ) as object,
    'sandbox-config.schema.json': toSchema(
      LocalOverridesSchema,
      'windows-development-sandbox project config (.sandbox-config.json)',
    ),
  };
};
