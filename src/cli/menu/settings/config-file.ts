// One config file being edited: your own settings, or a project's .sandbox-config.json. One setting is changed at a time
// through jsonc-parser, so comments and formatting stay, and nothing is written unless the whole file is still valid.
import fs from 'node:fs';
import path from 'node:path';
import { applyEdits, modify, parse } from 'jsonc-parser';
import _ from 'lodash';
import { DEFAULTS, loadConfig, mergeConfig, userConfigPath } from '../../../core/config.js';
import { LOCAL_CONFIG_NAME } from '../../../core/local-config.js';
import { Config as ConfigSchema, describeIssues, LocalOverrides } from '../../../core/schema.js';
import type { Config } from '../../../core/types.js';
import { SchemaNode } from './schema-node.js';

/** The user's own config, or a project's .sandbox-config.json (a smaller schema; nothing is merged with defaults). */
export type SettingsTarget = 'user' | 'project';

/** What the value is in this JSON text (undefined when it is not set there). */
export const fileValue = (text: string, key: string[]): unknown => _.get(parse(text) ?? {}, key);

/**
 * Applies one change (undefined = remove the line, back to the default) to config text and returns the new text, or
 * the problems that make the result invalid. Pure; ConfigFile writes it.
 */
export const editConfigText = (text: string, key: string[], value: unknown, target: SettingsTarget = 'user'): { text: string } | { problems: string[] } => {
  // Removing a setting the file does not have changes nothing (jsonc-parser throws on it).
  const edits = value === undefined && fileValue(text || '{}', key) === undefined ? [] : modify(text || '{}', key, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } });
  const next = applyEdits(text || '{}', edits);
  const parsed = target === 'project' ? LocalOverrides.safeParse(parse(next) ?? {}) : ConfigSchema.safeParse(mergeConfig(DEFAULTS, parse(next) ?? {}));
  return parsed.success ? { text: next.endsWith('\n') ? next : next + '\n' } : { problems: describeIssues(parsed.error) };
};

export class ConfigFile {
  readonly schema: SchemaNode;

  constructor(readonly target: SettingsTarget, readonly file: string) {
    this.schema = new SchemaNode(target === 'project' ? LocalOverrides : ConfigSchema);
  }

  static user(configPath: string | null): ConfigFile { return new ConfigFile('user', configPath ?? userConfigPath()); }
  static project(dir: string): ConfigFile { return new ConfigFile('project', path.join(dir, LOCAL_CONFIG_NAME)); }

  get isProject(): boolean { return this.target === 'project'; }
  get exists(): boolean { return fs.existsSync(this.file); }
  text(): string { return this.exists ? fs.readFileSync(this.file, 'utf8') : ''; }

  /** The value written in this file (undefined = not set here). */
  valueInFile(key: string[]): unknown { return fileValue(this.text(), key); }

  /** Your own settings with the built-in defaults filled in (what a sandbox uses without a project file). */
  userConfig(): Config {
    const file = this.isProject ? userConfigPath() : this.file;
    try { return loadConfig(fs.existsSync(file) ? file : undefined).config; } catch { return loadConfig(undefined).config; }
  }

  /** What is in effect: for your file the merged config, for a project file only what the file sets. */
  effective(key: string[], config: Config = this.userConfig()): unknown {
    return this.isProject ? this.valueInFile(key) : _.get(config, key);
  }

  defaultOf(key: string[]): unknown { return _.get(DEFAULTS, key); }

  /**
   * Saves one setting. In your own file a value equal to the default is removed instead (no line needed). Returns
   * 'unchanged', 'saved', or the problems that stopped it.
   */
  set(key: string[], value: unknown): 'unchanged' | 'saved' | { problems: string[] } {
    const text = this.text();
    const next = !this.isProject && value !== undefined && _.isEqual(value, this.defaultOf(key)) ? undefined : value;
    if (_.isEqual(next, fileValue(text, key)) && (this.isProject || _.isEqual(value, _.get(this.userConfig(), key)))) return 'unchanged';
    const result = editConfigText(text, key, next, this.target);
    if ('problems' in result) return result;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, result.text, 'utf8');
    return 'saved';
  }
}
