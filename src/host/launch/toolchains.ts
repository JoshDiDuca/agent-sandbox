import type { GenerateOptions } from '../../core/types.js';
import { decideToolchains, readPwshScripts, usesPwsh } from '../../core/detect/index.js';
import { pcLanguages } from './pc-scan.js';
import { msvcHint, projectEntries, uvHint } from './project-scan.js';

/** Which toolchains the project needs ("auto" settings follow the project's files and what this PC has). */
export function decideProjectToolchains(
  o: Pick<GenerateOptions, 'run' | 'pcLanguages'>,
): ReturnType<typeof decideToolchains> {
  const { config, workspaceHost } = o.run;
  const msvcScript = config.toolchains.msvc.enabled === 'auto' ? msvcHint(workspaceHost) : undefined;
  const pwshScript = config.toolchains.pwsh.enabled === 'auto' ? usesPwsh(readPwshScripts(workspaceHost)) : null;
  // claude-mem (synced into the sandbox for the claude agent) needs Bun, and uv for its search index.
  const memNeeds = o.run.harnessName === 'claude' && config.claudeProfile.enabled && config.claudeProfile.syncClaudeMem;
  const memHint = memNeeds ? 'claude-mem needs it' : undefined;
  const uvScript = config.toolchains.uv.enabled === 'auto' ? uvHint(workspaceHost) : undefined;
  const uvText = uvScript ?? memHint;
  const hints = {
    ...(msvcScript ? { msvc: msvcScript } : {}),
    ...(pwshScript ? { pwsh: pwshScript } : {}),
    ...(memHint ? { bun: memHint } : {}),
    ...(uvText ? { uv: uvText } : {}),
  };
  return decideToolchains(config.toolchains, projectEntries(workspaceHost), o.pcLanguages ?? pcLanguages(), hints);
}
