// What a health check is, what it finds and what a fix reports. doctor only looks; repair looks, lists what it would
// change, and (after a yes) changes it.
import type { UserError } from '../../../core/util/index.js';
import type { InstallLayout, InstallRecord } from '../../../host/install/index.js';
import type { SystemProbe } from '../../../host/health/index.js';
import type { MachineFacts } from '../setup/facts.js';
import type { Migration } from '../../../host/migrate/index.js';
import type { Context } from '../context.js';

export type RepairStatus = 'ok' | 'fixed' | 'needs-you' | 'warn' | 'skipped';

/** The headings the output is grouped under, in the order they are shown. */
export const CHECK_GROUPS = [
  'This PC',
  'Install',
  'Data folder',
  'Settings',
  'Sandbox',
  'Agents & tools',
  'Network',
] as const;
export type CheckGroup = (typeof CHECK_GROUPS)[number];

/** The short form of a result (the menu shows these). */
export interface RepairResult {
  name: string;
  status: RepairStatus;
  detail: string;
}

/** What a check's run() finds. */
export interface Finding {
  /** ok, a warning (nothing to do now), something you need to do, or not checked. */
  status: 'ok' | 'warn' | 'needs-you' | 'skipped';
  /** One line: what was found. */
  detail: string;
  /** What it means for you (shown when not ok). */
  means?: string;
  /** What to do about it yourself, when repair cannot (a command or a step). */
  fix?: string;
  /** What repair would change, in a few words ("remove 2 stale records"). Set only when fix() can mend this. */
  plan?: string;
  /** More lines shown under the plan when repair lists what it will change (a diff, the folders). */
  lines?: string[];
  /** Handed to fix() unchanged: what run() decided (the folders to remove ...). */
  data?: unknown;
}

/** What a fix reports: what it changed. The before/after lines come from running the check again. */
export interface FixOutcome {
  done: string;
}

export interface Check {
  /** Stable id (kebab-case): used in --json and the repair log. */
  id: string;
  group: CheckGroup;
  /** Short label for the result line ("Data folder"). */
  name: string;
  /** "the data folder" in "Checking the data folder..."; the lower-cased name when left out. */
  checking?: string;
  /** Not shown at all when it returns false (an all-users check on another install). */
  applies?: (env: RepairEnv) => boolean;
  /** Slower checks (the network, Windows tools) say how long they may take; the default is 20 seconds. */
  timeoutMs?: number;
  /** look: do not even look while a sandbox runs (the folders are in use). fix: look, but fix only when none runs. */
  needsIdle?: 'look' | 'fix';
  run: (env: RepairEnv) => Finding | Promise<Finding>;
  fix?: (env: RepairEnv, finding: Finding) => FixOutcome | Promise<FixOutcome>;
}

export interface CheckResult extends RepairResult {
  id: string;
  group: CheckGroup;
  means?: string;
  fix?: string;
  plan?: string;
  lines?: string[];
  /** Repair can mend this one (a plan exists and the check has a fix). */
  fixable: boolean;
  timedOut?: boolean;
  /** Milliseconds the look took. */
  ms: number;
  /** After a fix: what was changed, and what the check said before. */
  applied?: { done: string; before: string; after: string };
  /** After a fix that failed: why. */
  error?: string;
}

export interface Summary {
  total: number;
  ok: number;
  fixed: number;
  warn: number;
  needsYou: number;
  skipped: number;
  /** Results repair could still mend. */
  fixable: number;
}

/** Everything the checks read, in one place: injectable, so tests point it at temp folders. */
export interface RepairEnv {
  ctx: Context;
  running: boolean;
  dataPath: string;
  storageRoot: string;
  toolsDir: string;
  configError: UserError | null;
  /** The managed install this program runs from, or null (npm). */
  layout: InstallLayout | null;
  /** install.json of that install. */
  record: InstallRecord | null;
  /** %ProgramData%\AgentSandbox (the PC-wide folder of an all-users install). */
  machineHome: string;
  /** ~/.agent-sandbox: the settings file and what belongs to it. */
  userDir: string;
  /** The settings file in use (--config, AGENT_SANDBOX_CONFIG, else <userDir>\config.json). */
  configFile: string;
  /** The settings updates that exist (a test gives its own). */
  migrations: readonly Migration[];
  /** The user-scope install folder next to an all-users one (checked for leftovers). */
  userInstallRoot: string | null;
  system: SystemProbe;
  now: () => number;
  /** What `sandbox setup` learns about this PC (looked up once, the first time a check asks). */
  facts: () => MachineFacts;
}

/** For fixes that must not touch folders a running sandbox may be using. */
export const WHILE_RUNNING = 'a sandbox is running and may be using it; run repair again once it is closed';
