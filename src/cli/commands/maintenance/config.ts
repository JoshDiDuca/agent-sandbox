import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULTS, userConfigPath, userDir } from '../../../core/config/index.js';
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
import { dirExists, fail, safeText, writeJson } from '../../../core/util/index.js';
import { c, table } from '../../output/index.js';
import { type Context } from '../context.js';

function initConfig(): number {
  const file = userConfigPath();
  if (fs.existsSync(file)) fail(file + ' already exists.');
  fs.mkdirSync(path.join(userDir(), 'hooks', 'pre-agent'), { recursive: true });
  // The schema sits next to the file (a local path), so editors trust it and show docs and autocomplete.
  writeJson(file, { $schema: './config.schema.json', ...DEFAULTS });
  console.log('Created ' + file + '. It lists every setting with its default; delete the ones you do not change.');
  console.log(
    'Your own hook scripts go in ' + path.join(userDir(), 'hooks') + '\\{pre-provision,pre-agent,post-agent}.',
  );
  console.log("For editor help in every project's .sandbox-config.json, run: sandbox config schema");
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
    if (policy === true) return 'outside the project, allowed (projects.allowOutsideMappings is true)';
    if (policy === false) return c.red('outside the project: refused (projects.allowOutsideMappings is false)');
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

export function config(ctx: Context): number {
  const [action = 'summary'] = ctx.options.positionals;
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
      console.log(JSON.stringify(ctx.loaded.config, null, 2));
      return 0;
    case 'schema':
      return printSchemaSettings();
    case 'check':
      return checkLocalConfig(ctx);
    default:
      fail('Unknown config action "' + action + '".', 'Use one of: sandbox config show | path | init | schema | check');
  }
}
