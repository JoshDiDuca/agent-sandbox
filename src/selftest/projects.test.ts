// Several projects in one sandbox: guest paths, joining a running sandbox, the project spec sent to the guest,
// tighten-only protections, boot wants, repo guard and --session. Offline: temp folders only.
import fs from 'node:fs';
import path from 'node:path';
import type { ResolvedRun, SessionStatus } from '../core/types.js';
import { LocalOverridesSchema } from '../core/schema/index.js';
import {
  allowStorePath,
  checkJoin,
  describeMissing,
  missingAtBoot,
  nothingMissing,
  protectionsOf,
  saveAllowed,
} from '../core/local-config/index.js';
import { SandboxChannel, sessionsFirstIn } from '../host/channel/index.js';
import { buildWsb } from '../host/launch/index.js';
import { projectSpec, joinRunning } from '../host/projects/index.js';
import { allProjectsToMap, KnownProjects } from '../host/projects/index.js';
import { NeedsRestart, projectMapper } from '../host/projects/index.js';
import { parseWsbBoot, ProjectRegistry } from '../host/projects/index.js';
import { RepoGuardStore } from '../host/guard/index.js';
import { findWsb, parseCommands, parseIp, parseList, parseVersion } from '../host/sandbox/index.js';
import { baseEnvFor } from '../guest/boot/project-env.js';
import {
  guestDirFor,
  hostDirFor,
  hubName,
  insideProjects,
  isWithin,
  planProjectMappings,
  projectForGuestDir,
  projectForHostDir,
  PROJECTS_GUEST,
  rootGuestDir,
} from '../shared/paths/index.js';
import { GuestRequestSchema, ProjectSpecSchema, RunDir } from '../shared/channel/index.js';
import { projectFolderName } from '../shared/paths/index.js';
import { syncHistoryOut } from '../sync/index.js';
import { validateOptions, validateProjectsArgs } from '../cli/validate.js';
import { parseCli, parseSessionWant } from '../cli/args.js';
import { severalAgentsArgv } from '../cli/menu/index.js';
import type { Context } from '../cli/commands/context.js';
import { generateSandbox } from '../host/launch/index.js';
import { describeSessions } from '../cli/commands/projects/index.js';
import type { Suite } from './support/suite.js';

/** The error `fn` throws, or null. */
const caught = (fn: () => unknown): unknown => {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
};

export const projectsSuite: Suite = {
  name: 'projects',
  title: 'several projects in one sandbox (paths, joining, policy, specs, --session)',
  run: async (t, f) => {
    t.section('projects: guest paths');
    t.check(
      isWithin('C:\\code\\a', 'c:\\CODE\\a\\src') && !isWithin('C:\\code\\a', 'C:\\code\\ab'),
      'isWithin: case-insensitive, and no prefix matches (a vs ab)',
    );
    t.check(
      hubName('F:\\Code\\my app (v2)', []) === 'my-app-v2' &&
        hubName('F:\\Code\\api', ['API', 'api-2']) === 'api-3' &&
        hubName('F:\\' + 'x'.repeat(80), []).length === 48,
      'project ids are file-name safe, unique (case-insensitive) and capped',
    );
    const projects = [
      { host: 'F:\\Code', guest: 'C:\\Projects\\Code' },
      { host: 'F:\\Code\\api', guest: 'C:\\Projects\\api' },
    ];
    t.check(
      projectForHostDir(projects, 'f:\\code\\api\\src')?.guest === 'C:\\Projects\\api' &&
        projectForHostDir(projects, 'F:\\Code\\web')?.guest === 'C:\\Projects\\Code' &&
        projectForHostDir(projects, 'F:\\Other') === null &&
        projectForGuestDir(projects, 'C:\\Projects\\api\\x')?.host === 'F:\\Code\\api',
      'the most specific mapped folder wins; unrelated folders belong to no project',
    );
    const mapped = { host: 'F:\\Code', guest: 'C:\\Projects\\Code' };
    const webGuest = guestDirFor(mapped, 'F:\\Code\\web\\src');
    t.check(
      webGuest === 'C:\\Projects\\Code\\web\\src' && hostDirFor(mapped, webGuest) === 'F:\\Code\\web\\src',
      'host folder <-> guest folder round trip',
    );
    t.check(
      insideProjects('c:\\projects\\api\\src') &&
        !insideProjects('C:\\Projects') &&
        !insideProjects('C:\\ProjectsX\\a') &&
        insideProjects('F:\\Code\\web', ['F:\\Code']),
      'C:\\Projects\\<name> holds projects (not look-alikes); a mirrored root counts too',
    );
    const plan = planProjectMappings(
      ['F:\\Code', 'E:\\Work\\Code', 'C:\\Users\\me\\src'],
      ['D:\\x\\api', 'D:\\y\\api'],
      false,
    );
    t.equal(
      [plan.roots.map((r) => r.guest), plan.projects.map((p) => p.guest)],
      [
        ['C:\\Projects\\Code', 'C:\\Projects\\Code-2', 'C:\\Projects\\src'],
        ['C:\\Workspace\\api', 'C:\\Workspace\\api-2'],
      ],
      'roots and projects mapped on their own get unique guest folders',
    );
    t.equal(
      planProjectMappings([], ['D:\\x\\app'], false, ['C:\\Workspace\\app']).projects[0].guest,
      'C:\\Workspace\\app-2',
      "a project mapped on its own never lands on the launch folder's place",
    );
    t.equal(
      [
        planProjectMappings(['F:\\Code'], ['D:\\x\\api'], true).projects[0].guest,
        planProjectMappings(['F:\\Code', 'C:\\Users\\me\\src'], [], true).roots.map((r) => r.guest),
      ],
      ['D:\\x\\api', ['F:\\Code', 'C:\\Projects\\src']],
      'with "mirror" folders appear at their PC path when the sandbox can show it there (C:\\Users\\... cannot)',
    );
    t.check(
      rootGuestDir(['F:\\Code'], false, 'F:\\Code\\web\\src') === 'C:\\Projects\\Code\\web\\src' &&
        rootGuestDir(['F:\\Code'], false, 'F:\\Other') === null,
      'a folder inside a root is placed under the root; one in no root has no root place',
    );

    t.section('projects: tighten-only protections when joining a running sandbox');
    const base = protectionsOf(f.baseConfig);
    const same = checkJoin(base, base);
    t.equal(
      { stricter: same.stricter, looser: same.looser },
      { stricter: [], looser: [] },
      'the same settings join without notes',
    );
    const readonlyGit = protectionsOf({
      ...f.baseConfig,
      provisioning: { ...f.baseConfig.provisioning, git: { ...f.baseConfig.provisioning.git, access: 'readonly' } },
    });
    const loosening = checkJoin(readonlyGit, base);
    t.check(
      checkJoin(base, readonlyGit).stricter.some((s) => s.startsWith('provisioning.git.access')) &&
        loosening.stricter.length === 0 &&
        loosening.looser.some((s) => s.includes('provisioning.git.access stays "readonly"')),
      'stricter git access than the running sandbox is refused; asking for less keeps the sandbox value with a note',
      JSON.stringify(loosening.looser),
    );
    const offline = protectionsOf({ ...f.baseConfig, sandbox: { ...f.baseConfig.sandbox, networking: false } });
    t.check(
      checkJoin(base, offline).stricter.some((s) => s.startsWith('sandbox.networking')) &&
        checkJoin(offline, base).looser.some((s) => s.startsWith('sandbox.networking')),
      'networking off is stricter, networking on is looser',
    );
    const readOnly = protectionsOf({ ...f.baseConfig, readOnly: true });
    t.check(
      checkJoin(readOnly, readOnly).stricter.some((s) => s.startsWith('readOnly')),
      'a read-only project cannot join (other projects are mapped read/write)',
    );
    t.check(
      !LocalOverridesSchema.safeParse({ projects: { roots: ['C:\\'] } }).success &&
        !LocalOverridesSchema.safeParse({ projects: { all: true } }).success,
      "a project's .sandbox-config.json can never set projects.roots or projects.all",
    );

    const strictUser = structuredClone(f.baseConfig);
    strictUser.provisioning.git.access = 'readonly';
    const looseDir = t.dir('proj-loose');
    f.writeLocal(looseDir, { provisioning: { git: { access: 'full' } } });
    const loose = await f.run({ cwd: looseDir, trustConfig: true }, strictUser);
    t.check(
      loose.config.provisioning.git.access === 'readonly' &&
        checkJoin(protectionsOf(strictUser), protectionsOf(loose.config)).stricter.length === 0,
      'a project file cannot loosen git access, so it joins a readonly sandbox as readonly',
    );
    const tightDir = t.dir('proj-tight');
    f.writeLocal(tightDir, { provisioning: { git: { access: 'none' } } });
    const tight = await f.run({ cwd: tightDir, trustConfig: true });

    t.section('projects: registry and joining');
    const storage = t.at('proj-storage');
    const data = path.join(storage, 'data', 'testdata');
    t.dir('proj-storage', 'data', 'testdata');
    const root = t.at('proj-root');
    const inRoot = t.dir('proj-root', 'web');
    const outside = t.dir('proj-outside');
    const primary = new ProjectRegistry(storage).start({
      launchId: '1700000000000-abcdef',
      protections: base,
      primary: { host: f.workA, guest: 'C:\\Workspace\\work-a' },
      roots: [{ host: root, guest: 'C:\\Projects\\proj-root' }],
      boot: [{ host: f.workB, guest: 'C:\\Projects\\work-b' }],
    });
    const registry = new ProjectRegistry(storage).read();
    t.check(
      primary.primary &&
        registry?.projects.length === 2 &&
        registry.projects[1].mechanism === 'boot' &&
        registry.projects[1].name === 'work-b',
      'at launch the registry holds the launch folder (primary) and the projects mapped with it',
    );
    t.check(
      new ProjectRegistry(storage).here(path.join(f.workA, 'src'))?.guestDir === 'C:\\Workspace\\work-a\\src' &&
        new ProjectRegistry(storage).here(outside) === null,
      'here: a folder inside a project finds it, a folder in no project does not',
    );
    const noWsb = projectMapper({ storageRoot: storage, packageRoot: f.install, wsbShare: true, detect: () => null });
    const web = noWsb.register(inRoot);
    t.check(
      web.mechanism === 'root' &&
        web.guest === 'C:\\Projects\\proj-root\\web' &&
        noWsb.register(inRoot).name === web.name &&
        new ProjectRegistry(storage).read()?.projects.filter((p) => p.host === inRoot).length === 1,
      'a folder inside a root joins at once, and only once',
    );
    const needs = caught(() => noWsb.register(outside));
    const shareOff = caught(() =>
      projectMapper({ storageRoot: storage, packageRoot: f.install, wsbShare: false }).register(outside),
    );
    t.check(
      needs instanceof NeedsRestart &&
        needs.reason.includes('wsb share needs Windows 11 24H2') &&
        shareOff instanceof NeedsRestart &&
        shareOff.reason.includes('projects.wsbShare'),
      'a folder outside every root needs a restart when wsb share is missing or switched off, and says why',
    );
    const listFails = caught(() =>
      projectMapper({
        storageRoot: storage,
        packageRoot: f.install,
        wsbShare: true,
        detect: () => ({
          exe: t.at('no-such-wsb.exe'),
          version: '0.1.0',
          commands: ['share', 'list'],
          has: (c) => c === 'share' || c === 'list',
        }),
      }).register(outside),
    );
    t.check(
      listFails instanceof NeedsRestart && listFails.reason.includes('wsb share could not find the running sandbox'),
      'when wsb cannot tell which sandbox is ours, it falls back to the restart offer',
    );
    await t.throws(() => noWsb.register(storage), 'cannot be the workspace', 'joining refuses the storage folder');
    await t.throws(() => noWsb.register('C:\\'), 'whole drive', 'joining refuses a drive root');
    await t.throws(
      () => noWsb.unregister(primary.name),
      'stays until the sandbox stops',
      'the launch folder cannot be removed from a running sandbox',
    );

    const resolveFor = (run: ResolvedRun) => async (): Promise<ResolvedRun> => run;
    const join = (hostDir: string, resolve: () => Promise<ResolvedRun>) =>
      joinRunning({ storageRoot: storage, dataPath: data, packageRoot: f.install, hostDir, wsbShare: false, resolve });
    const webRun = await f.run({ cwd: inRoot, trustConfig: true });
    const joined = await join(inRoot, resolveFor(webRun));
    t.check(
      joined.spec?.workspace === 'C:\\Projects\\proj-root\\web' &&
        ProjectSpecSchema.safeParse(joined.spec).success &&
        joined.spec.harnesses.claude !== undefined &&
        new KnownProjects(storage).list().some((k) => k.host === inRoot),
      'joining builds a valid spec with its guest folder and the agent, and remembers the project',
    );
    const launchFolder = await join(path.join(f.workA, 'sub'), () => Promise.reject(new Error('must not resolve')));
    t.equal(launchFolder.spec, null, 'the launch folder (and below) needs no spec');
    await t.throws(
      () => join(tightDir, resolveFor(tight)),
      'stricter than the running sandbox',
      'a project that tightens git access beyond the running sandbox is refused without consent',
    );
    t.check(
      new ProjectRegistry(storage).read()?.projects.every((p) => p.host !== tightDir) === true,
      'a refused project is not registered',
    );
    let asked: string[] = [];
    const agreed = await t.thrownMessage(() =>
      joinRunning({
        storageRoot: storage,
        dataPath: data,
        packageRoot: f.install,
        hostDir: tightDir,
        wsbShare: false,
        resolve: resolveFor(tight),
        acceptStricter: async (_name, stricter) => {
          asked = stricter;
          return true;
        },
      }),
    );
    t.check(
      asked.some((s) => s.startsWith('provisioning.git.access')) &&
        !agreed.includes('stricter than the running sandbox'),
      'with your consent it is not refused for its stricter settings',
      agreed,
    );
    const outsideRun = await f.run({ cwd: outside });
    await t.throws(
      () => join(outside, resolveFor(outsideRun)),
      'projects.wsbShare',
      'a folder that cannot be shown lets NeedsRestart reach the caller',
    );

    t.section('projects: the spec and request the guest gets');
    const spec = projectSpec(webRun, web, false);
    const sessionRequest = (extra: Record<string, unknown>) =>
      GuestRequestSchema.safeParse({
        kind: 'session',
        id: 'r1',
        harness: 'claude',
        args: [],
        cwd: spec.workspace,
        createdAt: new Date().toISOString(),
        ...extra,
      });
    t.check(
      sessionRequest({ project: spec, harnessSpec: f.baseConfig.harnesses.codex }).success,
      'a session request carries a project spec and an agent definition',
    );
    const codexId = new SandboxChannel(data, () => true).requestSession('codex', [], spec.workspace, {
      project: spec,
      harnessSpec: f.baseConfig.harnesses.codex,
    });
    const codexRequest = GuestRequestSchema.parse(
      JSON.parse(fs.readFileSync(new RunDir(data).requestFile(codexId), 'utf8')),
    );
    t.check(
      codexRequest.kind === 'session' &&
        codexRequest.harness === 'codex' &&
        codexRequest.cwd === spec.workspace &&
        codexRequest.project?.name === spec.name &&
        codexRequest.harnessSpec?.npmBin === 'codex',
      'an agent asked for in a joined project is requested there, with its definition',
    );
    const manyDatabases = Array(9).fill(
      spec.databases[0] ?? { database: 'redis', reasons: [], version: 'x', port: 6379 },
    );
    const manyAgents = Object.fromEntries(Array.from({ length: 9 }, (_, i) => ['a' + i, f.baseConfig.harnesses.codex]));
    t.check(
      !sessionRequest({ project: { ...spec, name: '..\\evil' } }).success &&
        !sessionRequest({ project: { ...spec, extra: 1 } }).success &&
        !sessionRequest({ project: { ...spec, databases: manyDatabases } }).success &&
        !sessionRequest({ project: { ...spec, harnesses: manyAgents } }).success,
      'specs are validated: file-name safe ids, no unknown keys, capped lists',
    );
    t.check(
      GuestRequestSchema.safeParse({ kind: 'project', id: 'p1', project: spec, createdAt: 'x' }).success &&
        !GuestRequestSchema.safeParse({ kind: 'project', id: 'p1', createdAt: 'x' }).success,
      '"project" requests need a spec',
    );

    t.section('projects: which projects are mapped at boot');
    t.equal(
      allProjectsToMap(['C:\\a', 'C:\\a\\b', 'C:\\work-a\\x', 'C:\\r\\p', 'C:\\ex\\y', 'C:\\gone'], {
        primary: 'C:\\work-a',
        roots: ['C:\\r'],
        exclude: ['C:\\ex'],
        exists: (p) => p !== 'C:\\gone',
      }),
      ['C:\\a'],
      "projects.all: known projects except excluded, missing, nested, the launch folder's and the roots'",
    );
    const rootConfig = structuredClone(f.baseConfig);
    rootConfig.projects = { ...rootConfig.projects, roots: [root, t.at('no-such-root')], all: true };
    new KnownProjects(f.baseConfig.storage.root).remember(outside);
    const gen = f.generate(await f.run({}, rootConfig));
    const session = f.readJson(gen.sessionPath);
    const wsb = fs.readFileSync(gen.wsbPath, 'utf8');
    t.check(
      gen.projects.roots.map((r) => r.guest).join() === 'C:\\Projects\\proj-root' &&
        gen.projects.notes.some((n) => n.includes('no-such-root')) &&
        gen.projects.projects.some((p) => p.host === outside),
      'roots are mapped as C:\\Projects\\<name>, a missing root is skipped with a note, projects.all maps known projects',
      JSON.stringify(gen.projects.notes),
    );
    t.includes(
      wsb,
      '<HostFolder>' +
        root +
        '</HostFolder><SandboxFolder>C:\\Projects\\proj-root</SandboxFolder><ReadOnly>false</ReadOnly>',
      'roots are mapped read/write in the .wsb',
    );
    t.equal(
      { projectsDir: session.projectsDir, roots: session.roots, projectId: session.projectId },
      {
        projectsDir: PROJECTS_GUEST,
        roots: ['C:\\Projects\\proj-root', 'C:\\Workspace\\proj-outside'],
        projectId: 'work-a',
      },
      'session.json tells the guest where other projects can be',
    );
    // A project is at the same place whether it started the sandbox or joined one another project started.
    const fromRoot = f.generate(await f.run({ cwd: inRoot }, rootConfig));
    t.check(
      f.readJson(fromRoot.sessionPath).workspace === 'C:\\Projects\\proj-root\\web' &&
        guestDirFor(gen.projects.roots[0], inRoot) === 'C:\\Projects\\proj-root\\web' &&
        !fromRoot.mappings.some((m) => m.host.toLowerCase() === inRoot.toLowerCase()),
      'a project in a root: same guest folder as launch folder or joined, and no second mapping of it',
    );
    t.includes(
      fs.readFileSync(path.join(fromRoot.launchPath, 'env.cmd'), 'utf8'),
      'AGENT_WORKSPACE=C:\\Projects\\proj-root\\web',
      'env.cmd: AGENT_WORKSPACE follows',
    );
    const asLaunch = f.readJson(f.generate(await f.run({ cwd: outside })).sessionPath).workspace;
    t.equal(
      [asLaunch, gen.projects.projects.find((p) => p.host === outside)?.guest],
      ['C:\\Workspace\\proj-outside', 'C:\\Workspace\\proj-outside'],
      'a project outside the roots: the same guest folder as launch folder and when mapped at boot',
    );
    const mirrorRoot = structuredClone(rootConfig);
    mirrorRoot.guestWorkspace = 'mirror';
    t.equal(
      f.readJson(f.generate(await f.run({ cwd: inRoot }, mirrorRoot)).sessionPath).workspace,
      rootGuestDir([root], true, inRoot),
      'with "mirror" a launch folder inside a root is where the root shows it',
    );
    const filtered = structuredClone(rootConfig);
    filtered.workspaceFilter = { ...filtered.workspaceFilter, enabled: true };
    const filteredRun = await f.run({ cwd: inRoot }, filtered);
    t.check(
      filteredRun.config.guestWorkspace === 'C:\\Workspace\\web' &&
        filteredRun.notes.some((n) => n.includes('C:\\Projects\\proj-root\\web')),
      'workspaceFilter: a launch folder inside a root keeps its own mapping, with a note where the root shows it',
      JSON.stringify(filteredRun.notes),
    );
    const badRoot = structuredClone(f.baseConfig);
    badRoot.projects = { ...badRoot.projects, roots: [f.baseConfig.storage.root] };
    await t.throws(
      async () => f.generate(await f.run({}, badRoot)),
      'projects.roots',
      'a root that would expose the storage folder is refused',
    );
    t.check(
      new KnownProjects(f.baseConfig.storage.root).forget(outside) &&
        !new KnownProjects(f.baseConfig.storage.root).list().some((k) => k.host === outside),
      '`sandbox projects remove` forgets a project',
    );

    t.section('projects: repo guard for every project the sandbox can write');
    const guardData = t.at('guard-data');
    const rootG = t.at('guard-root');
    const old = path.join(rootG, 'old');
    t.write(path.join(old, '.git', 'hooks', 'pre-commit'), 'mine');
    t.write(path.join(old, '.git', 'config'), '[core]\n\tbare = false\n');
    new RepoGuardStore(guardData).save(f.workA, [], [rootG]);
    t.write(path.join(old, '.git', 'hooks', 'post-checkout'), 'planted');
    const fresh = path.join(rootG, 'created-later');
    t.write(path.join(fresh, '.git', 'hooks', 'pre-push'), 'planted');
    t.write(path.join(fresh, '.git', 'config'), '[core]\n\tfsmonitor = evil.exe\n\tbare = false\n');
    t.write(path.join(fresh, 'node.exe'), 'planted');
    const found = new RepoGuardStore(guardData).check();
    t.check(
      fs.existsSync(path.join(old, '.git', 'hooks', 'pre-commit')) &&
        !fs.existsSync(path.join(old, '.git', 'hooks', 'post-checkout')),
      'a hook from before the sandbox stays; one added inside it to a project in a root is quarantined',
    );
    t.check(
      !fs.existsSync(path.join(fresh, '.git', 'hooks', 'pre-push')) &&
        !fs.existsSync(path.join(fresh, 'node.exe')) &&
        fs.readFileSync(path.join(fresh, '.git', 'config'), 'utf8').includes('# [agent-sandbox] disabled') &&
        found.some((x) => x.detail.startsWith(fresh)),
      'a project that appeared in a root after the start has hooks, commands and program-running git config removed',
      JSON.stringify(found),
    );

    t.section('projects: history and environment');
    const hostClaude = t.at('hist-host');
    const guestClaude = t.at('hist-guest');
    const bHost = t.at('hist-b');
    t.write(
      path.join(guestClaude, 'projects', projectFolderName('C:\\Projects\\hist-b'), 's.jsonl'),
      JSON.stringify({ cwd: 'C:\\Projects\\hist-b\\src' }) + '\n',
    );
    syncHistoryOut({
      hostClaudeDir: hostClaude,
      guestClaudeDir: guestClaude,
      hostWorkspace: f.workA,
      guestWorkspace: 'C:\\Workspace\\work-a',
      extra: [{ hostWorkspace: bHost, guestWorkspace: 'C:\\Projects\\hist-b' }],
    });
    const back = path.join(hostClaude, 'projects', projectFolderName(bHost), 's.jsonl');
    t.check(
      fs.existsSync(back) && fs.readFileSync(back, 'utf8').includes(JSON.stringify(bHost + '\\src').slice(1, -1)),
      "a joined project's history goes back to ITS folder on this PC, with paths translated",
    );
    const env = baseEnvFor(
      { basePath: 'C:\\Windows', toolVars: ['NVM_HOME', 'CARGO_HOME'], steps: {}, summary: [], lan: 'blocked' },
      {
        Path: 'C:\\tools\\a;C:\\Windows',
        NVM_HOME: 'x',
        CARGO_HOME: 'y',
        CARGO_TARGET_DIR: 'C:\\Workspace\\a\\target',
        AGENT_WORKSPACE: 'C:\\Workspace\\a',
        TEMP: 'C:\\t',
      },
    );
    t.equal(
      [env.PATH, env.NVM_HOME, env.CARGO_TARGET_DIR, env.AGENT_WORKSPACE, env.TEMP],
      ['C:\\Windows', undefined, undefined, undefined, 'C:\\t'],
      "a joined project starts from the boot's base environment: none of the first project's tools or folders",
    );

    t.section('projects: commands');
    const status = (id: string, cwd: string, startedAt: string): SessionStatus => ({
      id,
      launchId: 'l',
      harness: 'claude',
      cwd,
      phase: 'running',
      message: '',
      updatedAt: startedAt,
      startedAt,
    });
    t.equal(
      sessionsFirstIn(
        [
          status('a1', 'C:\\Workspace\\a', '1'),
          status('b1', 'C:\\Projects\\b', '2'),
          status('a2', 'C:\\Workspace\\a\\x', '3'),
          status('b2', 'C:\\Projects\\b\\y', '4'),
        ],
        'C:\\Projects\\b',
      ).map((x) => x.id),
      ['b2', 'b1', 'a2', 'a1'],
      "this project's sessions come first, newest first",
    );
    t.equal(
      describeSessions([
        { harness: 'claude', cwd: 'C:\\Workspace\\api', project: 'api' },
        { harness: 'codex', cwd: 'C:\\Projects\\web' },
      ]),
      '2 sessions (claude in api, codex in web)',
      'the restart offer lists the sessions that would end',
    );
    await t.throws(
      () => validateProjectsArgs(['bogus']),
      'projects action',
      '`sandbox projects` rejects an unknown action',
    );
    await t.throws(() => validateProjectsArgs(['add']), 'Which folder', '`sandbox projects add` needs a folder');
    validateProjectsArgs([]);
    validateProjectsArgs(['all', 'on']);

    t.section('projects: several sessions at once (--session agent@folder)');
    const want = parseSessionWant('claude@C:\\code\\a@b', 'C:\\here');
    t.check(
      want.harness === 'claude' &&
        want.folder === 'C:\\code\\a@b' &&
        parseSessionWant('codex', 'C:\\here').folder === 'C:\\here' &&
        parseSessionWant('gemini@sub', 'C:\\here').folder === 'C:\\here\\sub',
      '--session: the first @ splits agent from folder; no folder means this one; relative folders become absolute',
    );
    await t.throws(() => parseSessionWant('@C:\\x'), 'names no agent', '--session without an agent is refused');
    const own = parseSessionWant('codex@C:\\code\\web|--model o3 "two words"', 'C:\\here');
    t.equal(
      { folder: own.folder, args: own.args },
      { folder: 'C:\\code\\web', args: ['--model', 'o3', 'two words'] },
      "--session: after | come that agent's own arguments (quotes keep words together)",
    );
    const multi = parseCli([
      'launch',
      '--session',
      'claude@' + f.workA + '|--continue',
      '--session',
      'codex@' + f.workB,
      '--session',
      'claude@' + f.workB,
      '-t',
      '--',
      '--verbose',
    ]);
    t.equal(
      {
        sessions: multi.sessions.length,
        terminal: multi.terminal,
        second: multi.sessions[1].harness,
        own: multi.sessions.map((s) => s.args ?? []),
        passthrough: multi.passthrough,
      },
      { sessions: 3, terminal: true, second: 'codex', own: [['--continue'], [], []], passthrough: ['--verbose'] },
      'several --session options parse in order, with -t, own arguments and shared arguments after --',
    );
    const validationContext = (options: ReturnType<typeof parseCli>) =>
      ({
        packageRoot: f.install,
        entry: '',
        options,
        loaded: { config: f.baseConfig, configPath: null, base: t.temp },
        storageRoot: f.baseConfig.storage.root,
        dataPath: t.at('vdata'),
      }) as Context;
    await t.throws(
      () => validateOptions(validationContext(parseCli(['launch', '--session', 'claud@' + f.workA]))),
      'Did you mean',
      'an unknown agent in --session suggests the closest one',
    );
    await t.throws(
      () =>
        validateOptions(
          validationContext(parseCli(['launch', '--session', 'claude@' + f.workA, '--harness', 'codex'])),
        ),
      'do not apply',
      '--session cannot be mixed with --harness/--workspace',
    );
    validateOptions(validationContext(multi));
    t.equal(
      severalAgentsArgv(
        [
          { harness: 'claude', folder: 'C:\\a' },
          { harness: 'codex', folder: 'C:\\b c' },
        ],
        { headless: true, attachFirst: true },
      ).join(' '),
      'launch --session claude@C:\\a --session codex@C:\\b c --headless -t',
      'the menu builds the same command line (so repeat-last works)',
    );
    const multiGen = generateSandbox({
      packageRoot: t.packageRoot,
      run: await f.run(),
      harnessArgs: [],
      probe: f.probe,
      extraProjects: [f.workB, path.join(f.workA, 'sub'), f.workB],
      autoSession: false,
    });
    const multiSession = f.readJson(multiGen.sessionPath);
    t.check(
      multiGen.projects.projects.map((p) => p.guest).join() === 'C:\\Workspace\\work-b' &&
        fs
          .readFileSync(multiGen.wsbPath, 'utf8')
          .includes('<HostFolder>' + f.workB + '</HostFolder><SandboxFolder>C:\\Workspace\\work-b</SandboxFolder>') &&
        multiSession.autoSession === false &&
        multiSession.workspaceHost === f.workA,
      'a multi-project launch maps every other project once; the boot provisions only the launch folder',
    );

    t.section('projects: what a joining project wants at boot (vGPU, its mappings)');
    const games = t.dir('proj-games');
    t.dir('proj-games', 'assets');
    f.writeLocal(games, {
      sandbox: { vGpu: true },
      mappings: [{ host: 'assets', guest: 'F:\\GameAssets', readOnly: true }],
    });
    saveAllowed(
      allowStorePath(f.baseConfig.storage.root),
      path.join(games, '.sandbox-config.json'),
      'sandbox.vGpu',
      true,
      true,
    );
    const gamesRun = await f.run({ cwd: games, trustConfig: true });
    const launchedRun = await f.run();
    const runningBoot = {
      memoryMb: 8192,
      mappings: [{ host: f.workA, guest: 'C:\\Workspace\\work-a', readOnly: false }],
    };
    const wanted = missingAtBoot(protectionsOf(launchedRun.config), runningBoot, gamesRun.config, fs.existsSync);
    t.equal(
      { settings: wanted.settings, memoryMb: wanted.memoryMb, mappings: wanted.mappings.map((m) => m.guest) },
      { settings: ['sandbox.vGpu'], memoryMb: null, mappings: ['F:\\GameAssets'] },
      "missingAtBoot: vGPU and the project's folder are missing from a sandbox started without them",
    );
    const mappedMirror = missingAtBoot(
      protectionsOf(gamesRun.config),
      {
        memoryMb: 8192,
        mappings: [{ host: path.join(games, 'assets'), guest: 'C:\\Mirror\\F\\GameAssets', readOnly: true }],
      },
      gamesRun.config,
      fs.existsSync,
    );
    t.check(
      nothingMissing(mappedMirror),
      'missingAtBoot: nothing missing when the sandbox has vGPU and the folder (F:\\x is C:\\Mirror\\F\\x in the .wsb)',
      JSON.stringify(mappedMirror),
    );
    t.equal(
      describeMissing('mw2-agent', {
        settings: ['sandbox.vGpu'],
        memoryMb: null,
        mappings: [
          { host: 'C:\\Steam\\common', guest: 'C:\\Steam', readOnly: true },
          { host: 'F:\\SteamLibrary', guest: 'F:\\SteamLibrary', readOnly: true },
        ],
      }),
      'mw2-agent wants vGPU and 2 folders (C:\\Steam\\common, F:\\SteamLibrary), but this sandbox started without them.',
      'the message names each missing item',
    );
    t.equal(
      parseWsbBoot(buildWsb(f.baseConfig, 6144, [{ host: 'C:\\a&b', guest: 'F:\\x', readOnly: true }])),
      { memoryMb: 6144, mappings: [{ host: 'C:\\a&b', guest: 'C:\\Mirror\\F\\x', readOnly: true }], widened: {} },
      'a sandbox started by an older version: memory and mapped folders are read back from its .wsb',
    );
    const widenedJoin = checkJoin({ ...base, 'sandbox.vGpu': true }, base, ['sandbox.vGpu']);
    t.check(
      widenedJoin.stricter.length === 0 &&
        widenedJoin.shared.join() === 'sandbox.vGpu' &&
        checkJoin({ ...base, 'sandbox.vGpu': true }, base).stricter.some((s) => s.startsWith('sandbox.vGpu')),
      'vGPU turned on at boot for a project you allowed it for is shared; without that record it is refused',
    );

    // joinRunning asks before anything is registered: restart (NeedsRestart with what is missing), or continue without.
    const storage2 = t.dir('proj-storage2');
    const data2 = t.dir('proj-storage2', 'data', 'testdata');
    new ProjectRegistry(storage2).start({
      launchId: '1700000000001-abcdef',
      protections: protectionsOf(launchedRun.config),
      primary: { host: f.workA, guest: 'C:\\Workspace\\work-a' },
      roots: [{ host: path.dirname(games), guest: 'C:\\Projects\\temp' }],
      boot: [],
      atBoot: { ...runningBoot, widened: {} },
    });
    const joinGames = (choice: 'continue' | 'restart' | 'cancel') =>
      joinRunning({
        storageRoot: storage2,
        dataPath: data2,
        packageRoot: f.install,
        hostDir: games,
        wsbShare: false,
        resolve: resolveFor(gamesRun),
        decide: async () => choice,
      });
    const restartFor = await joinGames('restart').then(
      () => null,
      (e: unknown) => e,
    );
    t.check(
      restartFor instanceof NeedsRestart &&
        restartFor.missing?.settings.includes('sandbox.vGpu') === true &&
        restartFor.missing.mappings.length === 1,
      'choosing "Restart with them" hands the restart offer what is missing',
    );
    await t.throws(() => joinGames('cancel'), 'Cancelled', '"Cancel" stops with a short line');
    t.check(
      !new ProjectRegistry(storage2).read()?.projects.some((p) => p.host === games),
      'neither registers the project',
    );
    t.equal(
      (await joinGames('continue')).missing?.settings,
      ['sandbox.vGpu'],
      '"Continue anyway" joins without them and says what is missing',
    );

    // The restart that adds it (and any launch with it mapped at boot) boots with the union.
    const unionGen = generateSandbox({
      packageRoot: t.packageRoot,
      run: launchedRun,
      harnessArgs: [],
      probe: f.probe,
      extraProjects: [games],
      autoSession: false,
      bootWants: { projects: [{ name: 'proj-games', config: gamesRun.config }], keepOff: [] },
    });
    const unionWsb = fs.readFileSync(unionGen.wsbPath, 'utf8');
    t.check(
      unionWsb.includes('<vGPU>Enable</vGPU>') &&
        unionWsb.includes(
          '<HostFolder>' +
            path.join(games, 'assets') +
            '</HostFolder><SandboxFolder>C:\\Mirror\\F\\GameAssets</SandboxFolder><ReadOnly>true</ReadOnly>',
        ) &&
        unionWsb.includes(
          '<HostFolder>' + games + '</HostFolder><SandboxFolder>C:\\Workspace\\proj-games</SandboxFolder>',
        ),
      'the restart plan: vGPU on, and the added project and its mapping are mapped',
    );
    t.check(
      unionGen.widened['sandbox.vGpu'] === 'proj-games' &&
        unionGen.projects.notes.some((n) => n.startsWith('vGPU is on in this sandbox')) &&
        nothingMissing(
          missingAtBoot(
            protectionsOf(unionGen.bootConfig),
            { memoryMb: unionGen.memoryMb, mappings: unionGen.mappings },
            gamesRun.config,
            fs.existsSync,
          ),
        ),
      'the registry learns which setting was turned on for which project; after that restart nothing is missing',
      JSON.stringify(unionGen.projects.notes),
    );
    const keptOff = generateSandbox({
      packageRoot: t.packageRoot,
      run: launchedRun,
      harnessArgs: [],
      probe: f.probe,
      extraProjects: [games],
      autoSession: false,
      bootWants: { projects: [{ name: 'proj-games', config: gamesRun.config }], keepOff: ['sandbox.vGpu'] },
    });
    t.includes(
      fs.readFileSync(keptOff.wsbPath, 'utf8'),
      '<vGPU>Disable</vGPU>',
      "a device the launch folder's own file switched off stays off",
    );

    t.section('projects: wsb (Windows Sandbox command line) adapter');
    const id = '12345678-1234-1234-1234-1234567890ab';
    t.check(
      parseVersion('Windows Sandbox CLI version 0.4.1.0\n') === '0.4.1.0' &&
        parseVersion('nothing') === null &&
        parseIp('172.20.1.5\r\n') === '172.20.1.5' &&
        parseIp('none') === null &&
        parseCommands('Commands:\n  start    Starts a sandbox\n  list     Lists\n  share    Shares\n').join() ===
          'start,list,share' &&
        parseCommands('no commands here').length === 0,
      'wsb --version, ip and --help are read; other text gives nothing',
    );
    t.check(
      parseList(JSON.stringify([{ Id: id, Status: 'Running', Uptime: '00:10' }]))[0]?.id === id &&
        parseList(JSON.stringify({ WindowsSandboxEnvironments: [{ id, status: 'Stopped' }] }))[0]?.status ===
          'Stopped' &&
        parseList('Id                                    Status   Uptime\n' + id + '  Running  00:01:02\n')[0]
          ?.status === 'Running' &&
        parseList('nothing').length === 0,
      'wsb list is read as an array, an object or a table',
    );
    const apps = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wsb.exe';
    t.check(
      findWsb({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', SystemRoot: 'C:\\Windows' }, (p) => p === apps) ===
        apps && findWsb({ SystemRoot: 'C:\\Windows' }, () => false) === null,
      'wsb.exe is looked for at absolute paths only',
    );
  },
};
