// Which managed installs exist on this PC, and what a copy that runs from somewhere else should say about them. A
// managed install (<ProgramFiles or %LOCALAPPDATA%>\WindowsDevelopmentSandbox) is found from any copy of the program,
// so an npm copy or a checkout still sees the machine install that shares sandboxes with other users.
import path from 'node:path';
import { z } from 'zod';
import { fileExists } from '../../core/util/index.js';
import { JsonFile } from '../../shared/io/index.js';
import { InstallLayout } from './layout.js';

const FOLDER = 'WindowsDevelopmentSandbox';

function installAt(base: string | undefined, scope: 'user' | 'machine'): InstallLayout | null {
  if (!base || !path.isAbsolute(base)) return null;
  const root = path.join(base, FOLDER);
  if (!fileExists(path.join(root, 'active-version')) && !fileExists(path.join(root, 'install.json'))) return null;
  return InstallLayout.at(root, scope);
}

/** The install for everyone (%ProgramFiles%\WindowsDevelopmentSandbox), or null. */
export function machineInstall(env: NodeJS.ProcessEnv = process.env): InstallLayout | null {
  return installAt(env.ProgramFiles, 'machine');
}

/** The install for just this user (%LOCALAPPDATA%\WindowsDevelopmentSandbox), or null. */
export function userInstall(env: NodeJS.ProcessEnv = process.env): InstallLayout | null {
  return installAt(env.LOCALAPPDATA, 'user');
}

/** The installs that exist, the one for everyone first (it comes first on the PATH too). */
export function managedInstalls(env: NodeJS.ProcessEnv = process.env): InstallLayout[] {
  return [machineInstall(env), userInstall(env)].filter((l): l is InstallLayout => l !== null);
}

/** Where this copy runs from, for `--version`: "all users, <folder>", "just you, <folder>", "npm copy, <folder>". */
export function describeCopy(packageRoot: string): string {
  const layout = InstallLayout.detect(packageRoot);
  if (layout) return (layout.scope === 'machine' ? 'all users, ' : 'just you, ') + layout.root;
  const resolved = path.resolve(packageRoot);
  const npm = path.basename(path.dirname(resolved)).toLowerCase() === 'node_modules';
  return (npm ? 'npm copy, ' : 'from ') + resolved;
}

/** The line to print when this copy is not a managed install but one exists (it is hidden by this one), else null. */
export function hiddenInstallLine(packageRoot: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (InstallLayout.detect(packageRoot)) return null;
  const installed = managedInstalls(env)[0];
  if (!installed) return null;
  return (
    'Running the copy in ' +
    path.resolve(packageRoot) +
    '; the installed one in ' +
    installed.root +
    ' is hidden. sandbox doctor explains.'
  );
}

const NoticeSchema = z.object({ version: z.string() });

/** hiddenInstallLine, but once per version (null afterwards). `storageRoot` holds the note that it was shown. */
export function takeHiddenInstallNotice(
  storageRoot: string,
  packageRoot: string,
  version: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const line = hiddenInstallLine(packageRoot, env);
  if (!line) return null;
  const file = new JsonFile(NoticeSchema, path.join(storageRoot, 'copy-notice.json'));
  if (file.read()?.version === version) return null;
  file.write({ version });
  return line;
}
