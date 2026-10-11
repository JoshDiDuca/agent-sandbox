// Several projects in one sandbox: guest paths, the safety of what gets mapped, joining a running sandbox (roots,
// wsb share, the restart fallback), the project spec sent to the guest, tighten-only protections, the per-project
// environment, history sync and the repo guard for every project. Offline: temp folders only.
import fs from 'node:fs';
import path from 'node:path';
import type { ResolvedRun, SessionStatus } from '../core/types.js';
import { LocalOverrides } from '../core/schema.js';
import { checkJoin, protectionsOf } from '../core/project-policy.js';
import { sessionsFirstIn } from '../host/channel.js';
import { buildWsb } from '../host/launch/wsb.js';
import { projectSpec, joinRunning } from '../host/join.js';
import { allProjectsToMap, forgetProject, NeedsRestart, projectHere, projectMapper, readKnown, readRegistry, rememberProject, startRegistry } from '../host/projects.js';
import { checkRepo, saveRepoSnapshot } from '../host/repo-guard.js';
import { findWsb, parseCommands, parseIp, parseList, parseVersion, type Wsb } from '../host/wsb.js';
import { baseEnvFor } from '../guest/project-env.js';
import { guestDirFor, hostDirFor, hubName, insideProjects, isBelow, isWithin, planProjectMappings, projectForGuestDir, projectForHostDir, PROJECTS_GUEST } from '../shared/projects.js';
import { GuestRequest, ProjectSpec } from '../shared/schema.js';
import { projectFolderName } from '../shared/paths.js';
import { syncHistoryOut } from '../sync/history.js';
import { validateOptions, validateProjectsArgs } from '../cli/validate.js';
import { parseCli, parseSessionWant } from '../cli/args.js';
import { candidateFolders, severalAgentsArgv } from '../cli/menu-multi.js';
import type { Context } from '../cli/commands/context.js';
import { generateSandbox } from '../host/generate.js';
import { askedWhen } from '../cli/manifest.js';
import { describeSessions } from '../cli/commands/restart.js';
import type { Fixtures } from './fixtures.js';
import type { Harness } from './harness.js';

export const projectTests = async (t: Harness, f: Fixtures): Promise<void> => {
  const { check, rejects, write } = t;

  t.section('projects: guest paths');
  check(isWithin('C:\\code\\a', 'c:\\CODE\\a\\src') && isWithin('C:\\code\\a\\', 'C:\\code\\a') && !isWithin('C:\\code\\a', 'C:\\code\\ab') && !isWithin('C:\\code\\a', 'C:\\code'), 'isWithin: case-insensitive, trailing slashes ignored, no prefix matches (a vs ab)');
  check(hubName('F:\\Code\\my app (v2)', []) === 'my-app-v2' && hubName('F:\\Code\\api', ['API', 'api-2']) === 'api-3' && hubName('F:\\Code\\...', []) === 'project' && hubName('F:\\' + 'x'.repeat(80), []).length === 48, 'project ids: file-name safe, unique (case-insensitive), never empty, capped');
  const projects = [{ host: 'F:\\Code', guest: 'C:\\Projects\\Code' }, { host: 'F:\\Code\\api', guest: 'C:\\Projects\\api' }];
  check(projectForHostDir(projects, 'f:\\code\\api\\src')?.guest === 'C:\\Projects\\api' && projectForHostDir(projects, 'F:\\Code\\web')?.guest === 'C:\\Projects\\Code' && projectForHostDir(projects, 'F:\\Other') === null, 'the most specific mapped folder wins; unrelated folders belong to none');
  check(projectForGuestDir(projects, 'C:\\Projects\\api\\x')?.host === 'F:\\Code\\api', 'the same works from inside the sandbox');
  const mapped = { host: 'F:\\Code', guest: 'C:\\Projects\\Code' };
  check(guestDirFor(mapped, 'F:\\Code\\web\\src') === 'C:\\Projects\\Code\\web\\src' && hostDirFor(mapped, guestDirFor(mapped, 'F:\\Code\\web\\src')) === 'F:\\Code\\web\\src' && guestDirFor(mapped, 'F:\\Code') === 'C:\\Projects\\Code', 'host <-> guest folder translation round-trips');
  check(insideProjects('C:\\Projects\\api') && insideProjects('c:\\projects\\api\\src') && !insideProjects('C:\\Projects') && !insideProjects('C:\\ProjectsX\\a') && !insideProjects('C:\\Windows'), 'C:\\Projects\\<name> holds projects; C:\\Projects itself and look-alikes do not');
  check(insideProjects('F:\\Code\\web', ['F:\\Code']) && !insideProjects('F:\\Other', ['F:\\Code']) && isBelow('C:\\a', 'C:\\a\\b') && !isBelow('C:\\a', 'C:\\a'), 'a mirrored root counts too');
  const plan = planProjectMappings(['F:\\Code', 'E:\\Work\\Code', 'C:\\Users\\me\\src'], ['D:\\x\\api', 'D:\\y\\api'], false);
  check(JSON.stringify(plan.roots.map((r) => r.guest)) === JSON.stringify(['C:\\Projects\\Code', 'C:\\Projects\\Code-2', 'C:\\Projects\\src']) && JSON.stringify(plan.projects.map((p) => p.guest)) === JSON.stringify(['C:\\Projects\\api', 'C:\\Projects\\api-2']), 'roots and projects get unique C:\\Projects\\<name> folders');
  const mirror = planProjectMappings(['F:\\Code', 'C:\\Users\\me\\src'], [], true);
  check(mirror.roots[0].guest === 'F:\\Code' && mirror.roots[1].guest === 'C:\\Projects\\src', 'with "mirror" a root appears at its PC path when the sandbox can show it there (C:\\Users\\... cannot)');

  t.section('projects: tighten-only protections when joining a running sandbox');
  const base = protectionsOf(f.baseConfig);
  check(checkJoin(base, base).stricter.length === 0 && checkJoin(base, base).looser.length === 0, 'the same settings join without notes');
  const readonlyGit = protectionsOf({ ...f.baseConfig, provisioning: { ...f.baseConfig.provisioning, git: { ...f.baseConfig.provisioning.git, access: 'readonly' } } });
  check(checkJoin(base, readonlyGit).stricter.some((s) => s.startsWith('provisioning.git.access')), 'a project needing stricter git access than the running sandbox is refused (git access is machine-wide)');
  check(checkJoin(readonlyGit, base).stricter.length === 0 && checkJoin(readonlyGit, base).looser.some((s) => s.includes('provisioning.git.access stays "readonly"')), 'a project asking for less gets the sandbox\'s stricter value, with a note: never loosened');
  const offline = protectionsOf({ ...f.baseConfig, sandbox: { ...f.baseConfig.sandbox, networking: false } });
  check(checkJoin(base, offline).stricter.some((s) => s.startsWith('sandbox.networking')) && checkJoin(offline, base).looser.some((s) => s.startsWith('sandbox.networking')), 'networking off is stricter; on is looser');
  const readOnly = protectionsOf({ ...f.baseConfig, readOnly: true });
  check(checkJoin(readOnly, readOnly).stricter.some((s) => s.startsWith('readOnly')), 'a read-only project cannot join (other projects are mapped read/write), even when the launch folder was read-only');
  check(!LocalOverrides.safeParse({ projects: { roots: ['C:\\'] } }).success && !LocalOverrides.safeParse({ projects: { all: true } }).success, 'a project\'s .sandbox-config.json can never set projects.* (they map folders of this PC)');

  // A project file that loosens git access is clamped by keepStrictest first, then joins without being refused.
  const strictUser = structuredClone(f.baseConfig);
  strictUser.provisioning.git.access = 'readonly';
  const looseDir = f.at('proj-loose');
  fs.mkdirSync(looseDir, { recursive: true });
  f.writeLocal(looseDir, { provisioning: { git: { access: 'full' } } });
  const loose = await f.run({ cwd: looseDir, trustConfig: true }, strictUser);
  check(loose.config.provisioning.git.access === 'readonly' && checkJoin(protectionsOf(strictUser), protectionsOf(loose.config)).stricter.length === 0, 'tighten-only: a project file cannot loosen git access, so it joins a readonly sandbox as readonly');
  const tightDir = f.at('proj-tight');
  fs.mkdirSync(tightDir, { recursive: true });
  f.writeLocal(tightDir, { provisioning: { git: { access: 'none' } } });
  const tight = await f.run({ cwd: tightDir, trustConfig: true });

  t.section('projects: registry and joining');
  const storage = f.at('proj-storage');
  const data = path.join(storage, 'data', 'testdata');
  fs.mkdirSync(data, { recursive: true });
  const root = f.at('proj-root');
  const inRoot = path.join(root, 'web');
  const outside = f.at('proj-outside');
  for (const d of [inRoot, outside]) fs.mkdirSync(d, { recursive: true });
  const primary = startRegistry(storage, { launchId: '1700000000000-abcdef', protections: base, primary: { host: f.workA, guest: 'C:\\Workspace\\work-a' }, roots: [{ host: root, guest: 'C:\\Projects\\proj-root' }], boot: [{ host: f.workB, guest: 'C:\\Projects\\work-b' }] });
  const reg = readRegistry(storage);
  check(primary.primary && reg?.projects.length === 2 && reg.projects[1].mechanism === 'boot' && reg.projects[1].name === 'work-b', 'at launch the registry holds the launch folder and the projects mapped with it');
  check(projectHere(storage, path.join(f.workA, 'src'))?.guestDir === 'C:\\Workspace\\work-a\\src' && projectHere(storage, f.workB)?.project.mechanism === 'boot' && projectHere(storage, outside) === null, 'which project a folder is in (the shared helper every command uses)');
  const noWsb = projectMapper({ storageRoot: storage, packageRoot: f.install, wsbShare: true, detect: () => null });
  const web = noWsb.register(inRoot);
  check(web.mechanism === 'root' && web.guest === 'C:\\Projects\\proj-root\\web' && noWsb.register(inRoot).name === web.name &&readRegistry(storage)?.projects.filter((p) => p.host === inRoot).length === 1, 'a folder inside a root joins at once (also one created after boot), registered once');
  const needs = (() => { try { noWsb.register(outside); return null; } catch (e) { return e; } })();
  check(needs instanceof NeedsRestart && needs.reason.includes('wsb share needs Windows 11 24H2'), 'a folder outside every root without the Windows Sandbox CLI needs a restart (and says why)');
  const off = (() => { try { projectMapper({ storageRoot: storage, packageRoot: f.install, wsbShare: false }).register(outside); return null; } catch (e) { return e; } })();
  check(off instanceof NeedsRestart && off.reason.includes('projects.wsbShare'), 'projects.wsbShare off goes straight to the restart offer');
  const fakeWsb: Wsb = { exe: f.at('no-such-wsb.exe'), version: '0.1.0', commands: ['share', 'list'], has: (c) => c === 'share' || c === 'list' };
  const listFails = (() => { try { projectMapper({ storageRoot: storage, packageRoot: f.install, wsbShare: true, detect: () => fakeWsb }).register(outside); return null; } catch (e) { return e; } })();
  check(listFails instanceof NeedsRestart && listFails.reason.includes('wsb share could not find the running sandbox'), 'when wsb cannot tell which sandbox is ours, it falls back to the restart offer with the reason');
  check(await rejects(() => noWsb.register(storage), 'cannot be the workspace') && await rejects(() => noWsb.register('C:\\'), 'whole drive'), 'joining uses the launch-folder safety checks (no storage folder, no drive root)');
  check(await rejects(() => noWsb.unregister(primary.name), 'stays until the sandbox stops'), 'the launch folder cannot be removed from a running sandbox');

  // joinRunning: resolves the folder, checks protections, registers it, guards it, and builds the spec for the guest.
  const resolveFor = (run: ResolvedRun) => async (): Promise<ResolvedRun> => run;
  const webRun = await f.run({ cwd: inRoot, trustConfig: true });
  const joined = await joinRunning({ storageRoot: storage, dataPath: data, packageRoot: f.install, hostDir: path.join(inRoot), wsbShare: false, resolve: resolveFor(webRun) });
  check(joined.spec?.workspace === 'C:\\Projects\\proj-root\\web' && joined.spec.workspaceHost === inRoot && ProjectSpec.safeParse(joined.spec).success && joined.spec.harnesses.claude !== undefined, 'joining a project builds a valid spec (its guest folder, toolchains, versions, agent) for the guest');
  check(readKnown(storage).some((k) => k.host === inRoot), 'joined projects are remembered (projects.all, sandbox projects)');
  check((await joinRunning({ storageRoot: storage, dataPath: data, packageRoot: f.install, hostDir: path.join(f.workA, 'sub'), wsbShare: false, resolve: () => Promise.reject(new Error('must not resolve')) })).spec === null, 'the launch folder (and below) needs no spec: its sessions use the boot environment');
  check(await rejects(() => joinRunning({ storageRoot: storage, dataPath: data, packageRoot: f.install, hostDir: tightDir, wsbShare: false, resolve: resolveFor(tight) }), 'stricter protection than the running sandbox'), 'a project whose .sandbox-config.json tightens git access beyond the running sandbox is refused, with the reason');
  check(readRegistry(storage)?.projects.every((p) => p.host !== tightDir) === true, 'a refused project is not registered');
  const outsideRun = await f.run({ cwd: outside });
  check(await rejects(() => joinRunning({ storageRoot: storage, dataPath: data, packageRoot: f.install, hostDir: outside, wsbShare: false, resolve: resolveFor(outsideRun) }), 'projects.wsbShare'), 'a folder that cannot be shown lets NeedsRestart reach the caller');

  t.section('projects: the spec and request the guest gets');
  const spec = projectSpec(webRun, web, false);
  const request = (extra: Record<string, unknown>) => GuestRequest.safeParse({ kind: 'session', id: 'r1', harness: 'claude', args: [], cwd: spec.workspace, createdAt: new Date().toISOString(), ...extra });
  check(request({ project: spec }).success && request({ project: spec, harnessSpec: f.baseConfig.harnesses.codex }).success, 'session requests carry a project spec and an agent definition');
  check(!request({ project: { ...spec, name: '..\\evil' } }).success && !request({ project: { ...spec, extra: 1 } }).success && !request({ project: { ...spec, databases: Array(9).fill(spec.databases[0] ?? { database: 'redis', reasons: [], version: 'x', port: 6379 }) } }).success, 'specs are validated: file-name safe ids, no unknown keys, capped lists');
  check(!request({ project: { ...spec, harnesses: Object.fromEntries(Array.from({ length: 9 }, (_, i) => ['a' + i, f.baseConfig.harnesses.codex])) } }).success, 'at most 8 agent definitions in one spec');
  check(GuestRequest.safeParse({ kind: 'project', id: 'p1', project: spec, createdAt: 'x' }).success && !GuestRequest.safeParse({ kind: 'project', id: 'p1', createdAt: 'x' }).success, '"project" requests (set up without an agent) need a spec');
  check(GuestRequest.safeParse({ kind: 'restart', id: 'x', harness: null, cwd: 'C:\\Projects\\a', createdAt: 'x' }).success && GuestRequest.safeParse({ kind: 'restart', id: 'x', harness: null, createdAt: 'x' }).success, 'restart can be scoped to one project\'s folder');

  t.section('projects: which projects are mapped at boot');
  check(JSON.stringify(allProjectsToMap(['C:\\a', 'C:\\a\\b', 'C:\\work-a\\x', 'C:\\r\\p', 'C:\\ex\\y', 'C:\\gone'], { primary: 'C:\\work-a', roots: ['C:\\r'], exclude: ['C:\\ex'], exists: (p) => p !== 'C:\\gone' })) === JSON.stringify(['C:\\a']),
    'projects.all: known projects except excluded, missing, nested, the launch folder\'s and the roots\'');
  const rootCfg = structuredClone(f.baseConfig);
  rootCfg.projects = { ...rootCfg.projects, roots: [root, f.at('no-such-root')], all: true };
  rememberProject(f.baseConfig.storage.root, outside);
  const gen = f.generate(await f.run({}, rootCfg));
  const session = f.readJson(gen.sessionPath);
  const wsb = fs.readFileSync(gen.wsbPath, 'utf8');
  check(gen.projects.roots.length === 1 && gen.projects.roots[0].guest === 'C:\\Projects\\proj-root' && gen.projects.notes.some((n) => n.includes('no-such-root')), 'roots are mapped as C:\\Projects\\<name>; a missing root is skipped with a note');
  check(gen.projects.projects.some((p) => p.host === outside) && wsb.includes('<HostFolder>' + root + '</HostFolder><SandboxFolder>C:\\Projects\\proj-root</SandboxFolder><ReadOnly>false</ReadOnly>'), 'projects.all maps the known projects too, read/write, in the .wsb');
  check(session.projectsDir === PROJECTS_GUEST && JSON.stringify(session.roots) === JSON.stringify(['C:\\Projects\\proj-root']) && session.projectId === 'work-a', 'session.json tells the guest where other projects can be');
  const badRoot = structuredClone(f.baseConfig);
  badRoot.projects = { ...badRoot.projects, roots: [f.baseConfig.storage.root] };
  check(await rejects(async () => f.generate(await f.run({}, badRoot)), 'projects.roots'), 'a root that would expose the storage folder is refused');
  check(forgetProject(f.baseConfig.storage.root, outside) && !readKnown(f.baseConfig.storage.root).some((k) => k.host === outside), 'sandbox projects remove forgets a project (its folder is untouched)');
  check(buildWsb(f.baseConfig, 4096, []).includes('<MappedFolders></MappedFolders>'), 'no projects: nothing extra mapped');

  t.section('projects: repo guard for every project the sandbox can write');
  const guardData = f.at('guard-data');
  const rootG = f.at('guard-root');
  const old = path.join(rootG, 'old');
  write(path.join(old, '.git', 'hooks', 'pre-commit'), 'mine');
  write(path.join(old, '.git', 'config'), '[core]\n\tbare = false\n');
  saveRepoSnapshot(guardData, f.workA, [], [rootG]);
  write(path.join(old, '.git', 'hooks', 'post-checkout'), 'planted');
  const fresh = path.join(rootG, 'created-later');
  write(path.join(fresh, '.git', 'hooks', 'pre-push'), 'planted');
  write(path.join(fresh, '.git', 'config'), '[core]\n\tfsmonitor = evil.exe\n\tbare = false\n');
  write(path.join(fresh, 'node.exe'), 'planted');
  const found = checkRepo(guardData);
  check(fs.existsSync(path.join(old, '.git', 'hooks', 'pre-commit')) && !fs.existsSync(path.join(old, '.git', 'hooks', 'post-checkout')), 'a hook added inside the sandbox to a project in a root is quarantined; one that was there before stays');
  check(!fs.existsSync(path.join(fresh, '.git', 'hooks', 'pre-push')) && !fs.existsSync(path.join(fresh, 'node.exe')) && fs.readFileSync(path.join(fresh, '.git', 'config'), 'utf8').includes('# [agent-sandbox] disabled') && found.some((x) => x.detail.startsWith(fresh)), 'a project that appeared in a root after the start has no baseline: its hooks, planted commands and program-running git config are neutralised');

  t.section('projects: history and environment');
  const hostClaude = f.at('hist-host');
  const guestClaude = f.at('hist-guest');
  const bHost = f.at('hist-b');
  write(path.join(guestClaude, 'projects', projectFolderName('C:\\Projects\\hist-b'), 's.jsonl'), JSON.stringify({ cwd: 'C:\\Projects\\hist-b\\src' }) + '\n');
  syncHistoryOut({ hostClaudeDir: hostClaude, guestClaudeDir: guestClaude, hostWorkspace: f.workA, guestWorkspace: 'C:\\Workspace\\work-a', extra: [{ hostWorkspace: bHost, guestWorkspace: 'C:\\Projects\\hist-b' }] });
  const back = path.join(hostClaude, 'projects', projectFolderName(bHost), 's.jsonl');
  check(fs.existsSync(back) && fs.readFileSync(back, 'utf8').includes(JSON.stringify(bHost + '\\src').slice(1, -1)), 'a joined project\'s history goes back to ITS folder on this PC, with paths translated');
  const env = baseEnvFor({ basePath: 'C:\\Windows', toolVars: ['NVM_HOME', 'CARGO_HOME'], steps: {}, summary: [], lan: 'blocked' }, { Path: 'C:\\tools\\a;C:\\Windows', NVM_HOME: 'x', CARGO_HOME: 'y', CARGO_TARGET_DIR: 'C:\\Workspace\\a\\target', AGENT_WORKSPACE: 'C:\\Workspace\\a', TEMP: 'C:\\t' });
  check(env.PATH === 'C:\\Windows' && env.Path === undefined && env.NVM_HOME === undefined && env.CARGO_TARGET_DIR === undefined && env.AGENT_WORKSPACE === undefined && env.TEMP === 'C:\\t', 'a joined project starts from the boot\'s base environment: none of the first project\'s tools, workspace or target folder');

  t.section('projects: commands');
  const s = (id: string, cwd: string, startedAt: string): SessionStatus => ({ id, launchId: 'l', harness: 'claude', cwd, phase: 'running', message: '', updatedAt: startedAt, startedAt });
  const ordered = sessionsFirstIn([s('a1', 'C:\\Workspace\\a', '1'), s('b1', 'C:\\Projects\\b', '2'), s('a2', 'C:\\Workspace\\a\\x', '3'), s('b2', 'C:\\Projects\\b\\y', '4')], 'C:\\Projects\\b');
  check(ordered.map((x) => x.id).join() === 'b2,b1,a2,a1', 'attach and sessions put this project\'s sessions first, newest first');
  check(describeSessions([{ harness: 'claude', cwd: 'C:\\Workspace\\api', project: 'api' }, { harness: 'codex', cwd: 'C:\\Projects\\web' }]) === '2 sessions (claude in api, codex in web)', 'the restart offer lists the sessions that would end');
  check(await rejects(() => validateProjectsArgs(['bogus']), 'projects action') && await rejects(() => validateProjectsArgs(['add']), 'Which folder') && await rejects(() => validateProjectsArgs(['all', 'maybe']), 'on') && await rejects(() => validateProjectsArgs(['roots', 'add']), 'Which folder'), 'sandbox projects validates its arguments');
  validateProjectsArgs([]); validateProjectsArgs(['roots']); validateProjectsArgs(['all', 'on']);
  check(askedWhen(['add', 'remove'], 'add') && !askedWhen(['add'], 'list') && askedWhen(undefined, 'x') && askedWhen('save', 'save'), 'the menu asks an argument only for the actions it belongs to');

  t.section('projects: several sessions at once (--session agent@folder)');
  const want = parseSessionWant('claude@C:\\code\\a@b', 'C:\\here');
  check(want.harness === 'claude' && want.folder === 'C:\\code\\a@b' && parseSessionWant('codex', 'C:\\here').folder === 'C:\\here' && parseSessionWant('gemini@sub', 'C:\\here').folder === 'C:\\here\\sub', '--session: the first @ splits; no folder = this one; relative folders become absolute');
  check(await rejects(() => parseSessionWant('@C:\\x'), 'names no agent'), '--session without an agent is refused');
  const own = parseSessionWant('codex@C:\\code\\web|--model o3 "two words"', 'C:\\here');
  check(own.harness === 'codex' && own.folder === 'C:\\code\\web' && JSON.stringify(own.args) === '["--model","o3","two words"]' && parseSessionWant('claude@C:\\x').args === undefined,
    '--session: after | come that agent\'s own arguments (quotes keep words together); none without |');
  const both = parseCli(['launch', '--session', 'claude@C:\\a|--continue', '--session', 'codex@C:\\b', '--', '--verbose']);
  check(both.passthrough.join() === '--verbose' && JSON.stringify(both.sessions.map((s) => s.args ?? [])) === '[["--continue"],[]]',
    'arguments after -- go to every session, arguments after | only to that one');
  const multi = parseCli(['launch', '--session', 'claude@' + f.workA, '--session', 'codex@' + f.workB, '--session', 'claude@' + f.workB, '-t', '--', '--continue']);
  check(multi.command === 'launch' && multi.sessions.length === 3 && multi.terminal && multi.sessions[1].harness === 'codex' && multi.passthrough.join() === '--continue', 'several --session options parse in order, with -t and agent arguments');
  const vctx = (options: ReturnType<typeof parseCli>) => ({ packageRoot: f.install, entry: '', options, loaded: { config: f.baseConfig, configPath: null, base: t.temp }, storageRoot: f.baseConfig.storage.root, dataPath: f.at('vdata') }) as Context;
  check(await rejects(() => validateOptions(vctx(parseCli(['launch', '--session', 'claud@' + f.workA]))), 'Did you mean'), 'an unknown agent in --session suggests the closest one');
  check(await rejects(() => validateOptions(vctx(parseCli(['launch', '--session', 'claude@' + f.at('nope')]))), 'does not exist'), 'a missing --session folder is refused before anything starts');
  check(await rejects(() => validateOptions(vctx(parseCli(['launch', '--session', 'claude@' + f.workA, '--harness', 'codex']))), 'do not apply'), '--session cannot be mixed with --harness/--workspace');
  validateOptions(vctx(multi));
  check(severalAgentsArgv([{ harness: 'claude', folder: 'C:\\a' }, { harness: 'codex', folder: 'C:\\b c' }], { headless: true, attachFirst: true }).join(' ') === 'launch --session claude@C:\\a --session codex@C:\\b c --headless -t', 'the menu builds the same command line (so repeat-last works)');
  check(candidateFolders(vctx(parseCli(['launch'])), f.workA)[0] === path.resolve(f.workA), 'the menu offers this folder first, then known projects and the folders in your roots');
  const multiGen = generateSandbox({ packageRoot: t.packageRoot, run: await f.run(), harnessArgs: [], probe: f.probe, extraProjects: [f.workB, path.join(f.workA, 'sub'), f.workB], autoSession: false });
  const multiSession = f.readJson(multiGen.sessionPath);
  const multiWsb = fs.readFileSync(multiGen.wsbPath, 'utf8');
  check(multiGen.projects.projects.length === 1 && multiGen.projects.projects[0].guest === 'C:\\Projects\\work-b' && multiWsb.includes('<HostFolder>' + f.workB + '</HostFolder><SandboxFolder>C:\\Projects\\work-b</SandboxFolder>'), 'a multi-project launch maps every other project once (folders inside the launch folder and duplicates need nothing)');
  check(multiSession.autoSession === false && multiSession.workspaceHost === f.workA, 'the boot provisions the launch folder only; the host then opens every session (each project set up on demand, in parallel)');

  t.section('projects: wsb (Windows Sandbox command line) adapter');
  check(parseVersion('Windows Sandbox CLI version 0.4.1.0\n') === '0.4.1.0' && parseVersion('nothing') === null, 'wsb --version');
  const help = 'Description:\n  Windows Sandbox command line\n\nUsage:\n  wsb [command] [options]\n\nOptions:\n  --version  Show version information\n\nCommands:\n  start    Starts a sandbox\n  list     Lists sandboxes\n  exec     Runs a command\n  share    Shares a folder\n  stop     Stops a sandbox\n  connect  Connects\n  ip       Shows the IP\n';
  check(parseCommands(help).join() === 'start,list,exec,share,stop,connect,ip' && parseCommands('no commands here').length === 0, 'wsb --help: the subcommands it offers');
  const id = '12345678-1234-1234-1234-1234567890ab';
  check(parseList(JSON.stringify([{ Id: id, Status: 'Running', Uptime: '00:10' }]))[0]?.id === id && parseList(JSON.stringify({ WindowsSandboxEnvironments: [{ id, status: 'Stopped' }] }))[0]?.status === 'Stopped', 'wsb list --raw: an array or an object holding one');
  check(parseList('Id                                    Status   Uptime\n' + id + '  Running  00:01:02\n')[0]?.status === 'Running' && parseList('nothing').length === 0, 'wsb list as a table');
  check(parseIp('172.20.1.5\r\n') === '172.20.1.5' && parseIp('none') === null, 'wsb ip');
  const apps = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wsb.exe';
  check(findWsb({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', SystemRoot: 'C:\\Windows' }, (p) => p === apps) === apps && findWsb({ SystemRoot: 'C:\\Windows' }, () => false) === null, 'wsb.exe is looked for at absolute paths only (WindowsApps alias, System32)');
};
