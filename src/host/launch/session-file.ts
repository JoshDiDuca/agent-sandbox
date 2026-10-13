import type { GuestSession, HostProbe } from '../../core/types.js';

/** What was found on this PC to copy instead of download. */
export const hostToolsOf = (probe: HostProbe): GuestSession['hostTools'] => ({
  node: Boolean(probe.nodeDir),
  nodeVersion: probe.nodeDir || probe.nvmNode ? probe.hostNodeVersion.replace(/^v/, '') : null,
  harnessExecutable: probe.harnessExe?.file ?? null,
  git: Boolean(probe.gitDir),
  nvm: Boolean(probe.nvmDir),
  volta: Boolean(probe.volta),
  pyenv: Boolean(probe.pyenv),
});

/**
 * env.cmd, which logon.cmd calls before it opens Windows Terminal: Terminal expands "%AGENT_WORKSPACE%" (the starting
 * folder of new tabs) from its own environment, and the runtime only sets the variable machine-wide after Terminal
 * started. `%` is doubled for cmd; a Windows path holds no quotes.
 */
export const logonEnv = (workspace: string): string =>
  '@set "AGENT_WORKSPACE=' + workspace.replace(/[\r\n"]/g, '').replace(/%/g, '%%') + '"\r\n';
