// The menu's settings editing: staged changes (Ctrl+S saves them), sharing settings, and the editors for each kind of
// value. What the settings are, their files and rows live in the settings feature (src/app/features/settings).
export { Draft, type DraftResult } from './draft.js';
export {
  diffText,
  exportSettings,
  planImport,
  skippedLine,
  type DiffLine,
  type ImportPlan,
  type Pruned,
  type Skipped,
} from './share.js';
