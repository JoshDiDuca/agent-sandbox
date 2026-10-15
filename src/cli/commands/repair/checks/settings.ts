// Settings: does config.json load, are the updates to your saved settings done, and are the project files you approved
// still the ones you approved. A settings file that does not load can be put back from the copy an update saved
// (the broken one is kept beside it).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, mergeConfig, validateConfig } from '../../../../core/config/index.js';
import { trustStorePath } from '../../../../core/local-config/index.js';
import { errMsg, readJsonc, tryReadJson, type UserError } from '../../../../core/util/index.js';
import { configBackups, lineDiff, type ConfigBackup } from '../../../../host/health/index.js';
import { assertTestWritable } from '../../../../host/test-guard.js';
import { MigrateService } from '../../../services/migrate-service.js';
import type { Check, Finding, FixOutcome, RepairEnv } from '../types.js';
import { ok, plural } from './common.js';

const MAX_PROJECT_FILE_BYTES = 1024 * 1024;

/** The newest saved copy of the settings file that itself loads. */
function goodBackup(env: RepairEnv): ConfigBackup | null {
  return (
    configBackups(env.storageRoot, env.configFile).find((b) => {
      try {
        validateConfig(mergeConfig(DEFAULTS, readJsonc<unknown>(b.copy)), b.copy);
        return true;
      } catch {
        return false;
      }
    }) ?? null
  );
}

const messageOf = (e: UserError): string => e.message.split('\n')[0] + (e.fix ? ' ' + e.fix : '');

/** The files in <storage>\trusted-configs.json whose approval no longer matches the file (hash differs). */
function changedApprovals(storageRoot: string): string[] {
  const store = tryReadJson<Record<string, unknown>>(trustStorePath(storageRoot));
  if (!store || typeof store !== 'object') return [];
  const changed: string[] = [];
  for (const [file, hash] of Object.entries(store)) {
    if (typeof hash !== 'string' || !path.isAbsolute(file)) continue;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_PROJECT_FILE_BYTES) continue;
      if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== hash) changed.push(file);
    } catch {
      // the project is gone or not readable: nothing to compare
    }
  }
  return changed;
}

export const SETTINGS_CHECKS: Check[] = [
  {
    id: 'settings-config',
    group: 'Settings',
    name: 'Settings file',
    run: (env: RepairEnv): Finding => {
      const error = env.configError;
      if (!error)
        return ok(
          env.ctx.loaded.configPath
            ? env.ctx.loaded.configPath + ' is valid'
            : 'no settings file; the built-in defaults apply',
        );
      const base = {
        status: 'needs-you' as const,
        detail: messageOf(error),
        means:
          'Every command that reads your settings stops until this is fixed (built-in defaults were used for the other checks).',
      };
      let backup: ConfigBackup | null = null;
      try {
        backup = fs.existsSync(env.configFile) ? goodBackup(env) : null;
      } catch (e) {
        return {
          ...base,
          fix: 'Fix ' + env.configFile + ' by hand (the backups could not be read: ' + errMsg(e) + ').',
        };
      }
      if (!backup)
        return {
          ...base,
          fix: 'Open ' + env.configFile + ' and correct what is listed, or delete it to start again with the defaults.',
        };
      const diff = lineDiff(fs.readFileSync(env.configFile, 'utf8'), fs.readFileSync(backup.copy, 'utf8'));
      return {
        ...base,
        plan:
          'put back the settings saved before the update ' +
          backup.label +
          ' (your current file is kept as config.json.broken-...)',
        lines: [
          'Changes from your file (-) to the saved copy (+):',
          ...(diff.length ? diff : ['(the files read the same)']),
        ],
        data: backup.copy,
      };
    },
    fix: (env: RepairEnv, finding: Finding): FixOutcome => {
      const copy = String(finding.data);
      assertTestWritable(env.configFile);
      const kept = env.configFile + '.broken-' + new Date(env.now()).toISOString().replace(/\D/g, '').slice(0, 14);
      fs.copyFileSync(env.configFile, kept);
      fs.copyFileSync(copy, env.configFile);
      // The engine looks again after the fix; the config is read from the file, not from the earlier error.
      env.configError = null;
      try {
        validateConfig(mergeConfig(DEFAULTS, readJsonc<unknown>(env.configFile)), env.configFile);
      } catch (e) {
        env.configError = e as UserError;
      }
      return {
        done:
          'put the saved settings back in ' + env.configFile + '; the broken file is kept as ' + path.basename(kept),
      };
    },
  },
  {
    id: 'settings-updates',
    group: 'Settings',
    name: 'Saved settings up to date',
    run: (env: RepairEnv): Finding => {
      const service = new MigrateService(
        { storageRoot: env.storageRoot, userDir: env.userDir, configPath: env.ctx.loaded.configPath },
        undefined,
        env.migrations,
        () => env.running,
      );
      let pending: string[];
      try {
        pending = service.plan();
      } catch (e) {
        return {
          status: 'needs-you',
          detail: errMsg(e),
          means: 'The record of which updates ran is damaged, so none can be applied.',
        };
      }
      if (!pending.length) return ok('nothing waits');
      return {
        status: 'needs-you',
        detail: plural(pending.length, 'change') + ' to your saved settings wait',
        means: 'This version expects your settings in a newer form.',
        plan: 'bring your saved settings up to date (a backup is made first)',
        lines: pending,
      };
    },
    fix: async (env: RepairEnv): Promise<FixOutcome> => {
      const service = new MigrateService(
        { storageRoot: env.storageRoot, userDir: env.userDir, configPath: env.ctx.loaded.configPath },
        undefined,
        env.migrations,
        () => env.running,
      );
      const notes: string[] = [];
      const result = await service.run((line) => notes.push(line));
      return {
        done:
          (result.applied.length ? 'applied ' + result.applied.join(', ') : 'applied nothing') +
          (result.postponed.length ? '; ' + result.postponed.join(', ') + ' wait until no sandbox runs' : ''),
      };
    },
  },
  {
    id: 'settings-approvals',
    group: 'Settings',
    name: 'Approved project files',
    run: (env: RepairEnv): Finding => {
      const changed = changedApprovals(env.storageRoot);
      if (!changed.length) return ok('every project file you approved is unchanged');
      return {
        status: 'warn',
        detail:
          plural(changed.length, 'project file') +
          ' changed since you approved ' +
          (changed.length === 1 ? 'it' : 'them'),
        means:
          'Its settings are ignored until you approve the new version; the next launch in that project asks again.',
        fix: 'Nothing to repair. Read the changes, then run sandbox in that project and answer the question (or sandbox config check).',
        lines: changed,
      };
    },
  },
];
