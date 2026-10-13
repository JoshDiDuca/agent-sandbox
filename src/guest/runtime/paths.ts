import path from 'node:path';
import { RunDir } from '../../shared/channel/run-dir.js';

export const isWin = process.platform === 'win32';
export const dryRun = process.env.AGENT_DRY_RUN === '1';
/** Real provisioning, but nothing machine-wide (environment variables): for end-to-end tests outside a sandbox. */
export const testMode = process.env.AGENT_SANDBOX_TEST === '1';
export const launchDir = process.env.AGENT_LAUNCH_DIR ?? 'C:\\AgentLaunch';
export const dataDir = process.env.AGENT_DATA_DIR ?? 'C:\\AgentData';
export const hostToolsDir = process.env.AGENT_HOST_TOOLS_DIR ?? 'C:\\HostTools';
/** Folders that must stay on the sandbox's own disk (symlinks, SQLite) rather than in a mapped folder. */
export const localDir = process.env.AGENT_LOCAL_DIR ?? 'C:\\nvm';
export const toolsDir = path.join(dataDir, 'tools');
export const logsDir = path.join(dataDir, 'logs');
export const run = new RunDir(dataDir);
