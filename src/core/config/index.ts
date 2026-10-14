// Built-in defaults and loading the user config (~/.agent-sandbox/config.json). Shapes live in schema.ts.
export { DEFAULTS } from './defaults.js';
export {
  userDir,
  userConfigPath,
  machineRoot,
  machineConfigPath,
  mergeConfig,
  validateConfig,
  loadConfig,
  assertNoGuestOverlap,
} from './loader.js';
