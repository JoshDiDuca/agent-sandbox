// The settings screen in the menu: every setting, generated from the zod schemas (so nothing needs to be listed by
// hand), shown with its current value and description, edited with a fitting prompt and saved to a config file. Two
// files can be edited: your own (all projects) and this folder's .sandbox-config.json (only what a project may set).
// Edits keep comments and formatting, and nothing is written unless the whole file is still valid.
import fs from 'node:fs';
import path from 'node:path';
import { select, Separator } from '@inquirer/prompts';
import _ from 'lodash';
import { DEFAULTS, loadConfig, userConfigPath } from '../../core/config.js';
import { LOCAL_CONFIG_NAME, NEVER_LOOSER } from '../../core/local-config.js';
import { Config as ConfigSchema, LocalOverrides } from '../../core/schema.js';
import type { Config } from '../../core/types.js';
import { c } from '../colors.js';
import { editConfigText, fileValue, type SettingsTarget } from './edit.js';
import { askValue } from './prompts.js';
import { childrenOf, describeSetting, isSection, unwrap, type Schema } from './schema.js';

export { editConfigText } from './edit.js';

/** Titles of the top-level sections in the menu. A test makes sure every section of the schema has one. */
export const SECTION_TITLES: Record<string, string> = {
  toolchains: 'Languages and tools', databases: 'Databases', sandbox: 'The sandbox machine (memory, window, GPU, network)', attach: 'Attaching (auto attach, auto hide)',
  provisioning: 'Provisioning and git', downloads: 'Downloads (checksums)', secrets: 'Secrets', claudeProfile: 'Your Claude settings and history', storage: 'Storage',
  network: 'Network', hooks: 'Hooks', personalization: 'Desktop look',
};

/** Which file is being edited, and how its values are shown. */
interface Session { target: SettingsTarget; file: string; schema: Schema }

/** A value in one short line: maps as their keys, long lists shortened. */
const show = (value: unknown): string => {
  if (value === undefined) return c.dim('(not set)');
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) { const keys = Object.keys(value); return keys.length ? '{ ' + _.truncate(keys.join(', '), { length: 60 }) + ' }' : '{}'; }
  return _.truncate(JSON.stringify(value), { length: 70 });
};

const readText = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

/** The user's settings with the built-in defaults filled in (what a sandbox would use without a project file). */
const userConfig = (file: string): Config => loadConfig(fs.existsSync(file) ? file : undefined).config;

/** What is in effect now: for your own file the merged config, for a project file only what that file sets. */
const currentValue = (session: Session, key: string[], text: string, config: Config): unknown =>
  session.target === 'project' ? fileValue(text, key) : _.get(config, key);

/** Edits one setting: shows it, asks, saves (or resets it to the default / removes it from the project file). */
const editSetting = async (session: Session, schema: Schema, key: string[], config: Config): Promise<void> => {
  const { file, target } = session;
  const text = readText(file);
  const inFile = fileValue(text, key);
  const project = target === 'project';
  console.log('\n' + c.cyan(key.join('.')) + (describeSetting(schema) ? '\n' + c.dim(describeSetting(schema)!) : ''));
  if (project && NEVER_LOOSER.includes(key.join('.'))) console.log(c.yellow('A project can only make this stricter than your own setting; a looser value is ignored.'));
  console.log('Now: ' + (project ? show(inFile) + c.dim(inFile === undefined ? '  (not set in this project; yours: ' + show(_.get(config, key)) + ')' : '  (set in ' + file + ')') : show(_.get(config, key)) + (inFile === undefined ? c.dim('  (built-in default)') : c.dim('  (set in ' + file + ')'))));
  const resetLabel = project ? 'Remove from this project file' : 'Reset to the default (' + show(_.get(DEFAULTS, key)) + ')';
  const action = inFile === undefined ? 'change' : await select({ message: 'What now?', choices: [{ name: 'Change it', value: 'change' }, { name: resetLabel, value: 'reset' }, { name: c.dim('< back'), value: 'back' }] });
  if (action === 'back') return;
  const answer = action === 'reset' ? { value: undefined } : await askValue(schema, key, project ? inFile ?? _.get(config, key) : _.get(config, key), config);
  if (!answer) return;
  // In your own file the default needs no line; an unchanged value needs no save.
  const value = !project && _.isEqual(answer.value, _.get(DEFAULTS, key)) ? undefined : answer.value;
  if (value === inFile && (project || _.isEqual(answer.value, _.get(config, key)))) { console.log(c.dim('Unchanged.')); return; }
  const result = editConfigText(text, key, value, target);
  if ('problems' in result) { console.log(c.red('Not saved: ') + result.problems.join('; ')); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, result.text, 'utf8');
  console.log(c.green('Saved') + c.dim(' to ' + file + (project ? '.' : '. New sandboxes use it.')));
  // The approval is tied to the file's exact contents, so any change makes the project file untrusted again.
  if (project) console.log(c.yellow('This project file is not approved any more: the next launch shows what it applies and asks you to approve it.'));
};

/** Browses one level of settings; sections open, leaves are edited. */
const browse = async (session: Session, schema: Schema, key: string[]): Promise<void> => {
  for (;;) {
    const config = userConfig(session.target === 'user' ? session.file : userConfigPath());
    const entries = childrenOf(schema);
    const text = readText(session.file);
    const pickName = await select<string>({
      message: key.length ? key.join('.') : 'Settings ' + c.dim('(saved to ' + session.file + ')'),
      pageSize: 18,
      choices: [
        ...entries.map(([name, s]) => {
          const full = [...key, name];
          const changed = fileValue(text, full) !== undefined;
          const shown = show(currentValue(session, full, text, config));
          const label = isSection(s) ? (key.length ? name : SECTION_TITLES[name] ?? name) + c.dim(' ...') : name.padEnd(18) + ' ' + (changed ? c.yellow(shown) : shown);
          return { name: label, value: name, description: describeSetting(s) };
        }),
        new Separator(),
        { name: c.dim('< back'), value: '@back' },
      ],
    });
    if (pickName === '@back') return;
    const child = unwrap(schema).shape![pickName];
    if (isSection(child)) await browse(session, child, [...key, pickName]);
    else await editSetting(session, child, [...key, pickName], config);
  }
};

/**
 * The settings screen: first which file to edit (your own, or this folder's project file), then its settings. Your file
 * is created when missing; so is the project file once a setting is saved.
 */
export const settingsMenu = async (configPath: string | null, projectDir: string = process.cwd()): Promise<void> => {
  const sessions: Record<string, Session> = {
    user: { target: 'user', file: configPath ?? userConfigPath(), schema: ConfigSchema as unknown as Schema },
    project: { target: 'project', file: path.join(projectDir, LOCAL_CONFIG_NAME), schema: LocalOverrides as unknown as Schema },
  };
  for (;;) {
    const which = await select<string>({
      message: 'Which settings?',
      choices: [
        { name: 'Your settings (all projects) ' + c.dim(sessions.user.file), value: 'user' },
        { name: 'This project ' + c.dim(sessions.project.file + ' (only what a project may set; needs your approval at launch)'), value: 'project' },
        new Separator(),
        { name: c.dim('< back'), value: '@back' },
      ],
    });
    if (which === '@back') return;
    await browse(sessions[which], sessions[which].schema, []);
  }
};
