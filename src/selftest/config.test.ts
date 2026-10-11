// Loading the settings: built-in defaults, a user config file, and the example config that ships with the tool.
import path from 'node:path';
import _ from 'lodash';
import { DEFAULTS, loadConfig } from '../core/config.js';
import { readJsonc } from '../core/util.js';
import type { Suite } from './suite.js';

export const configSuite: Suite = {
  name: 'config',
  title: 'built-in defaults, user config file, config.example.json',
  run: async (t, f) => {
    t.section('built-in defaults');
    const builtIn = loadConfig();
    t.equal(
      {
        configPath: builtIn.configPath,
        guestWorkspace: builtIn.config.guestWorkspace,
        headless: builtIn.config.sandbox.headless,
        vGpu: builtIn.config.sandbox.vGpu,
        gitAccess: builtIn.config.provisioning.git.access,
      },
      { configPath: null, guestWorkspace: 'auto', headless: false, vGpu: false, gitAccess: 'full' },
      'with no user config the built-in defaults apply (auto guest folder, headless off, vGPU off, git full)',
    );

    t.section('a user config file');
    const customFile = t.writeJson(t.at('cfg.json'), {
      sandbox: { headless: true },
      toolchains: { rust: { enabled: false } },
      mappings: [{ host: 'rel-folder', guest: 'C:\\Rel', readOnly: true }],
    });
    const custom = loadConfig(customFile);
    t.equal(
      { headless: custom.config.sandbox.headless, rust: custom.config.toolchains.rust.enabled, python: custom.config.toolchains.python.enabled },
      { headless: true, rust: false, python: 'auto' },
      'a config file only needs the keys it changes (deep merge over the defaults)',
    );
    await t.throws(() => loadConfig(t.at('missing.json')), 'Config file not found', 'an explicit --config that does not exist is an error');

    t.dir('rel-folder');
    const relativeRun = await f.run({}, { ...custom.config, storage: f.baseConfig.storage });
    const mappedHosts = relativeRun.config.mappings.map((m) => m.host);
    t.check(mappedHosts.includes(t.at('rel-folder')), 'relative mappings in the user config resolve against the config file\'s folder', 'mapped hosts: ' + JSON.stringify(mappedHosts));

    t.section('config.example.json');
    const examplePath = path.join(t.packageRoot, 'config.example.json');
    t.equal(loadConfig(examplePath).config.defaultHarness, 'claude', 'config.example.json is valid');
    const example = _.omit(readJsonc<object>(examplePath), '$schema');
    t.check(_.isEqual(example, DEFAULTS), 'config.example.json lists exactly the built-in defaults', 'the differences are in: ' + Object.keys(DEFAULTS).filter((key) => !_.isEqual((example as Record<string, unknown>)[key], (DEFAULTS as unknown as Record<string, unknown>)[key])).join(', '));
  },
};
