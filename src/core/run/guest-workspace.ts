import path from 'node:path';

/**
 * 'auto' guest workspace: C:\Workspace\<folder name>. Keeping the real folder name means Claude's per-project history
 * and claude-mem's project name match this PC instead of every project being "Workspace".
 */
export const autoGuestWorkspace = (workspaceHost: string): string => {
  const name = path
    .basename(workspaceHost)
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/^[. ]+|[. ]+$/g, '');
  return 'C:\\Workspace\\' + (name || 'project');
};
