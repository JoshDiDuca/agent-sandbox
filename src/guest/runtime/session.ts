// Shared state for the guest scripts (main, daemon, view): fixed paths, the session description, logging, status.
import fs from 'node:fs';
import path from 'node:path';
import { setChecksumRequired } from '../../shared/download/index.js';
import type { GuestSession } from '../../core/types.js';
import { launchDir, dataDir } from './paths.js';

export const session = JSON.parse(
  fs.readFileSync(path.join(launchDir, 'session.json'), 'utf8').replace(/^\uFEFF/, ''),
) as GuestSession;
setChecksumRequired(session.downloads?.requireChecksum === true);
export const workspace = process.env.AGENT_WORKSPACE ?? session.workspace;
export const stateDir = path.join(dataDir, session.persistAgentState ? 'state' : 'state-session');
export const claudeDir = path.join(stateDir, 'claude');
