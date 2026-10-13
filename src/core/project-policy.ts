// Joining a running sandbox from another project. Its protections (network, LAN block, git access, clipboard, the
// .wsb device settings, read-only) are machine-wide: they were fixed when the sandbox booted for the first project.
// A second project may never loosen them, and a project that needs a STRICTER setting than the running sandbox has
// cannot get it there without changing it for the sessions already running, so that launch is refused with a clear
// message. A project asking for less than the sandbox has simply runs with the sandbox's (stricter) setting.
// The other direction: what a project WANTS at boot (a .wsb device you allowed for it, more memory, its mappings) and
// the running sandbox started without. Those can only come with a restart, so they are named (missingAtBoot), and a
// sandbox started with several projects boots with all of their allowed wants (widenForProjects).
// Pure: the host checks it before registering a project, the tests drive it directly.
import _ from 'lodash';
import type { Config, ResolvedMapping } from './types.js';
import { GIT_STRICTNESS, NEVER_LOOSER, OFF_IS_SAFER, ON_IS_SAFER } from './local-config.js';

/** The protections of a running sandbox, by setting path (`sandbox.networking`, `provisioning.git.access`, ...). */
export type Protections = Record<string, boolean | string>;

export const protectionsOf = (config: Config): Protections => Object.fromEntries(NEVER_LOOSER.map((p) => [p, _.get(config, p) as boolean | string]));

/** 1 = `wanted` is stricter than `running`, -1 = looser, 0 = the same. */
const compare = (setting: string, running: boolean | string | undefined, wanted: boolean | string | undefined): number => {
  if (setting === 'provisioning.git.access') return Math.sign((GIT_STRICTNESS[String(wanted)] ?? 0) - (GIT_STRICTNESS[String(running)] ?? 0));
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
    else if (result > 0) stricter.push(setting + ' = ' + JSON.stringify(wanted[setting]) + ' (the running sandbox has ' + JSON.stringify(setting === 'readOnly' ? false : running[setting]) + ')');
    if (result < 0) looser.push(setting + ' stays ' + JSON.stringify(running[setting]));
  }
  return { stricter, looser, shared };
};

// ---- what a project wants at boot ---------------------------------------------------------------------------------

/** .wsb devices a project may want on (only when your settings or your answer for that project allow it). */
export const BOOT_SETTINGS = ['sandbox.vGpu', 'sandbox.networking', 'sandbox.clipboard', 'sandbox.audioInput', 'sandbox.videoInput', 'sandbox.printerRedirection'];
const LABELS: Record<string, string> = {
  'sandbox.vGpu': 'vGPU', 'sandbox.networking': 'networking', 'sandbox.clipboard': 'the shared clipboard',
  'sandbox.audioInput': 'the microphone', 'sandbox.videoInput': 'the camera', 'sandbox.printerRedirection': 'printers',
};

/** What the running sandbox booted with (host-only registry). */
export interface BootRecord { memoryMb: number | null; mappings: ResolvedMapping[] }

/** What a project wants that the running sandbox started without. */
export interface Missing { settings: string[]; memoryMb: number | null; mappings: ResolvedMapping[] }

const sameHost = (a: string, b: string): boolean => a.toLowerCase().replace(/\\+$/, '') === b.toLowerCase().replace(/\\+$/, '');
/** `m`'s folder is mapped, wherever the launch placed it (read-only is enough for a read-only wish). */
const isMapped = (mapped: ResolvedMapping[], m: { host: string; readOnly: boolean }): boolean => mapped.some((x) => sameHost(x.host, m.host) && (m.readOnly || !x.readOnly));

/**
 * The boot-only things `config` (a project's effective config: your settings, its approved file, your answers) asks
 * for that the running sandbox lacks. `exists`: optional mappings whose folder is missing are no wish.
 */
export const missingAtBoot = (running: Protections, boot: BootRecord, config: Config, exists: (folder: string) => boolean = () => true): Missing => ({
  settings: BOOT_SETTINGS.filter((s) => _.get(config, s) === true && running[s] === false),
  memoryMb: typeof config.sandbox.memoryMb === 'number' && boot.memoryMb !== null && config.sandbox.memoryMb > boot.memoryMb ? config.sandbox.memoryMb : null,
  mappings: config.mappings.filter((m) => (!m.optional || exists(m.host)) && !isMapped(boot.mappings, m)).map((m) => ({ host: m.host, guest: m.guest ?? m.host, readOnly: m.readOnly })),
});

export const nothingMissing = (m: Missing): boolean => m.settings.length === 0 && m.memoryMb === null && m.mappings.length === 0;

const listing = (items: string[]): string => items.length <= 1 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];

/** "mw2-agent wants vGPU and 2 folders (C:\Steam\..., F:\SteamLibrary\...), but this sandbox started without them." */
export const describeMissing = (project: string, m: Missing): string => {
  const items = [
    ...m.settings.map((s) => LABELS[s] ?? s),
    ...(m.memoryMb !== null ? [m.memoryMb + ' MB of memory'] : []),
    ...(m.mappings.length ? [m.mappings.length + ' folder' + (m.mappings.length === 1 ? '' : 's') + ' (' + m.mappings.map((x) => x.host).join(', ') + ')'] : []),
  ];
  return project + ' wants ' + listing(items) + ', but this sandbox started without ' + (items.length === 1 && !m.mappings.length ? 'it' : 'them') + '.';
};

/** "Set sandbox.vGpu (or the mappings) in your own settings to have them in every sandbox." */
export const missingTip = (m: Missing): string => {
  const keys = [...m.settings, ...(m.memoryMb !== null ? ['sandbox.memoryMb'] : [])];
  const what = keys.length ? listing(keys) + (m.mappings.length ? ' (or the mappings)' : '') : 'the mappings';
  return 'Set ' + what + ' in your own settings to have them in every sandbox.';
};

/** A project mapped at boot besides the launch folder, with its effective config. */
export interface BootWant { name: string; config: Config }

export interface Widened {
  config: Config;
  /** Setting -> the project it was turned on for. */
  widened: Record<string, string>;
  notes: string[];
}

/**
 * The launch folder's config plus what the other projects mapped at boot want: their allowed .wsb devices, a fixed
 * memory size larger than the launch's, and their mappings (placed with every other mapping at launch).
 * `keepOff`: devices the launch folder's own .sandbox-config.json switched off; they stay off.
 */
export const widenForProjects = (launch: Config, others: BootWant[], opts: { keepOff?: string[]; exists?: (folder: string) => boolean } = {}): Widened => {
  const keepOff = opts.keepOff ?? [];
  const exists = opts.exists ?? ((): boolean => true);
  const config = _.cloneDeep(launch);
  const widened: Record<string, string> = {};
  const notes: string[] = [];
  for (const setting of BOOT_SETTINGS) {
    const by = others.find((o) => _.get(o.config, setting) === true);
    if (!by || _.get(config, setting) === true) continue;
    if (keepOff.includes(setting)) { notes.push(by.name + ' wants ' + (LABELS[setting] ?? setting) + ', but the launch folder\'s .sandbox-config.json switches it off, so it stays off.'); continue; }
    _.set(config, setting, true);
    widened[setting] = by.name;
    notes.push((LABELS[setting] ?? setting) + ' is on in this sandbox (for every project in it): ' + by.name + ' asks for it and you allowed it.');
  }
  for (const o of others) {
    const mem = o.config.sandbox.memoryMb;
    if (typeof mem === 'number' && typeof config.sandbox.memoryMb === 'number' && mem > config.sandbox.memoryMb) config.sandbox.memoryMb = mem;
    for (const m of o.config.mappings) {
      if (config.mappings.some((x) => sameHost(x.host, m.host))) continue;
      if (m.optional && !exists(m.host)) continue;
      if (!exists(m.host)) { notes.push(o.name + ': mapped folder not found, skipped: ' + m.host); continue; }
      // Where it appears (and moving it when that place is taken) is decided with every other mapping at launch.
      config.mappings.push({ ...m, optional: true });
    }
  }
  return { config, widened, notes };
};
