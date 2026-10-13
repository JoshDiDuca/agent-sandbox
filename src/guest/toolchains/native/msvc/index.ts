// MSVC (cl, link) and the Windows SDK without an installer (packages.ts), laid out like a Build Tools install with
// vcvars64.bat and a vswhere that points at it (environment.ts), so CMake, cargo (msvc host), node-gyp and vcvars-based
// scripts work. Use is governed by the Visual Studio licence terms: it only installs with toolchains.msvc.acceptLicense.
import fs from 'node:fs';
import path from 'node:path';
import type { Toolchains } from '../../../../core/types.js';
import { writeJsonAtomic } from '../../../../shared/io/json.js';
import { safeRemove } from '../../../../shared/io/safe-remove.js';
import { dryRun } from '../../../runtime/paths.js';
import { exists } from '../../../runtime/fs.js';
import { log } from '../../../runtime/log.js';
import type { ToolEnv } from '../../tool-env.js';
import { installVswhere, removeTelemetry, vcvars, writeVcvars, type VcEnv } from './environment.js';
import { installPackages } from './packages.js';
import { hasCompiler, MARKER, readInstalled, ROOT } from './tree.js';

/** The vcvars environment of an installed tree (for steps that run before the agent's environment exists). */
export const installedMsvcEnv = (): VcEnv | null => {
  const done = readInstalled();
  return done && hasCompiler(done.msvc) ? vcvars(ROOT, done.msvc, done.sdk) : null;
};

/** Empties tools\msvc for a fresh install, keeping the manifest and the verified downloads of an earlier attempt. */
const clearTree = (): void => {
  if (!exists(ROOT)) return;
  for (const name of fs.readdirSync(ROOT).filter((n) => n !== '.manifest.json' && n !== '.download'))
    safeRemove(path.join(ROOT, name), ROOT);
};

export const setupMsvc = async (env: ToolEnv, config: Toolchains['msvc']): Promise<void> => {
  if (!config.acceptLicense) {
    throw new Error(
      'MSVC is installed only with toolchains.msvc.acceptLicense = true: its use is governed by the Visual Studio licence terms (https://visualstudio.microsoft.com/license-terms/), which need a Visual Studio licence',
    );
  }
  if (dryRun) {
    log('(dry run) would provision MSVC ' + config.msvcVersion + ' and Windows SDK ' + config.sdkVersion);
    return;
  }
  const want = config.msvcVersion + '/' + config.sdkVersion;
  let done = readInstalled();
  if (!done || done.want !== want || !hasCompiler(done.msvc)) {
    log('Installing MSVC and the Windows SDK (~1-2 GB, once; licence accepted in toolchains.msvc.acceptLicense) ...');
    clearTree();
    done = { ...(await installPackages(config)), want };
    // Written last and atomically: without it (an interrupted install) the next boot starts over.
    writeJsonAtomic(MARKER, done);
  }
  removeTelemetry(done.msvc);
  const vc = vcvars(ROOT, done.msvc, done.sdk);
  writeVcvars(vc);
  installVswhere(done.msvc);
  Object.assign(env.vars, vc.vars);
  env.prepend.push(...vc.path);
  env.summary.push('msvc: ' + done.msvc + ', Windows SDK ' + done.sdk + ' (cl, link; vcvars64.bat and vswhere work)');
};
