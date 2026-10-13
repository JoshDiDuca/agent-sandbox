// run\projects\<name>.json: how far each project's provisioning is, for `sandbox status` and the host's progress lines.
import type { DatabasePlan } from '../core/types.js';
import type { ProjectStatusT } from '../shared/schema.js';
import { now, writeJsonAtomic } from '../shared/rundir.js';
import { hubName } from '../shared/projects.js';
import { errMsg, run, session, warn } from './env.js';

/** The launch folder's project id (older launch folders: derived from its name). */
export const primaryProject = (): string => session.projectId ?? hubName(session.workspaceHost || session.project, []);

export const saveProjectStatus = (
  name: string,
  workspace: string,
  phase: ProjectStatusT['phase'],
  message: string,
  databases: DatabasePlan[],
  summary: string[],
): void => {
  try {
    writeJsonAtomic(run.project(name), {
      name,
      workspace,
      phase,
      message: message.slice(0, 3500),
      updatedAt: now(),
      databases: databases
        .filter((d) => d.database !== 'sqlserver')
        .slice(0, 16)
        .map((d) => ({ database: d.database, port: d.port })),
      summary: summary.slice(0, 64).map((s) => s.slice(0, 500)),
    } satisfies ProjectStatusT);
  } catch (e) {
    warn('Could not write the status of project ' + name + ': ' + errMsg(e));
  }
};
