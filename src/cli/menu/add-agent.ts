// "Add an agent": a few questions (how it installs, its name, its package or program) that end in a new entry of
// `harnesses` in your own config file. It is written at once, unless harnesses has unsaved changes in Settings (then
// it joins them). Everything else about the agent (arguments, login folders ...) is edited in Settings > Agents &
// sessions.
import { DEFAULTS } from '../../core/config/index.js';
import { HarnessSchema, NameSchema, describeIssues } from '../../core/schema/index.js';
import type { Harness } from '../../core/types.js';
import { fail } from '../../core/util/index.js';
import type { App } from '../tui/index.js';
import type { ConfigFile } from './settings/config-file.js';
import type { Draft } from './settings/draft.js';
import { askPath } from './settings/path-kind.js';

/** How a new agent gets into the sandbox. */
export type AgentSource = 'npm' | 'uv' | 'host';

/** Nothing wrong with the name (true), or what is wrong. Pure. */
export function agentNameProblem(name: string, taken: readonly string[]): true | string {
  const typed = name.trim();
  if (!typed) return 'Type a name.';
  const parsed = NameSchema.safeParse(typed);
  if (!parsed.success) return 'Use letters, numbers, - and _ only.';
  if (taken.some((t) => t.toLowerCase() === typed.toLowerCase())) return typed + ' is an agent already.';
  return true;
}

/** The command a package usually provides: "@scope/my-agent@latest" gives "my-agent". Pure. */
export function commandFromPackage(pkg: string): string {
  const version = pkg.lastIndexOf('@');
  const bare = version > 0 ? pkg.slice(0, version) : pkg;
  return (bare.split(/[\\/]/).pop() ?? '').replace(/[^A-Za-z0-9._-]/g, '');
}

/** The config entry for a new agent. Pure. */
export function newAgent(source: AgentSource, what: string, command: string, hostDir = 'auto'): Harness {
  const common = { arguments: [], environment: {} };
  if (source === 'npm') return { ...common, npmPackage: what, npmBin: command };
  if (source === 'uv') return { ...common, uvPackage: what, uvBin: command };
  return { ...common, hostExecutable: what, hostDir };
}

/** What `harnesses` should say with `name` taken out. Pure. */
export function withoutAgent(current: unknown, name: string): Record<string, unknown> {
  const rest = { ...(current && typeof current === 'object' ? (current as Record<string, unknown>) : {}) };
  delete rest[name];
  return rest;
}

/** Writes a setting to your config file now, or adds it to the unsaved changes when it has some already. */
export function writeOrStage(file: ConfigFile, draft: Draft, key: string[], value: unknown): { saved: boolean } {
  if (draft.has(file, key)) {
    draft.stage(file, key, value);
    return { saved: false };
  }
  const result = file.set(key, value);
  if (typeof result === 'object') fail('It could not be saved: ' + result.problems.join('; '));
  return { saved: true };
}

/** What `harnesses` should say with `name` added to what is staged or in the file now. Pure. */
export function withAgent(current: unknown, name: string, harness: Harness): Record<string, unknown> {
  return { ...(current && typeof current === 'object' ? (current as Record<string, unknown>) : {}), [name]: harness };
}

/** The staged value of a setting, else what your own file says (what `harnesses` or `defaultHarness` will be). */
function current(file: ConfigFile, draft: Draft, key: string[]): unknown {
  return draft.has(file, key) ? draft.value(file, key) : file.valueInFile(key);
}

/** Makes `name` the agent that starts by default (written now, or joined to unsaved changes to that setting). */
export function makeDefaultAgent(file: ConfigFile, draft: Draft, name: string): { saved: boolean } {
  return writeOrStage(file, draft, ['defaultHarness'], name);
}

/** Takes an agent you added out of your settings (the built-in ones are not removable). */
export function removeAgent(file: ConfigFile, draft: Draft, name: string): { saved: boolean } {
  if (name in DEFAULTS.harnesses) fail(name + ' is built in, so it cannot be removed.');
  const key = ['harnesses'];
  const standing = current(file, draft, ['defaultHarness']) ?? file.userConfig().defaultHarness;
  if (standing === name) fail(name + ' is the default agent.', 'Make another agent the default first.');
  const rest = withoutAgent(current(file, draft, key), name);
  // Nothing of your own left: the setting goes (the built-in agents need no line).
  return writeOrStage(file, draft, key, Object.keys(rest).length ? rest : undefined);
}

export interface AddedAgent {
  readonly name: string;
  /** Written to your config file now (false: waiting for Ctrl+S with the other unsaved changes). */
  readonly saved: boolean;
}

export class AddAgent {
  constructor(
    private readonly app: App,
    private readonly file: ConfigFile,
    private readonly draft: Draft,
    /** Every agent that exists now (the new name must be different). */
    private readonly taken: readonly string[],
  ) {}

  /** Asks, then adds the agent. Undefined when you backed out. */
  async run(): Promise<AddedAgent | undefined> {
    const path = ['Agents', 'Add an agent'];
    const source = await this.app.choose<AgentSource>(path, 'How does the agent get into the sandbox?', [
      {
        value: 'npm',
        label: 'An npm package',
        description: 'Installed inside the sandbox with npm once and kept (e.g. @openai/codex).',
      },
      {
        value: 'uv',
        label: 'A Python package',
        description: 'Installed inside the sandbox with uv once and kept (e.g. aider-chat).',
      },
      {
        value: 'host',
        label: 'A program on this PC',
        description: 'An .exe copied from this PC into the sandbox (looked up on PATH and in ~/.local/bin).',
      },
    ]);
    if (!source) return undefined;
    const name = await this.app.text({
      path,
      label: 'Name of the agent',
      about: ['What you type after "sandbox", e.g. sandbox <name>. Letters, numbers, - and _.'],
      validate: (v) => agentNameProblem(v, this.taken),
    });
    if (!name) return undefined;
    if (source === 'host') {
      const exe = await askPath(this.app, {
        path,
        title: 'Choose the program (.exe)',
        about: ['The agent program on this PC. It is copied into the sandbox. A bare file name is looked up on PATH.'],
        kind: 'file',
        validate: (v) => (v.trim() ? true : 'Choose a file.'),
      });
      if (!exe) return undefined;
      const slash = Math.max(exe.lastIndexOf('\\'), exe.lastIndexOf('/'));
      const dir = slash > 0 ? exe.slice(0, slash) : 'auto';
      return this.add(name.trim(), newAgent('host', exe.slice(slash + 1), '', dir));
    }
    const what = await this.app.text({
      path,
      label: source === 'npm' ? 'npm package' : 'Python package',
      about: [
        source === 'npm'
          ? 'The package to install, optionally with a version: @scope/name or name@latest.'
          : 'The package for `uv tool install`.',
      ],
      validate: (v) => (v.trim() ? true : 'Type it.'),
    });
    if (!what) return undefined;
    const command = await this.app.text({
      path,
      label: 'Command',
      about: ['The command the package provides; it is what runs inside the sandbox.'],
      initial: commandFromPackage(what.trim()),
      validate: (v) => (/^[A-Za-z0-9._-]+$/.test(v.trim()) ? true : 'Letters, numbers, . - and _ only.'),
    });
    if (!command) return undefined;
    return this.add(name.trim(), newAgent(source, what.trim(), command.trim()));
  }

  /** Validates and writes (or stages) the entry. */
  private add(name: string, harness: Harness): AddedAgent {
    const checked = HarnessSchema.safeParse(harness);
    if (!checked.success) fail('That agent is not valid: ' + describeIssues(checked.error).join('; '));
    const key = ['harnesses'];
    return {
      name,
      ...writeOrStage(this.file, this.draft, key, withAgent(current(this.file, this.draft, key), name, harness)),
    };
  }
}
