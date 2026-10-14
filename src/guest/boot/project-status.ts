// run\projects\<name>.json: how far each project's provisioning is, for `sandbox status` and the host's progress lines.
import type { DatabasePlan } from '../../core/types.js';
import type { ProjectStatus } from '../../shared/channel/schema.js';
import { now } from '../../shared/channel/run-dir.js';
import { writeJsonAtomic } from '../../shared/io/json.js';
import { hubName } from '../../shared/paths/projects.js';
import { run } from '../runtime/paths.js';
import { session } from '../runtime/session.js';
import { warn } from '../runtime/log.js';
import { errMsg } from '../../core/util/errors.js';

/** The launch folder's project id (older launch folders: derived from its name). */
export function primaryProject(): string {
  return session.projectId ?? hubName(session.workspaceHost || session.project, []);
}

export function saveProjectStatus(
  name: string,
  workspace: string,
  phase: ProjectStatus['phase'],
  message: string,
  databases: DatabasePlan[],
  summary: string[],
): void {
  try {
    writeJsonAtomic(run.projectFile(name), {
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
    } satisfies ProjectStatus);
  } catch (e) {
    warn('Could not write the status of project ' + name + ': ' + errMsg(e));
  }
}
