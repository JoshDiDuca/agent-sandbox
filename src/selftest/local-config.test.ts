// A project's .sandbox-config.json: it must be approved before it applies, it can never loosen protections, and it is
// validated. The project file is untrusted input (it arrives with a cloned repository).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Downloader } from '../shared/download/index.js';
import type { Config } from '../core/types.js';
import { allowedAnswer, allowStorePath, saveAllowed } from '../core/local-config/index.js';
import type { Suite } from './support/suite.js';

export const localConfigSuite: Suite = {
  name: 'local-config',
  title: '.sandbox-config.json: approval, tighten-only rules, validation',
  run: async (t, f) => {
    t.section('approval');
    const localB = {
      harness: 'codex',
      sandbox: { memoryMb: 4096, networking: false, headless: true },
      toolchains: { node: { version: '18' }, rust: { enabled: false } },
      mappings: [
        { host: './assets', guest: 'C:\\Assets', readOnly: true },
        { host: './data', guest: 'C:\\Data', readOnly: false },
      ],
      scripts: ['./setup.mjs'],
    };
    f.writeLocal(f.workB, localB);
    const untrusted = await t.thrownMessage(() => f.run({ cwd: f.workB }));
    t.check(
      untrusted.includes('--trust-config') && untrusted.includes('READ/WRITE'),
      'an untrusted .sandbox-config.json is refused, with the way to approve it and what it would change',
      untrusted,
    );
    await t.throws(
      () => f.run({ cwd: f.workB, ask: async () => false }),
      'has not been approved',
      'answering "no" refuses it',
    );

    const approved = await f.run({ cwd: f.workB, ask: async () => true });
    t.equal(
      {
        harness: approved.harnessName,
        memoryMb: approved.config.sandbox.memoryMb,
        headless: approved.config.sandbox.headless,
        rustEnabled: approved.config.toolchains.rust.enabled,
        pythonStillOn: Boolean(approved.config.toolchains.python.enabled),
        nodeSource: approved.versions.node.source,
      },
      {
        harness: 'codex',
        memoryMb: 4096,
        headless: true,
        rustEnabled: false,
        pythonStillOn: true,
        nodeSource: '.sandbox-config.json',
      },
      'approved local settings apply over the defaults (including toolchains and headless)',
    );
    t.check(
      approved.config.mappings.some((m) => m.host === path.join(f.workB, 'data') && !m.readOnly) &&
        approved.scripts.includes(path.join(f.workB, 'setup.mjs')),
      'relative mapping and script paths resolve against the folder of .sandbox-config.json',
      JSON.stringify(approved.config.mappings),
    );
    t.equal(
      [
        (await f.run({ cwd: f.workB })).harnessName,
        (await f.run({ cwd: f.workB, noLocalConfig: true })).harnessName,
        (await f.run({ cwd: f.workB, harness: 'gemini' })).harnessName,
        (await f.run({ cwd: f.workB, headless: false })).config.sandbox.headless,
      ],
      ['codex', 'claude', 'gemini', false],
      'an approval is remembered; --no-local-config ignores the file; --harness and --window beat it',
    );
    f.writeLocal(f.workB, { ...localB, sandbox: { memoryMb: 6144 } });
    await t.throws(() => f.run({ cwd: f.workB }), 'has not been approved', 'changing the file requires approval again');

    t.section('validation');
    const dirC = t.dir('work-c');
    const rejectedBecause = (content: unknown, needle: string, name: string): Promise<void> => {
      f.writeLocal(dirC, content);
      return t.throws(() => f.run({ cwd: dirC, trustConfig: true }), needle, name);
    };
    await rejectedBecause(
      { storage: { root: 'C:\\x' } },
      'storage is not allowed',
      'a project file cannot change the storage folder',
    );
    await rejectedBecause(
      { harnesses: {} },
      'harnesses is not allowed',
      'a project file cannot change agent executables',
    );
    await rejectedBecause(
      { claudeProfile: { hostDir: 'C:\\x' } },
      'claudeProfile.hostDir is not allowed',
      'a project file cannot point at the Claude profile folder',
    );
    await rejectedBecause(
      { toolchains: { node: { hostDir: 'x' } } },
      'toolchains.node.hostDir is not allowed',
      'a project file cannot point at host tool folders',
    );
    await rejectedBecause(
      { sandbox: { memoryMb: 12 } },
      'sandbox.memoryMb:',
      'values are type-checked (memory too small)',
    );
    await rejectedBecause('{\n  // a comment\n  "readOnly": tru\n}', 'line 3', 'broken JSON is reported with its line');
    await rejectedBecause({ _comment: 'old style' }, '_comment is not allowed', 'unknown keys are rejected');
    f.writeLocal(dirC, '// comments and trailing commas are fine\n{\n  "readOnly": true, /* inline */\n}\n');
    t.equal(
      (await f.run({ cwd: dirC, trustConfig: true })).config.readOnly,
      true,
      '.sandbox-config.json may contain comments and trailing commas',
    );

    t.section('folders outside the project (projects.allowOutsideMappings)');
    const dirD = t.dir('work-d');
    const withOutside = (setting: Config['projects']['allowOutsideMappings']): Config => ({
      ...f.baseConfig,
      projects: { ...f.baseConfig.projects, allowOutsideMappings: setting },
    });
    const outsideFile = { mappings: [{ host: '../shared', readOnly: true }] };
    f.writeLocal(dirD, outsideFile);
    const notAllowed = await t.thrownMessage(() => f.run({ cwd: dirD, trustConfig: true }, withOutside(false)));
    t.check(
      notAllowed.includes('outside the project') &&
        notAllowed.includes(f.shared) &&
        notAllowed.includes('projects.allowOutsideMappings'),
      'false: refused, naming the folder and the setting that allows it',
      notAllowed,
    );
    const allowedOutside = await f.run({ cwd: dirD, trustConfig: true }, withOutside(true));
    t.check(
      allowedOutside.config.mappings.some((m) => m.host === f.shared) &&
        (allowedOutside.outsideMappings ?? []).includes(f.shared),
      'true: allowed, and marked as outside the project',
    );
    const asking = await t.thrownMessage(() =>
      f.run({ cwd: dirD, trustConfig: true, ask: async () => true, interactive: false }),
    );
    t.check(
      asking.includes('projects.allowOutsideMappings') && asking.includes('interactive'),
      '"ask" without a terminal (even with --trust-config) is refused',
      asking,
    );
    t.includes(
      await t.thrownMessage(() => f.run({ cwd: dirD, trustConfig: true, ask: async () => false, interactive: true })),
      'You did not allow',
      '"ask": answering no stops the launch',
    );
    const questions: string[] = [];
    f.writeLocal(dirD, { ...outsideFile, sandbox: { vGpu: true } });
    const asked = await f.run({
      cwd: dirD,
      trustConfig: true,
      interactive: true,
      ask: async (q) => {
        questions.push(q);
        return true;
      },
    });
    t.check(
      questions.length === 1 &&
        asked.config.sandbox.vGpu &&
        asked.config.mappings.some((m) => m.host === f.shared) &&
        (await f.run({ cwd: dirD, trustConfig: true, interactive: false })).config.mappings.some(
          (m) => m.host === f.shared,
        ),
      '"ask": the folder and a looser setting (vGPU) are asked together, once, and the answer is remembered',
      JSON.stringify(questions),
    );
    // What counts as outside is where the folder really is: environment variables are expanded and links followed.
    f.writeLocal(dirD, { mappings: [{ host: '%APPDATA%', readOnly: false }] });
    const viaVariable = await t.thrownMessage(() => f.run({ cwd: dirD, trustConfig: true }, withOutside(false)));
    fs.symlinkSync(f.shared, path.join(dirD, 'link'), 'junction');
    f.writeLocal(dirD, { mappings: [{ host: './link', readOnly: true }] });
    const viaLink = await t.thrownMessage(() => f.run({ cwd: dirD, trustConfig: true }, withOutside(false)));
    fs.rmSync(path.join(dirD, 'link'));
    f.writeLocal(dirD, { mappings: [{ host: './assets', readOnly: true }] });
    t.check(
      viaVariable.includes('outside the project') &&
        viaLink.includes('outside the project') &&
        (await f.run({ cwd: dirD, trustConfig: true }, withOutside(false))).config.mappings.some(
          (m) => m.host === path.join(dirD, 'assets'),
        ),
      'outside means where the folder really is (%VAR% expanded, links followed); a folder inside needs no permission',
    );

    t.section('a project can only tighten protections');
    // Settings that would loosen a protection are listed before approval, then ignored.
    f.writeLocal(dirC, {
      claudeProfile: { copyCredentials: true },
      network: { blockPrivateRanges: false },
      provisioning: { git: { access: 'full' } },
      sandbox: { vGpu: true, clipboard: true, networking: true, protectedClient: false },
      readOnly: false,
    });
    await t.throws(
      () => f.run({ cwd: dirC }),
      'only used if it is stricter',
      'settings a project may only tighten are called out before approval',
    );
    const strictUser: Config = {
      ...f.baseConfig,
      readOnly: true,
      network: { ...f.baseConfig.network, blockPrivateRanges: true },
      provisioning: { ...f.baseConfig.provisioning, git: { ...f.baseConfig.provisioning.git, access: 'readonly' } },
      sandbox: { ...f.baseConfig.sandbox, vGpu: false, clipboard: false, networking: false, protectedClient: true },
    };
    const keptRun = await f.run({ cwd: dirC, trustConfig: true }, strictUser);
    const kept = keptRun.config;
    t.equal(
      {
        readOnly: kept.readOnly,
        blockPrivateRanges: kept.network.blockPrivateRanges,
        gitAccess: kept.provisioning.git.access,
        vGpu: kept.sandbox.vGpu,
        clipboard: kept.sandbox.clipboard,
        networking: kept.sandbox.networking,
        protectedClient: kept.sandbox.protectedClient,
        copyCredentials: kept.claudeProfile.copyCredentials,
      },
      {
        readOnly: true,
        blockPrivateRanges: true,
        gitAccess: 'readonly',
        vGpu: false,
        clipboard: false,
        networking: false,
        protectedClient: true,
        copyCredentials: false,
      },
      'a project file can never loosen network, git, read-only, GPU, clipboard or login settings',
    );
    t.check(
      keptRun.notes.some((n) => n.includes('sandbox.vGpu = true') && n.includes('your own settings')),
      'what a project asked for and did not get is said at launch, with how to allow it',
      keptRun.notes.join('\n'),
    );
    // You allowed one request for this project (asked once at an interactive launch): only that one is let through.
    const store = allowStorePath(strictUser.storage.root);
    saveAllowed(store, path.join(dirC, '.sandbox-config.json'), 'sandbox.vGpu', true, true);
    saveAllowed(store, path.join(dirC, '.sandbox-config.json'), 'sandbox.clipboard', true, false);
    const allowedRun = await f.run({ cwd: dirC, trustConfig: true }, strictUser);
    t.check(
      allowedRun.config.sandbox.vGpu === true &&
        allowedRun.config.sandbox.clipboard === false &&
        allowedRun.config.sandbox.networking === false &&
        allowedAnswer(store, path.join(f.workB, '.sandbox-config.json'), 'sandbox.vGpu', true) === null &&
        allowedRun.notes.some((n) => n.includes('Allowed for this project: sandbox.vGpu')) &&
        allowedRun.notes.some((n) => n.includes('sandbox.clipboard') && n.includes('You said no')),
      'a request you allowed for this project is used and said so; one you declined and the others are not; answers are per project file',
      allowedRun.notes.join('\n'),
    );
    f.writeLocal(dirC, {
      readOnly: true,
      network: { blockPrivateRanges: true },
      provisioning: { git: { access: 'none' } },
      sandbox: { networking: false, clipboard: false },
    });
    const tightened = (await f.run({ cwd: dirC, trustConfig: true })).config;
    t.equal(
      [
        tightened.readOnly,
        tightened.provisioning.git.access,
        tightened.sandbox.networking,
        tightened.sandbox.clipboard,
      ],
      [true, 'none', false, false],
      'a project file can still make things stricter',
    );

    t.section('downloads.requireChecksum');
    f.writeLocal(dirC, { downloads: { requireChecksum: false } });
    const keptOn = (
      await f.run({ cwd: dirC, trustConfig: true }, { ...f.baseConfig, downloads: { requireChecksum: true } })
    ).config;
    f.writeLocal(dirC, { downloads: { requireChecksum: true } });
    const turnedOn = (await f.run({ cwd: dirC, trustConfig: true })).config;
    t.check(
      keptOn.downloads.requireChecksum === true && turnedOn.downloads.requireChecksum === true,
      'a project file cannot switch the checksum requirement off, but can switch it on',
    );
    // With the requirement on, a download without a hash is refused before anything is fetched.
    const strict = new Downloader();
    strict.requireChecksum = true;
    const target = path.join(os.tmpdir(), 'agent-sandbox-no-such-download.bin');
    const refused = await strict.file('http://127.0.0.1:9/tool.zip', target).then(
      () => '',
      (e: Error) => e.message,
    );
    t.check(
      refused.includes('requireChecksum') &&
        refused.includes('tool.zip') &&
        !fs.existsSync(target) &&
        !fs.existsSync(target + '.part'),
      'a download with no hash is refused when checksums are required, naming it, leaving nothing behind',
    );
    fs.rmSync(path.join(dirC, '.sandbox-config.json'));
  },
};
