// Claude Code managed settings for the sandbox (C:\Program Files\ClaudeCode\managed-settings.json). Managed settings
// have the highest precedence and cannot be overridden by user or project settings, so they carry the hard rules:
// today, the git access mode. Rewritten every boot; removed when there is nothing to enforce.
import fs from 'node:fs';
import path from 'node:path';
import type { GitAccess } from '../../core/types.js';
import { gitDenyRules } from './git-rules.js';
import { managedClaudeMd } from '../boot/guide.js';

export const managedSettingsFile = (): string => path.join(path.dirname(managedClaudeMd()), 'managed-settings.json');

export const writeManagedSettings = (access: GitAccess): void => {
  const file = managedSettingsFile();
  const deny = gitDenyRules(access);
  if (deny.length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ permissions: { deny } }, null, 2) + '\n', 'utf8');
};
