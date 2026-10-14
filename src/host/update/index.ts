export { type ReleaseInfo, type ReleaseSource, GithubReleases, FolderFeed, RELEASE_REPO } from './release-source.js';
export { type SkipReason, type UpdateDecision, type DecisionInput, decideUpdate, isTooSoon } from './decision.js';
export { UpdateStateFile, type UpdateState } from './update-state.js';
export { Updater, type UpdateResult, type RunOptions, type UpdaterOptions } from './updater.js';
