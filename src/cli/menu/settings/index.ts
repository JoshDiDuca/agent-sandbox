export { CATEGORIES, categoryOf, nameOf, SETTINGS_ELSEWHERE } from './categories.js';
export { ConfigFile, editConfigText, fileValue, type SettingChange, type SettingsTarget } from './config-file.js';
export { Draft, type DraftResult } from './draft.js';
export { SchemaNode } from './schema-node.js';
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
