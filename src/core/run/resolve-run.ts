import path from 'node:path';
import type { Config, Mapping, Overrides, ResolvedRun, RunRequest } from '../types.js';
import { DATABASES, type Database } from '../detect/index.js';
import {
  allowedAnswer,
  allowRequests,
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
  saveAllowed,
  saveTrust,
  trustStorePath,
} from '../local-config/index.js';
import { assertSafeWorkspace } from '../safe-paths.js';
import { dirExists, expandPath, fail, plainText } from '../util/index.js';
import { guestWorkspaceOf, placeInRoot, previewGuest } from './guest-workspace.js';
import { resolveVersions } from './versions.js';

/** Precedence (lowest to highest): built-in defaults, user config, .sandbox-config.json in the workspace, command-line flags. */
export const resolveRun = async (req: RunRequest, hostNodeVersion: string = process.version): Promise<ResolvedRun> => {
  const notes: string[] = [];
  // Mappings from the user config are relative to that config file; expand them before anything else uses them.
  const expand = (list: string[]): string[] => list.map((p) => expandPath(p, req.loaded.base));
  const projects = req.loaded.config.projects;
  let config = {
    ...req.loaded.config,
    mappings: req.loaded.config.mappings.map((m) => ({ ...m, host: expandPath(m.host, req.loaded.base) })),
    projects: {
      ...projects,
      roots: expand(projects.roots),
      exclude: expand(projects.exclude),
      declinedRoots: expand(projects.declinedRoots),
    },
  };
  const mirror = config.guestWorkspace === 'mirror';
  const storageRoot = expandPath(config.storage.root, req.loaded.base);

  const workspaceHost = path.resolve(req.workspace ?? req.cwd);
  if (!dirExists(workspaceHost))
    fail(
      'The workspace folder does not exist: ' + workspaceHost,
      'Check the --workspace path, or cd into the project first.',
    );
  assertSafeWorkspace(workspaceHost, req.packageRoot, storageRoot);

  const scripts: string[] = [];
  let localConfigPath: string | null = null;
  let overrides: Overrides = {};
  const local = req.noLocalConfig ? null : readLocalConfig(workspaceHost);
  let outsideAllowed: string[] = [];
  if (local) {
    overrides = normalizeOverrides(local.data, workspaceHost, local.path);
    const store = trustStorePath(storageRoot);
    if (!isTrusted(store, local.path, local.hash)) {
      const summary = describeOverrides(overrides, workspaceHost);
      let trusted = req.trustConfig;
      if (!trusted && req.ask) {
        console.log('\nFound ' + local.path + ' which is not trusted yet. It would apply:');
        for (const line of summary) console.log('  ' + plainText(line));
        trusted = await req.ask('Trust and use this file?');
      }
      if (!trusted)
        fail(
          local.path +
            ' has not been approved yet (a repo can ship this file, so it needs your OK). It would apply:\n  ' +
            (summary.map(plainText).join('\n  ') || '(no changes)'),
          'Review it, then run again in an interactive terminal and answer y, or add --trust-config. To ignore the file: --no-local-config',
        );
      saveTrust(store, local.path, local.hash);
      notes.push('Trusted ' + local.path + ' (you will only be asked again if the file changes).');
    }
    const requests = await projectFileRequests(req, config, overrides, local.path, workspaceHost, storageRoot, notes);
    const allowed = requests.allowed;
    outsideAllowed = requests.outside;
    config = applyOverrides(allowRequests(config, allowed), overrides);
    scripts.push(...(overrides.scripts ?? []));
    localConfigPath = local.path;
    notes.push('Using ' + local.path);
  }
  if (req.headless !== undefined) config = { ...config, sandbox: { ...config.sandbox, headless: req.headless } };
  for (const name of req.databases ?? []) {
    const db = name.toLowerCase() as Database;
    if (!DATABASES.includes(db)) fail('Unknown database "' + name + '".', 'Choose from: ' + DATABASES.join(', '));
    config = { ...config, databases: { ...config.databases, [db]: { ...config.databases[db], enabled: true } } };
  }
  // auto / mirror: a project inside a root is where the root shows it, whichever project starts the sandbox.
  const guest = guestWorkspaceOf(config, workspaceHost);
  const placed =
    config.guestWorkspace === 'auto' || mirror
      ? placeInRoot({ ...config, guestWorkspace: guest.guest }, workspaceHost, mirror, notes)
      : { ...config, guestWorkspace: guest.guest };
  if (guest.note && placed.guestWorkspace === guest.guest) notes.push(guest.note);
  config = placed;

  scripts.push(...req.scripts.map((s: string) => path.resolve(s)));
  const harnessName = req.noAgent ? 'none' : (req.harness ?? config.defaultHarness);
  if (harnessName !== 'none' && !config.harnesses[harnessName])
    fail(
      'Unknown agent "' + harnessName + '".',
      'Configured agents: ' +
        Object.keys(config.harnesses).join(', ') +
        ' (add more under "harnesses" in your config).',
    );
  const versions = resolveVersions(config, workspaceHost, overrides, req, hostNodeVersion);
  const dataPath = path.join(storageRoot, 'data', config.storage.dataName);
  // A project file may ask for "mirror" too (it decides only its own path); project roots follow the user's choice.
  return {
    config,
    storageRoot,
    dataPath,
    workspaceHost,
    harnessName,
    scripts,
    localConfigPath,
    notes,
    versions,
    mirror,
    outsideMappings: outsideAllowed,
  };
};

/**
 * A project may only tighten. What it asks for beyond that (a looser setting, a folder outside the project) is used
 * only if you allowed it for this project: asked once, in one question, at an interactive launch, never by
 * --trust-config. Folders outside the project follow projects.allowOutsideMappings (your settings only). A looser
 * setting you did not allow is named in the notes instead of dropped silently.
 */
async function projectFileRequests(
  req: RunRequest,
  config: Config,
  overrides: Overrides,
  localPath: string,
  workspaceHost: string,
  storageRoot: string,
  notes: string[],
): Promise<{ allowed: { key: string; wanted: unknown }[]; outside: string[] }> {
  const allowStore = allowStorePath(storageRoot);
  const policy = config.projects.allowOutsideMappings;
  // An optional folder that is not on this PC is skipped at launch, so it needs no answer (yet).
  const outside = outsideMappings(workspaceHost, overrides.mappings).filter((m) => !m.optional || dirExists(m.host));
  const name = path.basename(workspaceHost) + "'s " + LOCAL_CONFIG_NAME;
  const preview = guestWorkspaceOf(applyOverrides(config, overrides), workspaceHost).guest;
  const describe = (m: Mapping): string =>
    (m.readOnly ? 'read-only  ' : 'READ/WRITE ') + m.host + '  ->  ' + previewGuest(m, workspaceHost, preview).guest;
  const plural = (n: number): string => (n === 1 ? '' : 's');
  if (outside.length && policy === false) {
    fail(
      name +
        ' maps ' +
        outside.length +
        ' folder' +
        plural(outside.length) +
        ' outside the project, and your settings do not allow that:\n  ' +
        outside.map(describe).join('\n  '),
      'Allow it: set projects.allowOutsideMappings to "ask" or true in your settings (sandbox > Settings, or the file sandbox config path shows). Or remove those mappings from the file.',
    );
  }
  const looser = loosenedRequests(config, overrides);
  const interactive = Boolean(req.ask) && (req.interactive ?? Boolean(process.stdin.isTTY));
  const notAllowedYet = (): Mapping[] =>
    policy === 'ask'
      ? outside.filter((m) => allowedAnswer(allowStore, localPath, OUTSIDE_FOLDER, outsideKey(m)) !== true)
      : [];
  const openOutside = notAllowedYet();
  const openLooser = looser.filter((a) => allowedAnswer(allowStore, localPath, a.key, a.wanted) === null);
  let declinedOutside = false;
  if (interactive && req.ask && (openOutside.length || openLooser.length)) {
    console.log('\n' + name + ' asks for more than your settings allow:');
    if (openOutside.length)
      console.log(
        '  Folders outside the project:\n' + openOutside.map((m) => '    ' + plainText(describe(m))).join('\n'),
      );
    for (const a of openLooser)
      console.log(
        '  ' + a.key + ' = ' + JSON.stringify(a.wanted) + '  (your settings: ' + JSON.stringify(a.yours) + ')',
      );
    const ok = await req.ask(
      'Allow ' + (openOutside.length + openLooser.length === 1 ? 'it' : 'these') + ' for this project?',
    );
    for (const a of openLooser) saveAllowed(allowStore, localPath, a.key, a.wanted, ok);
    // A "no" to folders is not kept: the next interactive launch asks again.
    if (ok) for (const m of openOutside) saveAllowed(allowStore, localPath, OUTSIDE_FOLDER, outsideKey(m), true);
    declinedOutside = !ok && openOutside.length > 0;
  }
  const notAllowed = notAllowedYet();
  if (notAllowed.length) {
    const them = notAllowed.length === 1 ? 'it' : 'them';
    const what =
      name +
      ' maps ' +
      notAllowed.length +
      ' folder' +
      plural(notAllowed.length) +
      ' outside the project:\n  ' +
      notAllowed.map(describe).join('\n  ');
    fail(
      what +
        (declinedOutside
          ? '\nYou did not allow ' + them + ', so the sandbox was not started.'
          : '\nThat needs your OK once (a repo ships this file), and this launch cannot ask (no interactive terminal).'),
      'Allow ' +
        them +
        ': start it from an interactive terminal and answer y, or set projects.allowOutsideMappings to true in your settings (sandbox > Settings, or the file sandbox config path shows).',
    );
  }
  const allowedHosts = [...new Set(outside.map((m) => m.host))];
  if (outside.length)
    notes.push(
      'Folders outside the project allowed for ' +
        name +
        ' (' +
        (policy === true ? 'projects.allowOutsideMappings is true' : 'your answer is kept in ' + allowStore) +
        '): ' +
        allowedHosts.join(', '),
    );
  const allowed: { key: string; wanted: unknown }[] = [];
  for (const ask of looser) {
    const ok = allowedAnswer(allowStore, localPath, ask.key, ask.wanted);
    if (ok) {
      allowed.push(ask);
      notes.push(
        'Allowed for this project: ' +
          ask.key +
          ' = ' +
          JSON.stringify(ask.wanted) +
          ' (your answer is kept in ' +
          allowStore +
          ').',
      );
    } else
      notes.push(
        'The project asks for ' +
          ask.key +
          ' = ' +
          JSON.stringify(ask.wanted) +
          ', but your settings say ' +
          JSON.stringify(ask.yours) +
          ', so it is not used. ' +
          (ok === false
            ? 'You said no (kept in ' + allowStore + ').'
            : 'Start it from an interactive terminal to allow it for this project.') +
          ' Or set ' +
          ask.key +
          ' in your own settings (sandbox, then Settings > All projects).',
      );
  }
  return { allowed, outside: allowedHosts };
}
