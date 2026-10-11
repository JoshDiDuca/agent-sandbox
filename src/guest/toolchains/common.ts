// Shared plumbing for the toolchain installers. Everything lives in C:\AgentData\tools (persistent), so only the first
// boot downloads; later boots only put things on PATH.
import fs from 'node:fs';
import path from 'node:path';
import { errMsg, execOutput, setSandboxStatus, toolsDir, warn } from '../env.js';

/** What the toolchains contribute to the agent's environment. */
export interface ToolEnv { vars: Record<string, string>; prepend: string[]; append: string[]; summary: string[] }
export const emptyEnv = (): ToolEnv => ({ vars: {}, prepend: [], append: [], summary: [] });

export const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
export const tool = (...parts: string[]): string => path.join(toolsDir, ...parts);

/** First x.y.z in a tool's `--version` output. */
export const versionOf = (exe: string, args: string[] = ['--version'], options = {}): string => /\d+\.\d+\.\d+\S*/.exec(execOutput(exe, args, options))?.[0] ?? 'installed';

const resolvedFile = (): string => tool('resolved-versions.json');
const remembered = (): Record<string, string> => { try { return JSON.parse(fs.readFileSync(resolvedFile(), 'utf8')) as Record<string, string>; } catch { return {}; } };

let offline = false;

/**
 * Resolves a version online and remembers it, so an offline boot reuses what was installed last time. After one failed
 * lookup the rest go straight to the remembered versions instead of each waiting for the network.
 */
export const resolveCached = async (key: string, resolve: () => Promise<string>): Promise<string> => {
  const cached = remembered()[key];
  if (offline && cached) return cached;
  try {
    const value = await resolve();
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(resolvedFile(), JSON.stringify({ ...remembered(), [key]: value }, null, 2));
    return value;
  } catch (e) {
    offline = true;
    if (!cached) throw e;
    warn('Could not look up ' + key + ' online (' + errMsg(e) + '); using ' + cached + ' from the last boot.');
    return cached;
  }
};

/** Runs one installer; a failure is reported and skipped so it never blocks the other toolchains. */
export const step = async (name: string, env: ToolEnv, work: () => Promise<void>): Promise<void> => {
  setSandboxStatus('provisioning', 'Setting up ' + name);
  try { await work(); } catch (e) { warn(name + ' setup failed (continuing without it): ' + errMsg(e)); env.summary.push(name + ': FAILED'); }
};
