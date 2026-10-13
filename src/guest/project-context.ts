// Which project a toolchain step is provisioning. At boot that is the launch folder; the daemon provisions projects
// registered later (another folder on the PC) while other sessions keep running, several at once. Steps read version
// files and markers from projectWorkspace(), and duringSession() tells them to leave machine-wide state alone (the
// nvm symlink, shims, compiled helpers in use) because sessions of other projects depend on it.
import { AsyncLocalStorage } from 'node:async_hooks';
import { workspace } from './env.js';

export interface ProjectContext {
  workspace: string;
  duringSession: boolean;
}

const store = new AsyncLocalStorage<ProjectContext>();

export const withProject = <T>(context: ProjectContext, work: () => Promise<T>): Promise<T> => store.run(context, work);
export const projectWorkspace = (): string => store.getStore()?.workspace ?? workspace;
export const duringSession = (): boolean => store.getStore()?.duringSession ?? false;
