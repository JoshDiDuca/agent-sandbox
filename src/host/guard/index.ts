export type { GitState, RepoFinding, RepoSnapshot } from './types.js';
export { RepoGuard } from './repo-guard.js';
export { RepoGuardStore, type RecordedFinding } from './store.js';
export { RISKY, isMarked, markFromSandbox, watchAndMark } from './mark-of-the-web.js';
export { readDataSize, readMarkedProjects, saveDataSize, saveMarkedProjects } from './watch-state.js';
