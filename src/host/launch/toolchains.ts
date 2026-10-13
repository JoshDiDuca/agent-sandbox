import type { GenerateOptions } from '../../core/types.js';
import { decideToolchains } from '../../core/detect/index.js';
import { readPwshScripts, usesPwsh } from '../../core/detect/index.js';
import { pcLanguages } from './pc-scan.js';
import { msvcHint, projectEntries } from './project-scan.js';

/** Which toolchains the project needs ("auto" settings follow the project's files and what this PC has). */
export const decideProjectToolchains = (
  o: Pick<GenerateOptions, 'run' | 'pcLanguages'>,
): ReturnType<typeof decideToolchains> => {
  const { config, workspaceHost } = o.run;
  const msvcScript = config.toolchains.msvc.enabled === 'auto' ? msvcHint(workspaceHost) : undefined;
  const pwshScript = config.toolchains.pwsh.enabled === 'auto' ? usesPwsh(readPwshScripts(workspaceHost)) : null;
  const hints = { ...(msvcScript ? { msvc: msvcScript } : {}), ...(pwshScript ? { pwsh: pwshScript } : {}) };
  return decideToolchains(config.toolchains, projectEntries(workspaceHost), o.pcLanguages ?? pcLanguages(), hints);
};
