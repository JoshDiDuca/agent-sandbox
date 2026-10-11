// Changing a config file's text: one setting at a time, through jsonc-parser so comments and formatting stay, and never
// into something invalid. Pure; the caller writes the file.
import { applyEdits, modify, parse } from 'jsonc-parser';
import _ from 'lodash';
import { DEFAULTS, mergeConfig } from '../../core/config.js';
import { Config, describeIssues, LocalOverrides } from '../../core/schema.js';

/** The user's own config, or a project's .sandbox-config.json (a smaller schema; nothing is merged with defaults). */
export type SettingsTarget = 'user' | 'project';

/** What the value is in the file (undefined when it is not set there). */
export const fileValue = (text: string, key: string[]): unknown => _.get(parse(text) ?? {}, key);

/**
 * Applies one change (undefined = remove the line, back to the default) to the config text and returns the new text, or
 * the problems that make the result invalid.
 */
export const editConfigText = (text: string, key: string[], value: unknown, target: SettingsTarget = 'user'): { text: string } | { problems: string[] } => {
  const edits = modify(text || '{}', key, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } });
  const next = applyEdits(text || '{}', edits);
  const parsed = target === 'project' ? LocalOverrides.safeParse(parse(next) ?? {}) : Config.safeParse(mergeConfig(DEFAULTS, parse(next) ?? {}));
  return parsed.success ? { text: next.endsWith('\n') ? next : next + '\n' } : { problems: describeIssues(parsed.error) };
};
