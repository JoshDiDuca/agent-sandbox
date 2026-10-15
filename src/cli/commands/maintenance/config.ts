import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import _ from 'lodash';
import { DEFAULTS, userConfigPath, userDir } from '../../../core/config/index.js';
import { redactSecrets } from '../../../core/schema/index.js';
import {
  allowedAnswer,
  allowStorePath,
  applyOverrides,
  describeOverrides,
  isTrusted,
  LOCAL_CONFIG_NAME,
  loosenedRequests,
  normalizeOverrides,
  OUTSIDE_FOLDER,
  outsideKey,
  outsideMappings,
  readLocalConfig,
  trustStorePath,
} from '../../../core/local-config/index.js';
import { guestWorkspaceOf, previewGuest } from '../../../core/run/index.js';
import type { Mapping, Overrides } from '../../../core/types.js';
import { askChoice } from '../../../core/prompt.js';
import { dirExists, fail, safeText, writeJson } from '../../../core/util/index.js';
import { system32 } from '../../../shared/system.js';
import { refuseInSelfTest } from '../../../host/test-guard.js';
import { closest } from '../../validate.js';
import { c, nextStep, table } from '../../output/index.js';
import { ConfigFile, type SchemaNode } from '../../menu/settings/index.js';
import { type Context } from '../context.js';
import { exportCommand, importCommand } from './config-share.js';

/** The settings file exists already: open it, start over, or leave it (no terminal: say how). */
async function existingFile(file: string): Promise<'open' | 'overwrite' | 'cancel'> {
  return askChoice(
    file + ' exists already.',
    [
      { name: 'Open it', value: 'open' as const },
      { name: 'Overwrite it with the defaults (your changes are lost)', value: 'overwrite' as const },
      { name: 'Cancel', value: 'cancel' as const },
    ],
    'Open it with: sandbox config path. To start over, delete it first.',
  );
}

async function initConfig(): Promise<number> {
  const file = userConfigPath();
  if (fs.existsSync(file)) {
    const answer = await existingFile(file);
    if (answer === 'cancel') return 0;
    if (answer === 'open') {
      refuseInSelfTest('open files');
      spawn(system32('notepad.exe'), [file], { detached: true, stdio: 'ignore' }).unref();
      console.log('Opened ' + file + '.');
      return 0;
    }
  }
  fs.mkdirSync(path.join(userDir(), 'hooks', 'pre-agent'), { recursive: true });
  // The schema sits next to the file (a local path), so editors trust it and show docs and autocomplete.
  writeJson(file, { $schema: './config.schema.json', ...DEFAULTS });
  console.log('Created ' + file + '. It lists every setting with its default; delete the ones you do not change.');
  console.log(
    'Your own hook scripts go in ' + path.join(userDir(), 'hooks') + '\\{pre-provision,pre-agent,post-agent}.',
  );
  nextStep("sandbox config schema   (editor help in every project's .sandbox-config.json)");
  return 0;
}

/** The setting a key names, as the schema knows it; an unknown key says what is close. */
function settingNode(key: string): { path: string[]; node: SchemaNode } {
  const root = ConfigFile.user(null).schema;
  const keyPath = key.split('.');
  let node: SchemaNode | undefined = root;
  for (const part of keyPath) node = node?.child(part);
  if (node) return { path: keyPath, node };
  const known = root.leaves().map((l) => l.key.join('.'));
  const hint = closest(key, known);
  return fail(
    'There is no setting "' + key + '".' + (hint ? ' Did you mean ' + hint + '?' : ''),
    'Settings are named like sandbox.memoryMb. See them all with: sandbox config show',
  );
}

/** What was typed for a setting as the value it stands for: true/false/on/off, a number, JSON, or plain text. */
function settingValue(node: SchemaNode, text: string): unknown {
  const word = text.trim().toLowerCase();
  if (node.type === 'string') return text;
  if (node.type === 'boolean' || node.options.some((o) => o.type === 'boolean')) {
    if (['true', 'on', 'yes'].includes(word)) return true;
    if (['false', 'off', 'no'].includes(word)) return false;
  }
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: a bare word such as auto or a path is the text itself.
    return node.type === 'array' ? text.split(',').map((t) => t.trim()) : text;
  }
}

/** What a setting accepts, in words: its fixed values, a number and its range, true or false. */
function allowedText(node: SchemaNode): string {
  const values = node.choiceValues.map((v) => String(v));
  const open = node.openOption ?? (node.type === 'number' ? node : undefined);
  const range = (n: SchemaNode): string => (n.rangeText() ? ' (' + n.rangeText() + ')' : '');
  const more = open ? (open.type === 'number' ? 'a number' + range(open) : 'text') : '';
  if (node.type === 'boolean') return 'Use true or false.';
  const parts = [...values, ...(more ? [more] : [])];
  return parts.length ? 'Allowed: ' + parts.join(', or ') + '.' : 'Check the value.';
}

function setSettingCommand(ctx: Context, key: string | undefined, text: string | undefined): number {
  if (!key || text === undefined) fail('Which setting and value?', 'Usage: sandbox config set <setting> <value>');
  const { path: keyPath, node } = settingNode(key);
  if (node.isSection)
    fail('"' + key + '" is a group of settings.', 'Set one of them, e.g. ' + node.leaves(keyPath)[0]?.key.join('.'));
  const value = settingValue(node, text);
  const problem = node.check(value);
  if (problem !== true) {
    fail('"' + text + '" does not work for ' + key + ': ' + problem, allowedText(node));
  }
  const outcome = ConfigFile.user(ctx.loaded.configPath).set(keyPath, value);
  if (typeof outcome === 'object')
    fail('Could not change ' + key + ': ' + outcome.problems.join('; '), 'Nothing was written.');
  console.log(
    key +
      ' is ' +
      JSON.stringify(_.get(redactSecrets(_.set({}, keyPath, value)), keyPath)) +
      (outcome === 'unchanged' ? ' (it was already)' : '') +
      '.',
  );
  return 0;
}

function getSettingCommand(ctx: Context, key: string | undefined): number {
  if (!key) fail('Which setting?', 'Usage: sandbox config get <setting>   (all of them: sandbox config show)');
  const { path: keyPath } = settingNode(key);
  // Secret values (an agent's API keys) are never printed.
  const value = _.get(redactSecrets(ctx.loaded.config), keyPath) as unknown;
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return 0;
}

/**
 * VS Code setting that maps every .sandbox-config.json (and the user config) to the local schema files, so project
 * files need no "$schema" line and nothing is fetched from the internet (remote schemas need trusting).
 */
function printSchemaSettings(): number {
  const url = (name: string): string => pathToFileURL(path.join(userDir(), name)).href;
  const setting = {
    'json.schemas': [
      { fileMatch: ['**/.sandbox-config.json'], url: url('sandbox-config.schema.json') },
      { fileMatch: ['**/.agent-sandbox/config.json'], url: url('config.schema.json') },
    ],
  };
  console.log('Add this to your VS Code settings.json (Ctrl+Shift+P > "Preferences: Open User Settings (JSON)"):\n');
  console.log(JSON.stringify(setting, null, 2).slice(2, -2));
  console.log('\nThe schema files live in ' + userDir() + ' and are refreshed whenever the sandbox command runs.');
  return 0;
}

/**
 * `sandbox config check`: the folder's .sandbox-config.json validated and described (risky settings flagged, approval
 * state), without launching. Fails with the same message a launch would give when the file is not valid.
 */
function checkLocalConfig(ctx: Context): number {
  const dir = path.resolve(ctx.options.workspace ?? process.cwd());
  const file = readLocalConfig(dir);
  if (!file) {
    console.log('No ' + LOCAL_CONFIG_NAME + ' in ' + dir + '; the sandbox uses your own settings only.');
    return 0;
  }
  const overrides = normalizeOverrides(file.data, dir, file.path);
  const approved = isTrusted(trustStorePath(ctx.storageRoot), file.path, file.hash);
  console.log(
    file.path +
      ': valid. ' +
      (approved ? 'Approved (this exact version).' : 'Not approved yet: the next launch asks you.') +
      '\n',
  );
  for (const line of describeOverrides(overrides, dir)) console.log('  ' + safeText(line));
  previewFolders(ctx, dir, file.path, overrides);
  return 0;
}

/** What a launch from here would do with each folder and each looser setting, without launching. */
function previewFolders(ctx: Context, dir: string, filePath: string, overrides: Overrides): void {
  const config = ctx.loaded.config;
  const store = allowStorePath(ctx.storageRoot);
  const workspaceGuest = guestWorkspaceOf(applyOverrides(config, overrides), dir).guest;
  const outside = outsideMappings(dir, overrides.mappings);
  const policy = config.projects.allowOutsideMappings;
  const statusOf = (m: Mapping): string => {
    if (!dirExists(m.host))
      return m.optional
        ? 'not on this PC: skipped'
        : c.red('the folder does not exist: create it, fix the path, or add "optional": true');
    if (!outside.includes(m))
      return m.guest ? 'inside the project' : 'inside the project (already in the sandbox there)';
    if (policy === true) return 'outside the project, allowed (your settings allow it)';
    if (policy === false) return c.red('outside the project: refused (your settings do not allow it)');
    return allowedAnswer(store, filePath, OUTSIDE_FOLDER, outsideKey(m)) === true
      ? 'outside the project, allowed (you said yes)'
      : c.yellow('outside the project: the next interactive launch asks you');
  };
  const rows = (overrides.mappings ?? []).map((m) => {
    const where = previewGuest(m, dir, workspaceGuest);
    return [(m.readOnly ? 'ro ' : 'rw ') + safeText(m.host), '->  ' + safeText(where.guest), statusOf(m)];
  });
  if (rows.length) {
    console.log('\nFolders (where they appear in the sandbox):');
    table(rows);
  }
  for (const m of overrides.mappings ?? []) {
    const note = dirExists(m.host) ? previewGuest(m, dir, workspaceGuest).note : null;
    if (note) console.log('  ' + safeText(note));
  }
  const looser = loosenedRequests(config, overrides);
  if (looser.length) console.log('\nLooser than your settings (used only if you allow it for this project):');
  for (const a of looser) {
    const answer = allowedAnswer(store, filePath, a.key, a.wanted);
    console.log(
      '  ' +
        a.key +
        ' = ' +
        JSON.stringify(a.wanted) +
        ': ' +
        (answer === true
          ? 'allowed (you said yes)'
          : answer === false
            ? 'not used (you said no)'
            : 'the next interactive launch asks you'),
    );
  }
}

export function config(ctx: Context): number | Promise<number> {
  const [action = 'summary', key, value] = ctx.options.positionals;
  switch (action) {
    case 'summary':
      table([
        [
          'Settings file',
          ctx.loaded.configPath ?? userConfigPath() + '  (does not exist yet; sandbox config init creates it)',
        ],
        ['Default agent', ctx.loaded.config.defaultHarness],
        ['Storage', ctx.storageRoot],
        [
          'Memory',
          String(ctx.loaded.config.sandbox.memoryMb) + (ctx.loaded.config.sandbox.memoryMb === 'auto' ? '' : ' MB'),
        ],
      ]);
      console.log('\nChange settings in the menu (sandbox > Settings). All of them as JSON: sandbox config show');
      return 0;
    case 'path':
      console.log(ctx.loaded.configPath ?? userConfigPath() + '  (does not exist yet)');
      return 0;
    case 'init':
      return initConfig();
    case 'show':
      console.log(JSON.stringify(redactSecrets(ctx.loaded.config), null, 2));
      return 0;
    case 'get':
      return getSettingCommand(ctx, key);
    case 'set':
      return setSettingCommand(ctx, key, value);
    case 'export':
      return exportCommand(ctx, key);
    case 'import':
      return importCommand(ctx, key);
    case 'schema':
      return printSchemaSettings();
    case 'check':
      return checkLocalConfig(ctx);
    default:
      fail(
        'Unknown config action "' + action + '".',
        'Use one of: sandbox config show | get | set | path | init | schema | check | export | import',
      );
  }
}
