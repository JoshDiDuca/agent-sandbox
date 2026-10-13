// Several projects in one sandbox: guest paths, the safety of what gets mapped, joining a running sandbox (roots,
// wsb share, the restart fallback), the project spec sent to the guest, tighten-only protections, the per-project
// environment, history sync and the repo guard for every project. Offline: temp folders only.
import fs from 'node:fs';
import path from 'node:path';
import type { ResolvedRun, SessionStatus } from '../core/types.js';
import { LocalOverrides } from '../core/schema.js';
import { checkJoin, describeMissing, missingAtBoot, missingTip, nothingMissing, protectionsOf } from '../core/project-policy.js';
import { allowStorePath, saveAllowed } from '../core/local-config.js';
import { sessionsFirstIn } from '../host/channel.js';
import { buildWsb } from '../host/launch/wsb.js';
import { projectSpec, joinRunning } from '../host/join.js';
import { allProjectsToMap, forgetProject, NeedsRestart, parseWsbBoot, projectHere, projectMapper, readKnown, readRegistry, rememberProject, startRegistry } from '../host/projects.js';
import { checkRepo, saveRepoSnapshot } from '../host/repo-guard.js';
import { findWsb, parseCommands, parseIp, parseList, parseVersion, type Wsb } from '../host/wsb.js';
import { baseEnvFor } from '../guest/project-env.js';
import { guestDirFor, hostDirFor, hubName, insideProjects, isBelow, isWithin, planProjectMappings, projectForGuestDir, projectForHostDir, PROJECTS_GUEST, rootGuestDir } from '../shared/projects.js';
import { GuestRequest, ProjectSpec } from '../shared/schema.js';
import { projectFolderName } from '../shared/paths.js';
import { syncHistoryOut } from '../sync/history.js';
import { validateOptions, validateProjectsArgs } from '../cli/validate.js';
import { parseCli, parseSessionWant } from '../cli/args.js';
import { candidateFolders, severalAgentsArgv } from '../cli/menu/index.js';
import type { Context } from '../cli/commands/context.js';
import { generateSandbox } from '../host/generate.js';
import { askedWhen } from '../cli/manifest.js';
import { describeSessions } from '../cli/commands/restart.js';
import type { Suite } from './suite.js';

/** The error `fn` throws, or null. */
const caught = (fn: () => unknown): unknown => { try { fn(); return null; } catch (e) { return e; } };

export const projectsSuite: Suite = {
  name: 'projects',
  title: 'several projects in one sandbox (paths, joining, policy, specs, --session)',
  run: async (t, f) => {
    t.section('projects: guest paths');
    t.check(isWithin('C:\\code\\a', 'c:\\CODE\\a\\src') && isWithin('C:\\code\\a\\', 'C:\\code\\a'), 'isWithin: case-insensitive, trailing slashes ignored');
    t.check(!isWithin('C:\\code\\a', 'C:\\code\\ab') && !isWithin('C:\\code\\a', 'C:\\code'), 'isWithin: no prefix matches (a vs ab) and no parents');
    t.equal(hubName('F:\\Code\\my app (v2)', []), 'my-app-v2', 'project ids are file-name safe');
    t.equal(hubName('F:\\Code\\api', ['API', 'api-2']), 'api-3', 'project ids are unique (case-insensitive)');
    t.equal(hubName('F:\\Code\\...', []), 'project', 'project ids are never empty');
    t.equal(hubName('F:\\' + 'x'.repeat(80), []).length, 48, 'project ids are capped at 48 characters');
    const projects = [{ host: 'F:\\Code', guest: 'C:\\Projects\\Code' }, { host: 'F:\\Code\\api', guest: 'C:\\Projects\\api' }];
    t.equal(projectForHostDir(projects, 'f:\\code\\api\\src')?.guest, 'C:\\Projects\\api', 'the most specific mapped folder wins');
    t.equal(projectForHostDir(projects, 'F:\\Code\\web')?.guest, 'C:\\Projects\\Code', 'a folder inside a mapped folder belongs to it');
    t.equal(projectForHostDir(projects, 'F:\\Other'), null, 'unrelated folders belong to no project');
    t.equal(projectForGuestDir(projects, 'C:\\Projects\\api\\x')?.host, 'F:\\Code\\api', 'the same works from inside the sandbox');
    const mapped = { host: 'F:\\Code', guest: 'C:\\Projects\\Code' };
    const webGuest = guestDirFor(mapped, 'F:\\Code\\web\\src');
    t.equal(webGuest, 'C:\\Projects\\Code\\web\\src', 'host folder -> guest folder');
    t.equal(hostDirFor(mapped, webGuest), 'F:\\Code\\web\\src', 'guest folder -> host folder (round trip)');
    t.equal(guestDirFor(mapped, 'F:\\Code'), 'C:\\Projects\\Code', 'the mapped folder itself translates');
    t.check(insideProjects('C:\\Projects\\api') && insideProjects('c:\\projects\\api\\src'), 'C:\\Projects\\<name> holds projects');
    t.check(!insideProjects('C:\\Projects') && !insideProjects('C:\\ProjectsX\\a') && !insideProjects('C:\\Windows'), 'C:\\Projects itself and look-alikes do not');
    t.check(insideProjects('F:\\Code\\web', ['F:\\Code']) && !insideProjects('F:\\Other', ['F:\\Code']), 'a mirrored root counts too');
    t.check(isBelow('C:\\a', 'C:\\a\\b') && !isBelow('C:\\a', 'C:\\a'), 'isBelow is strict');
    const plan = planProjectMappings(['F:\\Code', 'E:\\Work\\Code', 'C:\\Users\\me\\src'], ['D:\\x\\api', 'D:\\y\\api'], false);
    t.equal(plan.roots.map((r) => r.guest), ['C:\\Projects\\Code', 'C:\\Projects\\Code-2', 'C:\\Projects\\src'], 'roots get unique C:\\Projects\\<name> folders');
    t.equal(plan.projects.map((p) => p.guest), ['C:\\Workspace\\api', 'C:\\Workspace\\api-2'], 'projects mapped on their own get unique C:\\Workspace\\<name> folders (where they are as the launch folder)');
    t.equal(planProjectMappings([], ['D:\\x\\app'], false, ['C:\\Workspace\\app']).projects[0].guest, 'C:\\Workspace\\app-2', 'a project mapped on its own never lands on the launch folder\'s place');
    t.equal(planProjectMappings(['F:\\Code'], ['D:\\x\\api'], true).projects[0].guest, 'D:\\x\\api', 'with "mirror" a project mapped on its own appears at its PC path, as it would as the launch folder');
    t.equal(rootGuestDir(['F:\\Code'], false, 'F:\\Code\\web\\src'), 'C:\\Projects\\Code\\web\\src', 'a folder inside a root is placed under the root\'s guest folder');
    t.equal(rootGuestDir(['F:\\Code'], false, 'F:\\Other'), null, 'a folder in no root has no root place');
    const mirror = planProjectMappings(['F:\\Code', 'C:\\Users\\me\\src'], [], true);
    t.equal(mirror.roots.map((r) => r.guest), ['F:\\Code', 'C:\\Projects\\src'], 'with "mirror" a root appears at its PC path when the sandbox can show it there (C:\\Users\\... cannot)');

    t.section('projects: tighten-only protections when joining a running sandbox');
    const base = protectionsOf(f.baseConfig);
    const same = checkJoin(base, base);
    t.equal({ stricter: same.stricter, looser: same.looser }, { stricter: [], looser: [] }, 'the same settings join without notes');
    const readonlyGit = protectionsOf({ ...f.baseConfig, provisioning: { ...f.baseConfig.provisioning, git: { ...f.baseConfig.provisioning.git, access: 'readonly' } } });
    t.check(checkJoin(base, readonlyGit).stricter.some((s) => s.startsWith('provisioning.git.access')), 'a project needing stricter git access than the running sandbox is refused (git access is machine-wide)');
    const loosening = checkJoin(readonlyGit, base);
    t.equal(loosening.stricter.length, 0, 'a project asking for less git access is not refused...');
    t.check(loosening.looser.some((s) => s.includes('provisioning.git.access stays "readonly"')), '... it gets the sandbox\'s stricter value, with a note: never loosened', JSON.stringify(loosening.looser));
    const offline = protectionsOf({ ...f.baseConfig, sandbox: { ...f.baseConfig.sandbox, networking: false } });
    t.check(checkJoin(base, offline).stricter.some((s) => s.startsWith('sandbox.networking')), 'networking off is stricter than a sandbox with networking');
    t.check(checkJoin(offline, base).looser.some((s) => s.startsWith('sandbox.networking')), 'networking on is looser than an offline sandbox');
    const readOnly = protectionsOf({ ...f.baseConfig, readOnly: true });
    t.check(checkJoin(readOnly, readOnly).stricter.some((s) => s.startsWith('readOnly')), 'a read-only project cannot join (other projects are mapped read/write), even when the launch folder was read-only');
    t.check(!LocalOverrides.safeParse({ projects: { roots: ['C:\\'] } }).success, 'a project\'s .sandbox-config.json can never set projects.roots (they map folders of this PC)');
    t.check(!LocalOverrides.safeParse({ projects: { all: true } }).success, 'a project\'s .sandbox-config.json can never set projects.all');

    // A project file that loosens git access is clamped by keepStrictest first, then joins without being refused.
    const strictUser = structuredClone(f.baseConfig);
    strictUser.provisioning.git.access = 'readonly';
    const looseDir = t.dir('proj-loose');
    f.writeLocal(looseDir, { provisioning: { git: { access: 'full' } } });
    const loose = await f.run({ cwd: looseDir, trustConfig: true }, strictUser);
    t.equal(loose.config.provisioning.git.access, 'readonly', 'tighten-only: a project file cannot loosen git access');
    t.equal(checkJoin(protectionsOf(strictUser), protectionsOf(loose.config)).stricter, [], 'tighten-only: so it joins a readonly sandbox as readonly');
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
    const primary = startRegistry(storage, { launchId: '1700000000000-abcdef', protections: base, primary: { host: f.workA, guest: 'C:\\Workspace\\work-a' }, roots: [{ host: root, guest: 'C:\\Projects\\proj-root' }], boot: [{ host: f.workB, guest: 'C:\\Projects\\work-b' }] });
    const registry = readRegistry(storage);
    t.check(primary.primary, 'at launch the launch folder is the primary project');
    t.equal(registry?.projects.length, 2, 'at launch the registry holds the launch folder and the projects mapped with it');
    t.equal({ mechanism: registry?.projects[1].mechanism, name: registry?.projects[1].name }, { mechanism: 'boot', name: 'work-b' }, 'a project mapped at boot is registered by its mechanism and name');
    t.equal(projectHere(storage, path.join(f.workA, 'src'))?.guestDir, 'C:\\Workspace\\work-a\\src', 'projectHere: a folder inside the launch folder');
    t.equal(projectHere(storage, f.workB)?.project.mechanism, 'boot', 'projectHere: a project mapped at boot');
    t.equal(projectHere(storage, outside), null, 'projectHere: a folder in no project');
    const noWsb = projectMapper({ storageRoot: storage, packageRoot: f.install, wsbShare: true, detect: () => null });
    const web = noWsb.register(inRoot);
    t.equal({ mechanism: web.mechanism, guest: web.guest }, { mechanism: 'root', guest: 'C:\\Projects\\proj-root\\web' }, 'a folder inside a root joins at once (also one created after boot)');
    t.equal(noWsb.register(inRoot).name, web.name, 'registering the same folder again gives the same project');
    t.equal(readRegistry(storage)?.projects.filter((p) => p.host === inRoot).length, 1, 'a folder is registered once');
    const needs = caught(() => noWsb.register(outside));
    t.check(needs instanceof NeedsRestart && needs.reason.includes('wsb share needs Windows 11 24H2'), 'a folder outside every root without the Windows Sandbox CLI needs a restart (and says why)');
    const shareOff = caught(() => projectMapper({ storageRoot: storage, packageRoot: f.install, wsbShare: false }).register(outside));
    t.check(shareOff instanceof NeedsRestart && shareOff.reason.includes('projects.wsbShare'), 'projects.wsbShare off goes straight to the restart offer');
    const fakeWsb: Wsb = { exe: t.at('no-such-wsb.exe'), version: '0.1.0', commands: ['share', 'list'], has: (c) => c === 'share' || c === 'list' };
    const listFails = caught(() => projectMapper({ storageRoot: storage, packageRoot: f.install, wsbShare: true, detect: () => fakeWsb }).register(outside));
    t.check(listFails instanceof NeedsRestart && listFails.reason.includes('wsb share could not find the running sandbox'), 'when wsb cannot tell which sandbox is ours, it falls back to the restart offer with the reason');
    await t.throws(() => noWsb.register(storage), 'cannot be the workspace', 'joining uses the launch-folder safety checks: not the storage folder');
    await t.throws(() => noWsb.register('C:\\'), 'whole drive', 'joining uses the launch-folder safety checks: not a drive root');
    await t.throws(() => noWsb.unregister(primary.name), 'stays until the sandbox stops', 'the launch folder cannot be removed from a running sandbox');

    // joinRunning: resolves the folder, checks protections, registers it, guards it, and builds the spec for the guest.
    const resolveFor = (run: ResolvedRun) => async (): Promise<ResolvedRun> => run;
    const join = (hostDir: string, resolve: () => Promise<ResolvedRun>) => joinRunning({ storageRoot: storage, dataPath: data, packageRoot: f.install, hostDir, wsbShare: false, resolve });
    const webRun = await f.run({ cwd: inRoot, trustConfig: true });
    const joined = await join(inRoot, resolveFor(webRun));
    t.equal(joined.spec?.workspace, 'C:\\Projects\\proj-root\\web', 'joining a project builds a spec with its guest folder...');
    t.check(ProjectSpec.safeParse(joined.spec).success && joined.spec?.harnesses.claude !== undefined, '... that is valid and carries the agent');
    t.check(readKnown(storage).some((k) => k.host === inRoot), 'joined projects are remembered (projects.all, sandbox projects)');
    const launchFolder = await join(path.join(f.workA, 'sub'), () => Promise.reject(new Error('must not resolve')));
    t.equal(launchFolder.spec, null, 'the launch folder (and below) needs no spec: its sessions use the boot environment');
    await t.throws(() => join(tightDir, resolveFor(tight)), 'stricter protection than the running sandbox', 'a project whose .sandbox-config.json tightens git access beyond the running sandbox is refused, with the reason');
    t.check(readRegistry(storage)?.projects.every((p) => p.host !== tightDir) === true, 'a refused project is not registered');
    const outsideRun = await f.run({ cwd: outside });
    await t.throws(() => join(outside, resolveFor(outsideRun)), 'projects.wsbShare', 'a folder that cannot be shown lets NeedsRestart reach the caller');

    t.section('projects: the spec and request the guest gets');
    const spec = projectSpec(webRun, web, false);
    const sessionRequest = (extra: Record<string, unknown>) => GuestRequest.safeParse({ kind: 'session', id: 'r1', harness: 'claude', args: [], cwd: spec.workspace, createdAt: new Date().toISOString(), ...extra });
    t.check(sessionRequest({ project: spec }).success, 'a session request carries a project spec');
    t.check(sessionRequest({ project: spec, harnessSpec: f.baseConfig.harnesses.codex }).success, 'a session request carries an agent definition');
    t.check(!sessionRequest({ project: { ...spec, name: '..\\evil' } }).success, 'specs are validated: project ids are file-name safe');
    t.check(!sessionRequest({ project: { ...spec, extra: 1 } }).success, 'specs are validated: no unknown keys');
    const manyDatabases = Array(9).fill(spec.databases[0] ?? { database: 'redis', reasons: [], version: 'x', port: 6379 });
    t.check(!sessionRequest({ project: { ...spec, databases: manyDatabases } }).success, 'specs are validated: lists are capped');
    const manyAgents = Object.fromEntries(Array.from({ length: 9 }, (_, i) => ['a' + i, f.baseConfig.harnesses.codex]));
    t.check(!sessionRequest({ project: { ...spec, harnesses: manyAgents } }).success, 'at most 8 agent definitions in one spec');
    t.check(GuestRequest.safeParse({ kind: 'project', id: 'p1', project: spec, createdAt: 'x' }).success, '"project" requests (set up without an agent) carry a spec');
    t.check(!GuestRequest.safeParse({ kind: 'project', id: 'p1', createdAt: 'x' }).success, '"project" requests need a spec');
    t.check(GuestRequest.safeParse({ kind: 'restart', id: 'x', harness: null, cwd: 'C:\\Projects\\a', createdAt: 'x' }).success, 'restart can be scoped to one project\'s folder');
    t.check(GuestRequest.safeParse({ kind: 'restart', id: 'x', harness: null, createdAt: 'x' }).success, 'restart still works without a folder');

    t.section('projects: which projects are mapped at boot');
    const toMap = allProjectsToMap(['C:\\a', 'C:\\a\\b', 'C:\\work-a\\x', 'C:\\r\\p', 'C:\\ex\\y', 'C:\\gone'], { primary: 'C:\\work-a', roots: ['C:\\r'], exclude: ['C:\\ex'], exists: (p) => p !== 'C:\\gone' });
    t.equal(toMap, ['C:\\a'], 'projects.all: known projects except excluded, missing, nested, the launch folder\'s and the roots\'');
    const rootConfig = structuredClone(f.baseConfig);
    rootConfig.projects = { ...rootConfig.projects, roots: [root, t.at('no-such-root')], all: true };
    rememberProject(f.baseConfig.storage.root, outside);
    const gen = f.generate(await f.run({}, rootConfig));
    const session = f.readJson(gen.sessionPath);
    const wsb = fs.readFileSync(gen.wsbPath, 'utf8');
    t.equal(gen.projects.roots.map((r) => r.guest), ['C:\\Projects\\proj-root'], 'roots are mapped as C:\\Projects\\<name>');
    t.check(gen.projects.notes.some((n) => n.includes('no-such-root')), 'a missing root is skipped with a note', JSON.stringify(gen.projects.notes));
    t.check(gen.projects.projects.some((p) => p.host === outside), 'projects.all maps the known projects too');
    t.includes(wsb, '<HostFolder>' + root + '</HostFolder><SandboxFolder>C:\\Projects\\proj-root</SandboxFolder><ReadOnly>false</ReadOnly>', 'roots are mapped read/write in the .wsb');
    t.equal({ projectsDir: session.projectsDir, roots: session.roots, projectId: session.projectId }, { projectsDir: PROJECTS_GUEST, roots: ['C:\\Projects\\proj-root', 'C:\\Workspace\\proj-outside'], projectId: 'work-a' }, 'session.json tells the guest where other projects can be');
    // The same project is at the same place whether it started the sandbox or joined one another project started.
    const fromRoot = f.generate(await f.run({ cwd: inRoot }, rootConfig));
    const joinedAt = guestDirFor(gen.projects.roots[0], inRoot);
    t.equal([f.readJson(fromRoot.sessionPath).workspace, joinedAt], ['C:\\Projects\\proj-root\\web', 'C:\\Projects\\proj-root\\web'], 'a project in a root: the same guest folder as the launch folder and when another project started the sandbox');
    t.check(!fromRoot.mappings.some((m) => m.host.toLowerCase() === inRoot.toLowerCase()), 'a launch folder inside a root is shown by the root (no second mapping of it)');
    t.includes(fs.readFileSync(path.join(fromRoot.launchPath, 'env.cmd'), 'utf8'), 'AGENT_WORKSPACE=C:\\Projects\\proj-root\\web', 'env.cmd: AGENT_WORKSPACE follows');
    const asLaunch = f.readJson(f.generate(await f.run({ cwd: outside })).sessionPath).workspace;
    t.equal([asLaunch, gen.projects.projects.find((p) => p.host === outside)?.guest], ['C:\\Workspace\\proj-outside', 'C:\\Workspace\\proj-outside'], 'a project outside the roots: the same guest folder as the launch folder and when mapped at boot by another');
    const mirrorRoot = structuredClone(rootConfig);
    mirrorRoot.guestWorkspace = 'mirror';
    t.equal(f.readJson(f.generate(await f.run({ cwd: inRoot }, mirrorRoot)).sessionPath).workspace, rootGuestDir([root], true, inRoot), 'with "mirror" a launch folder inside a root is where the root shows it (no overlapping mappings)');
    const filtered = structuredClone(rootConfig);
    filtered.workspaceFilter = { ...filtered.workspaceFilter, enabled: true };
    const filteredRun = await f.run({ cwd: inRoot }, filtered);
    t.equal(filteredRun.config.guestWorkspace, 'C:\\Workspace\\web', 'workspaceFilter: a launch folder inside a root keeps its own (filtered) mapping');
    t.check(filteredRun.notes.some((n) => n.includes('C:\\Projects\\proj-root\\web')), 'and a note says where it is when another project starts the sandbox', JSON.stringify(filteredRun.notes));
    const badRoot = structuredClone(f.baseConfig);
    badRoot.projects = { ...badRoot.projects, roots: [f.baseConfig.storage.root] };
    await t.throws(async () => f.generate(await f.run({}, badRoot)), 'projects.roots', 'a root that would expose the storage folder is refused');
    t.check(forgetProject(f.baseConfig.storage.root, outside), '`sandbox projects remove` forgets a project...');
    t.check(!readKnown(f.baseConfig.storage.root).some((k) => k.host === outside), '... so it is no longer known (its folder is untouched)');
    t.includes(buildWsb(f.baseConfig, 4096, []), '<MappedFolders></MappedFolders>', 'no projects: nothing extra mapped');

    t.section('projects: repo guard for every project the sandbox can write');
    const guardData = t.at('guard-data');
    const rootG = t.at('guard-root');
    const old = path.join(rootG, 'old');
    t.write(path.join(old, '.git', 'hooks', 'pre-commit'), 'mine');
    t.write(path.join(old, '.git', 'config'), '[core]\n\tbare = false\n');
    saveRepoSnapshot(guardData, f.workA, [], [rootG]);
    t.write(path.join(old, '.git', 'hooks', 'post-checkout'), 'planted');
    const fresh = path.join(rootG, 'created-later');
    t.write(path.join(fresh, '.git', 'hooks', 'pre-push'), 'planted');
    t.write(path.join(fresh, '.git', 'config'), '[core]\n\tfsmonitor = evil.exe\n\tbare = false\n');
    t.write(path.join(fresh, 'node.exe'), 'planted');
    const found = checkRepo(guardData);
    t.check(fs.existsSync(path.join(old, '.git', 'hooks', 'pre-commit')), 'a hook that was there before the sandbox ran stays');
    t.check(!fs.existsSync(path.join(old, '.git', 'hooks', 'post-checkout')), 'a hook added inside the sandbox to a project in a root is quarantined');
    t.check(!fs.existsSync(path.join(fresh, '.git', 'hooks', 'pre-push')), 'a project that appeared in a root after the start has its planted hooks removed');
    t.check(!fs.existsSync(path.join(fresh, 'node.exe')), 'a project that appeared in a root after the start has its planted commands removed');
    t.includes(fs.readFileSync(path.join(fresh, '.git', 'config'), 'utf8'), '# [agent-sandbox] disabled', 'a project that appeared in a root after the start has its program-running git config disabled');
    t.check(found.some((x) => x.detail.startsWith(fresh)), 'the findings name the project', JSON.stringify(found));

    t.section('projects: history and environment');
    const hostClaude = t.at('hist-host');
    const guestClaude = t.at('hist-guest');
    const bHost = t.at('hist-b');
    t.write(path.join(guestClaude, 'projects', projectFolderName('C:\\Projects\\hist-b'), 's.jsonl'), JSON.stringify({ cwd: 'C:\\Projects\\hist-b\\src' }) + '\n');
    syncHistoryOut({ hostClaudeDir: hostClaude, guestClaudeDir: guestClaude, hostWorkspace: f.workA, guestWorkspace: 'C:\\Workspace\\work-a', extra: [{ hostWorkspace: bHost, guestWorkspace: 'C:\\Projects\\hist-b' }] });
    const back = path.join(hostClaude, 'projects', projectFolderName(bHost), 's.jsonl');
    t.check(fs.existsSync(back), 'a joined project\'s history goes back to ITS folder on this PC');
    t.includes(fs.existsSync(back) ? fs.readFileSync(back, 'utf8') : '', JSON.stringify(bHost + '\\src').slice(1, -1), 'a joined project\'s history paths are translated');
    const env = baseEnvFor({ basePath: 'C:\\Windows', toolVars: ['NVM_HOME', 'CARGO_HOME'], steps: {}, summary: [], lan: 'blocked' }, { Path: 'C:\\tools\\a;C:\\Windows', NVM_HOME: 'x', CARGO_HOME: 'y', CARGO_TARGET_DIR: 'C:\\Workspace\\a\\target', AGENT_WORKSPACE: 'C:\\Workspace\\a', TEMP: 'C:\\t' });
    t.equal(
      { PATH: env.PATH, Path: env.Path, NVM_HOME: env.NVM_HOME, CARGO_TARGET_DIR: env.CARGO_TARGET_DIR, AGENT_WORKSPACE: env.AGENT_WORKSPACE, TEMP: env.TEMP },
      { PATH: 'C:\\Windows', Path: undefined, NVM_HOME: undefined, CARGO_TARGET_DIR: undefined, AGENT_WORKSPACE: undefined, TEMP: 'C:\\t' },
      'a joined project starts from the boot\'s base environment: none of the first project\'s tools, workspace or target folder',
    );

    t.section('projects: commands');
    const status = (id: string, cwd: string, startedAt: string): SessionStatus => ({ id, launchId: 'l', harness: 'claude', cwd, phase: 'running', message: '', updatedAt: startedAt, startedAt });
    const sessions = [status('a1', 'C:\\Workspace\\a', '1'), status('b1', 'C:\\Projects\\b', '2'), status('a2', 'C:\\Workspace\\a\\x', '3'), status('b2', 'C:\\Projects\\b\\y', '4')];
    t.equal(sessionsFirstIn(sessions, 'C:\\Projects\\b').map((x) => x.id), ['b2', 'b1', 'a2', 'a1'], 'attach and sessions put this project\'s sessions first, newest first');
    t.equal(describeSessions([{ harness: 'claude', cwd: 'C:\\Workspace\\api', project: 'api' }, { harness: 'codex', cwd: 'C:\\Projects\\web' }]), '2 sessions (claude in api, codex in web)', 'the restart offer lists the sessions that would end');
    await t.throws(() => validateProjectsArgs(['bogus']), 'projects action', '`sandbox projects` rejects an unknown action');
    await t.throws(() => validateProjectsArgs(['add']), 'Which folder', '`sandbox projects add` needs a folder');
    await t.throws(() => validateProjectsArgs(['all', 'maybe']), 'on', '`sandbox projects all` needs on or off');
    await t.throws(() => validateProjectsArgs(['roots', 'add']), 'Which folder', '`sandbox projects roots add` needs a folder');
    validateProjectsArgs([]); validateProjectsArgs(['roots']); validateProjectsArgs(['all', 'on']);
    t.check(askedWhen(['add', 'remove'], 'add') && !askedWhen(['add'], 'list') && askedWhen(undefined, 'x') && askedWhen('save', 'save'), 'the menu asks an argument only for the actions it belongs to');

    t.section('projects: several sessions at once (--session agent@folder)');
    const want = parseSessionWant('claude@C:\\code\\a@b', 'C:\\here');
    t.equal({ harness: want.harness, folder: want.folder }, { harness: 'claude', folder: 'C:\\code\\a@b' }, '--session: the first @ splits agent from folder');
    t.equal(parseSessionWant('codex', 'C:\\here').folder, 'C:\\here', '--session: no folder means this one');
    t.equal(parseSessionWant('gemini@sub', 'C:\\here').folder, 'C:\\here\\sub', '--session: relative folders become absolute');
    await t.throws(() => parseSessionWant('@C:\\x'), 'names no agent', '--session without an agent is refused');
    const own = parseSessionWant('codex@C:\\code\\web|--model o3 "two words"', 'C:\\here');
    t.equal({ harness: own.harness, folder: own.folder, args: own.args }, { harness: 'codex', folder: 'C:\\code\\web', args: ['--model', 'o3', 'two words'] }, '--session: after | come that agent\'s own arguments (quotes keep words together)');
    t.equal(parseSessionWant('claude@C:\\x').args, undefined, '--session: no | means no own arguments');
    const both = parseCli(['launch', '--session', 'claude@C:\\a|--continue', '--session', 'codex@C:\\b', '--', '--verbose']);
    t.equal(both.passthrough, ['--verbose'], 'arguments after -- go to every session...');
    t.equal(both.sessions.map((s) => s.args ?? []), [['--continue'], []], '... arguments after | only to that one');
    const multi = parseCli(['launch', '--session', 'claude@' + f.workA, '--session', 'codex@' + f.workB, '--session', 'claude@' + f.workB, '-t', '--', '--continue']);
    t.equal({ command: multi.command, sessions: multi.sessions.length, terminal: multi.terminal, second: multi.sessions[1].harness, passthrough: multi.passthrough }, { command: 'launch', sessions: 3, terminal: true, second: 'codex', passthrough: ['--continue'] }, 'several --session options parse in order, with -t and agent arguments');
    const validationContext = (options: ReturnType<typeof parseCli>) => ({ packageRoot: f.install, entry: '', options, loaded: { config: f.baseConfig, configPath: null, base: t.temp }, storageRoot: f.baseConfig.storage.root, dataPath: t.at('vdata') }) as Context;
    await t.throws(() => validateOptions(validationContext(parseCli(['launch', '--session', 'claud@' + f.workA]))), 'Did you mean', 'an unknown agent in --session suggests the closest one');
    await t.throws(() => validateOptions(validationContext(parseCli(['launch', '--session', 'claude@' + t.at('nope')]))), 'does not exist', 'a missing --session folder is refused before anything starts');
    await t.throws(() => validateOptions(validationContext(parseCli(['launch', '--session', 'claude@' + f.workA, '--harness', 'codex']))), 'do not apply', '--session cannot be mixed with --harness/--workspace');
    validateOptions(validationContext(multi));
    t.equal(severalAgentsArgv([{ harness: 'claude', folder: 'C:\\a' }, { harness: 'codex', folder: 'C:\\b c' }], { headless: true, attachFirst: true }).join(' '), 'launch --session claude@C:\\a --session codex@C:\\b c --headless -t', 'the menu builds the same command line (so repeat-last works)');
    t.equal(candidateFolders(validationContext(parseCli(['launch'])), f.workA)[0], path.resolve(f.workA), 'the menu offers this folder first, then known projects and the folders in your roots');
    const multiGen = generateSandbox({ packageRoot: t.packageRoot, run: await f.run(), harnessArgs: [], probe: f.probe, extraProjects: [f.workB, path.join(f.workA, 'sub'), f.workB], autoSession: false });
    const multiSession = f.readJson(multiGen.sessionPath);
    const multiWsb = fs.readFileSync(multiGen.wsbPath, 'utf8');
    t.equal(multiGen.projects.projects.map((p) => p.guest), ['C:\\Workspace\\work-b'], 'a multi-project launch maps every other project once (folders inside the launch folder and duplicates need nothing)');
    t.includes(multiWsb, '<HostFolder>' + f.workB + '</HostFolder><SandboxFolder>C:\\Workspace\\work-b</SandboxFolder>', 'a multi-project launch maps the other project in the .wsb');
    t.equal({ autoSession: multiSession.autoSession, workspaceHost: multiSession.workspaceHost }, { autoSession: false, workspaceHost: f.workA }, 'the boot provisions the launch folder only; the host then opens every session (each project set up on demand, in parallel)');

    t.section('projects: what a joining project wants at boot (vGPU, memory, its mappings)');
    // A games project: its approved file asks for vGPU (you allowed it for this project) and maps a folder of its own.
    const games = t.dir('proj-games');
    t.dir('proj-games', 'assets');
    f.writeLocal(games, { sandbox: { vGpu: true }, mappings: [{ host: 'assets', guest: 'F:\\GameAssets', readOnly: true }] });
    saveAllowed(allowStorePath(f.baseConfig.storage.root), path.join(games, '.sandbox-config.json'), 'sandbox.vGpu', true, true);
    const gamesRun = await f.run({ cwd: games, trustConfig: true });
    t.equal(gamesRun.config.sandbox.vGpu, true, 'the vGPU you allowed for the project is in its effective config');
    const launchedRun = await f.run();
    const runningBoot = { memoryMb: 8192, mappings: [{ host: f.workA, guest: 'C:\\Workspace\\work-a', readOnly: false }] };
    const wanted = missingAtBoot(protectionsOf(launchedRun.config), runningBoot, gamesRun.config, fs.existsSync);
    t.equal({ settings: wanted.settings, memoryMb: wanted.memoryMb, mappings: wanted.mappings.map((m) => m.guest) }, { settings: ['sandbox.vGpu'], memoryMb: null, mappings: ['F:\\GameAssets'] }, 'missingAtBoot: vGPU and the project\'s folder are missing from a sandbox started without them (the missing optional mapping is no wish)');
    const mappedMirror = missingAtBoot(protectionsOf(gamesRun.config), { memoryMb: 8192, mappings: [{ host: path.join(games, 'assets'), guest: 'C:\\Mirror\\F\\GameAssets', readOnly: true }] }, gamesRun.config, fs.existsSync);
    t.check(nothingMissing(mappedMirror), 'missingAtBoot: nothing missing when the sandbox has vGPU and the folder (F:\\x is C:\\Mirror\\F\\x in the .wsb)', JSON.stringify(mappedMirror));
    const bigger = structuredClone(launchedRun.config);
    bigger.sandbox.memoryMb = 16384;
    t.equal(missingAtBoot(protectionsOf(launchedRun.config), runningBoot, bigger).memoryMb, 16384, 'missingAtBoot: a larger fixed memory size is missing too');
    const twoFolders = { settings: ['sandbox.vGpu'], memoryMb: null, mappings: [{ host: 'C:\\Steam\\common', guest: 'C:\\Steam', readOnly: true }, { host: 'F:\\SteamLibrary', guest: 'F:\\SteamLibrary', readOnly: true }] };
    t.equal(describeMissing('mw2-agent', twoFolders), 'mw2-agent wants vGPU and 2 folders (C:\\Steam\\common, F:\\SteamLibrary), but this sandbox started without them.', 'the message names each missing item');
    t.equal(missingTip(twoFolders), 'Set sandbox.vGpu (or the mappings) in your own settings to have them in every sandbox.', 'the tip names the settings');
    t.equal(describeMissing('api', { settings: ['sandbox.vGpu'], memoryMb: null, mappings: [] }), 'api wants vGPU, but this sandbox started without it.', 'one item reads naturally');
    t.equal(parseWsbBoot(buildWsb(f.baseConfig, 6144, [{ host: 'C:\\a&b', guest: 'F:\\x', readOnly: true }])), { memoryMb: 6144, mappings: [{ host: 'C:\\a&b', guest: 'C:\\Mirror\\F\\x', readOnly: true }], widened: {} }, 'a sandbox started by an older version: memory and mapped folders are read back from its .wsb');
    const widenedJoin = checkJoin({ ...base, 'sandbox.vGpu': true }, base, ['sandbox.vGpu']);
    t.equal({ stricter: widenedJoin.stricter, shared: widenedJoin.shared }, { stricter: [], shared: ['sandbox.vGpu'] }, 'vGPU turned on at boot for another project you allowed it for: a project without it shares it instead of being refused');
    t.check(checkJoin({ ...base, 'sandbox.vGpu': true }, base).stricter.some((s) => s.startsWith('sandbox.vGpu')), '... without that record a project without vGPU is still refused (it needs it off)');

    // joinRunning asks before anything is registered: restart (NeedsRestart with what is missing), or continue without.
    const storage2 = t.dir('proj-storage2');
    const data2 = t.dir('proj-storage2', 'data', 'testdata');
    startRegistry(storage2, { launchId: '1700000000001-abcdef', protections: protectionsOf(launchedRun.config), primary: { host: f.workA, guest: 'C:\\Workspace\\work-a' }, roots: [{ host: path.dirname(games), guest: 'C:\\Projects\\temp' }], boot: [], atBoot: { ...runningBoot, widened: {} } });
    const joinGames = (choice: 'continue' | 'restart' | 'cancel') => joinRunning({ storageRoot: storage2, dataPath: data2, packageRoot: f.install, hostDir: games, wsbShare: false, resolve: resolveFor(gamesRun), decide: async () => choice });
    const restartFor = await joinGames('restart').then(() => null, (e: unknown) => e);
    t.check(restartFor instanceof NeedsRestart && restartFor.missing?.settings.includes('sandbox.vGpu') === true && restartFor.missing.mappings.length === 1, 'choosing "Restart with them" hands the restart offer what is missing');
    await t.throws(() => joinGames('cancel'), 'Cancelled', '"Cancel" stops with a short line');
    t.check(!readRegistry(storage2)?.projects.some((p) => p.host === games), 'neither registers the project');
    const continued = await joinGames('continue');
    t.equal(continued.missing?.settings, ['sandbox.vGpu'], '"Continue anyway" joins without them and says what is missing');

    // The restart that adds it (and any launch with it mapped at boot) boots with the union.
    const unionGen = generateSandbox({ packageRoot: t.packageRoot, run: launchedRun, harnessArgs: [], probe: f.probe, extraProjects: [games], autoSession: false, bootWants: { projects: [{ name: 'proj-games', config: gamesRun.config }], keepOff: [] } });
    const unionWsb = fs.readFileSync(unionGen.wsbPath, 'utf8');
    t.includes(unionWsb, '<vGPU>Enable</vGPU>', 'the restart plan: vGPU on because the added project asks for it (and you allowed it)');
    t.includes(unionWsb, '<HostFolder>' + path.join(games, 'assets') + '</HostFolder><SandboxFolder>C:\\Mirror\\F\\GameAssets</SandboxFolder><ReadOnly>true</ReadOnly>', 'the restart plan: the added project\'s mapping is mapped');
    t.includes(unionWsb, '<HostFolder>' + games + '</HostFolder><SandboxFolder>C:\\Workspace\\proj-games</SandboxFolder>', 'the restart plan: the added project itself is mapped (where it is as the launch folder)');
    t.equal(unionGen.widened, { 'sandbox.vGpu': 'proj-games' }, 'the registry learns which boot setting was turned on for which project');
    t.check(unionGen.projects.notes.some((n) => n.startsWith('vGPU is on in this sandbox')), 'the launch says vGPU is on for every project and why', JSON.stringify(unionGen.projects.notes));
    t.check(nothingMissing(missingAtBoot(protectionsOf(unionGen.bootConfig), { memoryMb: unionGen.memoryMb, mappings: unionGen.mappings }, gamesRun.config, fs.existsSync)), 'after that restart the project joins with nothing missing');
    const keptOff = generateSandbox({ packageRoot: t.packageRoot, run: launchedRun, harnessArgs: [], probe: f.probe, extraProjects: [games], autoSession: false, bootWants: { projects: [{ name: 'proj-games', config: gamesRun.config }], keepOff: ['sandbox.vGpu'] } });
    t.includes(fs.readFileSync(keptOff.wsbPath, 'utf8'), '<vGPU>Disable</vGPU>', 'a device the launch folder\'s own file switched off stays off');
    t.includes(fs.readFileSync(f.generate(launchedRun).wsbPath, 'utf8'), '<vGPU>Disable</vGPU>', 'without other projects nothing changes');

    t.section('projects: wsb (Windows Sandbox command line) adapter');
    t.equal([parseVersion('Windows Sandbox CLI version 0.4.1.0\n'), parseVersion('nothing')], ['0.4.1.0', null], 'wsb --version');
    const help = 'Description:\n  Windows Sandbox command line\n\nUsage:\n  wsb [command] [options]\n\nOptions:\n  --version  Show version information\n\nCommands:\n  start    Starts a sandbox\n  list     Lists sandboxes\n  exec     Runs a command\n  share    Shares a folder\n  stop     Stops a sandbox\n  connect  Connects\n  ip       Shows the IP\n';
    t.equal(parseCommands(help), ['start', 'list', 'exec', 'share', 'stop', 'connect', 'ip'], 'wsb --help: the subcommands it offers');
    t.equal(parseCommands('no commands here').length, 0, 'wsb --help: no commands in other text');
    const id = '12345678-1234-1234-1234-1234567890ab';
    t.equal(parseList(JSON.stringify([{ Id: id, Status: 'Running', Uptime: '00:10' }]))[0]?.id, id, 'wsb list --raw: an array');
    t.equal(parseList(JSON.stringify({ WindowsSandboxEnvironments: [{ id, status: 'Stopped' }] }))[0]?.status, 'Stopped', 'wsb list --raw: an object holding one');
    t.equal(parseList('Id                                    Status   Uptime\n' + id + '  Running  00:01:02\n')[0]?.status, 'Running', 'wsb list as a table');
    t.equal(parseList('nothing').length, 0, 'wsb list: nothing to read gives no sandboxes');
    t.equal([parseIp('172.20.1.5\r\n'), parseIp('none')], ['172.20.1.5', null], 'wsb ip');
    const apps = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wsb.exe';
    t.equal(findWsb({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', SystemRoot: 'C:\\Windows' }, (p) => p === apps), apps, 'wsb.exe is looked for at absolute paths only (WindowsApps alias, System32)');
    t.equal(findWsb({ SystemRoot: 'C:\\Windows' }, () => false), null, 'wsb.exe is not found when nothing is there');
  },
};
