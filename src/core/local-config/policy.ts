// Joining a running sandbox from another project. Its protections (network, LAN block, git access, clipboard, the
// .wsb device settings, read-only) are machine-wide: they were fixed when the sandbox booted for the first project.
// A second project may never loosen them, and a project that needs a STRICTER setting than the running sandbox has
// cannot get it there without changing it for the sessions already running, so that launch is refused with a clear
// message. A project asking for less than the sandbox has simply runs with the sandbox's (stricter) setting.
// Pure: the host checks it before registering a project, the tests drive it directly.
import _ from 'lodash';
import type { Config } from '../types.js';
import { GIT_STRICTNESS, NEVER_LOOSER, OFF_IS_SAFER, ON_IS_SAFER } from './overrides.js';

/** The protections of a running sandbox, by setting path (`sandbox.networking`, `provisioning.git.access`, ...). */
export type Protections = Record<string, boolean | string>;

export const protectionsOf = (config: Config): Protections =>
  Object.fromEntries(NEVER_LOOSER.map((p) => [p, _.get(config, p) as boolean | string]));

/** 1 = `wanted` is stricter than `running`, -1 = looser, 0 = the same. */
const compare = (
  setting: string,
  running: boolean | string | undefined,
  wanted: boolean | string | undefined,
): number => {
  if (setting === 'provisioning.git.access')
    return Math.sign((GIT_STRICTNESS[String(wanted)] ?? 0) - (GIT_STRICTNESS[String(running)] ?? 0));
  if (ON_IS_SAFER.includes(setting)) return Number(Boolean(wanted)) - Number(Boolean(running));
  if (OFF_IS_SAFER.includes(setting)) return Number(Boolean(running)) - Number(Boolean(wanted));
  return 0;
};

export interface JoinCheck {
  /** Settings this project needs stricter than the running sandbox: the launch is refused. */
  stricter: string[];
  /** Settings it would have looser: it gets the sandbox's (stricter) value; shown as a note. */
  looser: string[];
  /** Settings the sandbox turned on at its start for another project you allowed them for: shared, shown as a note. */
  shared: string[];
}

/**
 * Compares a project's effective protections with the running sandbox's. Hub projects are always read/write
 * (Windows Sandbox maps the hub once, read/write), so a read-only project counts as stricter. `widened`: the boot
 * settings the sandbox turned on for another of its projects (with your consent); a project that has them off
 * shares them instead of being refused.
 */
export const checkJoin = (running: Protections, wanted: Protections, widened: string[] = []): JoinCheck => {
  const stricter: string[] = [];
  const looser: string[] = [];
  const shared: string[] = [];
  for (const setting of NEVER_LOOSER) {
    const result = compare(setting, setting === 'readOnly' ? false : running[setting], wanted[setting]);
    if (result > 0 && widened.includes(setting)) shared.push(setting);
    else if (result > 0)
      stricter.push(
        setting +
          ' = ' +
          JSON.stringify(wanted[setting]) +
          ' (the running sandbox has ' +
          JSON.stringify(setting === 'readOnly' ? false : running[setting]) +
          ')',
      );
    if (result < 0) looser.push(setting + ' stays ' + JSON.stringify(running[setting]));
  }
  return { stricter, looser, shared };
};
