import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULTS, userConfigPath, userDir } from '../../../core/config/index.js';
import {
  describeOverrides,
  isTrusted,
  LOCAL_CONFIG_NAME,
  normalizeOverrides,
  readLocalConfig,
  trustStorePath,
} from '../../../core/local-config/index.js';
import { fail, safeText, writeJson } from '../../../core/util/index.js';
import { table } from '../../output/index.js';
import { type Context } from '../context.js';

const initConfig = (): number => {
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
};

/**
 * VS Code setting that maps every .sandbox-config.json (and the user config) to the local schema files, so project
 * files need no "$schema" line and nothing is fetched from the internet (remote schemas need trusting).
 */
const printSchemaSettings = (): number => {
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
};

/**
 * `sandbox config check`: the folder's .sandbox-config.json validated and described (risky settings flagged, approval
 * state), without launching. Fails with the same message a launch would give when the file is not valid.
 */
const checkLocalConfig = (ctx: Context): number => {
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
  for (const line of describeOverrides(overrides)) console.log('  ' + safeText(line));
  return 0;
};

export const config = (ctx: Context): number => {
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
};
