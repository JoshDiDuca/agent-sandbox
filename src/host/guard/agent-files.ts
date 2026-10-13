import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { fileExists, isLink } from '../../core/util/index.js';
import { hash } from './file-hash.js';
import type { RepoFinding } from './repo-guard.js';

/**
 * Project files that tools on this PC act on by themselves: Claude Code runs a project's hooks, helpers and MCP servers,
 * VS Code runs folder-open tasks and the programs workspace settings point at, direnv runs .envrc. For each, only the
 * part that can run something is compared (`risky`), so the agent may still edit the rest (permissions, formatting).
 */
const AGENT_FILES: Record<string, (data: unknown, text: string) => unknown> = {
  '.claude/settings.json': (d) => claudeRisk(d),
  '.claude/settings.local.json': (d) => claudeRisk(d),
  '.mcp.json': (_d, text) => text,
  '.vscode/tasks.json': (d) => (JSON.stringify(d).match(/"runOn"\s*:\s*"folderOpen"/) ? d : null),
  '.vscode/settings.json': (d) =>
    _.pickBy(_.isPlainObject(d) ? (d as object) : {}, (_v, k) =>
      /path|executable|command|interpreter|shell|profile|args|env|exec|program|server|launch|runtime|binary/i.test(k),
    ),
  '.envrc': (_d, text) => text,
};
const claudeRisk = (d: unknown): unknown => {
  const s = (_.isPlainObject(d) ? d : {}) as Record<string, unknown>;
  const permissions = (_.isPlainObject(s.permissions) ? s.permissions : {}) as Record<string, unknown>;
  return {
    ..._.pick(s, [
      'hooks',
      'apiKeyHelper',
      'awsAuthRefresh',
      'awsCredentialExport',
      'otelHeadersHelper',
      'statusLine',
      'env',
      'enableAllProjectMcpServers',
      'enabledMcpjsonServers',
      'disableAllHooks',
    ]),
    permissions: _.pick(permissions, ['defaultMode', 'additionalDirectories']),
  };
};
const MAX_AGENT_FILE_BYTES = 1024 * 1024;

/** What can run in one agent file, as a short fingerprint (null = the file is not there). */
const agentRisk = (workspace: string, rel: string): string | null => {
  const file = path.join(workspace, ...rel.split('/'));
  if (!fs.existsSync(file)) return null;
  if (isLink(file) || isLink(path.dirname(file)) || !fileExists(file)) return 'link-or-not-a-file';
  if (fs.statSync(file).size > MAX_AGENT_FILE_BYTES) return 'too-large-' + hash(file);
  const text = fs.readFileSync(file, 'utf8');
  const errors: ParseError[] = [];
  const data = parseJsonc(text, errors, { allowTrailingComma: true });
  const risk = AGENT_FILES[rel](rel === '.envrc' ? null : data, text);
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(risk ?? null) + (errors.length && rel !== '.envrc' && rel !== '.mcp.json' ? hash(file) : ''))
    .digest('hex');
};
export const agentSnapshot = (workspace: string): Record<string, string> =>
  Object.fromEntries(
    Object.keys(AGENT_FILES).flatMap((rel) => {
      const r = agentRisk(workspace, rel);
      return r ? [[rel, r]] : [];
    }),
  );

/** Agent files whose runnable part changed are moved to the quarantine folder (the rest of your edits are in there too). */
export const guardAgentFiles = (workspace: string, before: Record<string, string>): RepoFinding[] => {
  const changed = Object.keys(AGENT_FILES).filter((rel) => {
    const now = agentRisk(workspace, rel);
    return now !== null && now !== before[rel];
  });
  if (!changed.length) return [];
  const target = path.join(workspace, 'agent-sandbox-quarantine', String(Date.now()));
  fs.mkdirSync(target, { recursive: true });
  return changed.map((rel) => {
    const what =
      rel + ' (the sandbox added something it would run on this PC: hooks, MCP servers, helper commands or tasks';
    try {
      fs.renameSync(path.join(workspace, ...rel.split('/')), path.join(target, rel.replace(/\//g, '_')));
    } catch (e) {
      return {
        kind: 'agent' as const,
        detail:
          what +
          '; could not be moved: ' +
          (e as NodeJS.ErrnoException).code +
          '. Check it before you open this folder in Claude Code or VS Code)',
      };
    }
    return { kind: 'agent' as const, detail: what + '; moved to ' + target + ')' };
  });
};
