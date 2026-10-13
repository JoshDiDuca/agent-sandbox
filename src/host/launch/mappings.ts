// Which folders are mapped into the sandbox: the launch folder, the data folder, the workspace, your extra folders and
// the tools copied from this PC. Everything is checked before it can reach the .wsb.
import type { GenerateOptions, ResolvedMapping } from '../../core/types.js';
import { assertNoGuestOverlap } from '../../core/config.js';
import { assertSafeMapping } from '../../core/safe-paths.js';
import { dirExists, fail } from '../../core/util.js';
import { shownByRoot, type BootProjects } from './projects.js';
import { isValidGuestPath, sandboxFolder } from '../../shared/guest-paths.js';
import { GUEST } from './wsb.js';
import { guestGitDir, planView } from '../workspace-view/index.js';

export const collectMappings = (o: GenerateOptions, launchPath: string, boot: BootProjects = { roots: [], projects: [], notes: [] }): ResolvedMapping[] => {
  const { config, dataPath, workspaceHost, harnessName } = o.run;
  assertGuestPath(config.guestWorkspace, 'guestWorkspace');
  // workspaceFilter: the sandbox gets the project's filtered view (no git-ignored files) and its real .git beside it.
  const view = planView(config, o.run.storageRoot, workspaceHost);
  // A launch folder inside a project root is shown by the root, at the place it has whichever project starts the sandbox.
  const inRoot = !view && shownByRoot(boot.roots, workspaceHost, config.guestWorkspace);
  const mappings: ResolvedMapping[] = [
    { host: launchPath, guest: GUEST.launch, readOnly: true },
    { host: dataPath, guest: GUEST.data, readOnly: false },
    ...(inRoot ? [] : [{ host: view ? view.options.view : workspaceHost, guest: config.guestWorkspace, readOnly: config.readOnly }]),
    ...(view?.hostGit ? [{ host: view.hostGit, guest: guestGitDir(config.guestWorkspace), readOnly: config.readOnly }] : []),
  ];
  for (const m of config.mappings) {
    const host = m.host;
    assertGuestPath(m.guest, 'mappings[].guest for ' + host);
    if (!dirExists(host)) {
      if (m.optional) { console.warn('Skipping optional mapping (folder not found): ' + host); continue; }
      fail('A mapped folder does not exist: ' + host, 'Create it, fix the path in your config, or mark the mapping "optional": true.');
    }
    assertSafeMapping(host, o.packageRoot, o.run.storageRoot);
    mappings.push({ host, guest: m.guest, readOnly: m.readOnly });
  }
  // Project roots and other projects, so they can join the running sandbox without a restart (launch/projects.ts).
  for (const m of [...boot.roots, ...boot.projects]) {
    assertGuestPath(m.guest, 'project folder for ' + m.host);
    mappings.push({ host: m.host, guest: m.guest, readOnly: false });
  }
  const { probe } = o;
  if (probe.nodeDir) mappings.push({ host: probe.nodeDir, guest: GUEST.hostTools + '\\node', readOnly: true });
  if (probe.harnessExe && harnessName !== 'none') mappings.push({ host: probe.harnessExe.dir, guest: GUEST.hostTools + '\\agents\\' + harnessName, readOnly: true });
  if (probe.gitDir) mappings.push({ host: probe.gitDir, guest: GUEST.hostTools + '\\git', readOnly: true });
  if (probe.nvmDir) mappings.push({ host: probe.nvmDir, guest: GUEST.hostTools + '\\nvm', readOnly: true });
  assertNoGuestOverlap(mappings);
  // Same check on where the folders really are (F:\x and C:\Mirror\F\x are one place).
  assertNoGuestOverlap(mappings.map((m) => ({ guest: sandboxFolder(m.guest) })));
  return mappings;
};

/** The schema checks this already; the host re-checks what goes into the .wsb and the subst list anyway. */
const assertGuestPath = (guest: string, what: string): void => {
  if (!isValidGuestPath(guest)) fail(what + ' is not a usable sandbox folder: ' + guest, 'Use a folder under C:\\ (not Windows, Program Files, Users, AgentData, Mirror, ...) or on drive D: to Z:, e.g. C:\\Assets or F:\\SteamLibrary\\steamapps\\common\\Game.');
};
