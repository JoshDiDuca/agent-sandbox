// workspaceFilter in practice: which view a launch maps instead of the project, the project's .git mapped beside it,
// and the host-only list of views the background watcher keeps in step while the sandbox runs.

export { IgnoreRules } from './rules.js';
export { WorkspaceView, type SyncStats, type ViewOptions } from './view.js';
export * from './plan.js';
export * from './active-views.js';
