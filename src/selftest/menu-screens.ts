// Draws every menu screen with made-up data through the same pure functions the menu uses, at two terminal sizes, as
// plain text for reading (the menu-screens review file). No terminal, no sandbox, no services.
import fs from 'node:fs';
import path from 'node:path';
import { Draft } from '../cli/menu/settings/draft.js';
import { ConfigFile } from '../cli/menu/settings/config-file.js';
import { AppsModel } from '../cli/menu/apps.js';
import { accountsOptions } from '../cli/menu/pages/accounts-page.js';
import { appsOptions } from '../cli/menu/pages/apps-page.js';
import { maintenanceOptions, type MaintenanceModel } from '../cli/menu/pages/maintenance-page.js';
import { sandboxOptions, type SandboxModel } from '../cli/menu/pages/sandbox-page.js';
import { sessionsOptions } from '../cli/menu/pages/sessions-page.js';
import { settingsOf, settingsOptions } from '../cli/menu/pages/settings-page.js';
import { startOptions } from '../cli/menu/pages/start-page.js';
import { TAB_LABELS } from '../cli/menu/shell.js';
import type { ListedSession } from '../cli/services/index.js';
import { Frame, ListScreen, OverlayScreen, Text, type ListOptions } from '../cli/tui/index.js';

const SIZES = [
  { width: 100, height: 30 },
  { width: 80, height: 24 },
];

const NOW = Date.now();

const SESSIONS = [
  {
    id: '1791927991435-aa11bb',
    harness: 'claude',
    cwd: 'C:\\Projects\\api',
    phase: 'running',
    startedAt: new Date(NOW - 12 * 60000).toISOString(),
    projectName: 'api',
    here: true,
    viewers: { remote: 1, viewers: 1 },
  },
  {
    id: '1791927991436-cc22dd',
    harness: 'codex',
    cwd: 'C:\\Projects\\web',
    phase: 'running',
    startedAt: new Date(NOW - 95 * 60000).toISOString(),
    projectName: 'web',
    here: false,
    viewers: { remote: 0, viewers: 0 },
  },
] as unknown as ListedSession[];

/** Frame for one screen: the tabs, a status line, the list, the keys. */
function draw(
  active: number,
  options: ListOptions<string>,
  size: { width: number; height: number },
  status = '',
  unsaved = 0,
): string[] {
  const body = { width: size.width, height: Frame.bodyHeight(size.height, true) };
  const parts = new ListScreen(options).render(body);
  return Frame.render(
    {
      ...parts,
      keys: unsaved ? [['ctrl+s', 'save (' + unsaved + ')', 0], ...parts.keys] : parts.keys,
      status: (unsaved ? 'unsaved: ' + unsaved + '   ' : '') + (parts.status ?? status),
      tabs: { tabs: TAB_LABELS.map((label) => ({ label })), active },
    },
    size.width,
    size.height,
  ).map((l) => Text.strip(l).replace(/\s+$/, ''));
}

function block(title: string, lines: string[], size: { width: number; height: number }): string {
  return ['=== ' + title + ' (' + size.width + 'x' + size.height + ') ===', ...lines, ''].join('\n');
}

/** All screens, at both sizes, as one text. `dir` is a scratch folder for the made-up config files. */
export function renderScreens(dir: string): string {
  const user = ConfigFile.user(path.join(dir, 'config.json'));
  fs.mkdirSync(path.join(dir, 'project'), { recursive: true });
  const project = ConfigFile.project(path.join(dir, 'project'));
  const files = { user, project };
  const draft = new Draft();
  const status = 'Sandbox running · 2 sessions   C:\\Projects\\api';
  const sandbox: SandboxModel = {
    report: {
      sandbox: {
        running: true,
        phase: 'ready',
        message: undefined,
        headless: true,
        startedAt: NOW - 3 * 3600000,
        daemon: 'pong',
        account: 'work',
        syncWatcher: true,
      },
      here: { folder: 'C:\\Projects\\api', project: 'api', guest: 'C:\\Projects\\api' },
      roots: [],
      projects: [],
      otherSessions: [],
      repoGuard: { guarded: 2, findings: [] },
    },
    projects: {
      all: true,
      roots: ['C:\\Projects'],
      exclude: [],
      projects: [
        {
          folder: 'C:\\Projects\\api',
          here: true,
          known: true,
          root: 'C:\\Projects',
          excluded: false,
          mappedAtStart: true,
          running: 'api (root)',
        },
        {
          folder: 'F:\\Code\\scratch',
          here: false,
          known: true,
          root: null,
          excluded: false,
          mappedAtStart: true,
          running: null,
        },
      ],
    },
    databases: [
      { name: 'postgres', running: true, port: 5432, title: 'PostgreSQL 18' },
      { name: 'redis', running: false, port: 6379, title: 'Redis' },
    ],
  };
  const maintenance: MaintenanceModel = {
    data: {
      entries: [
        { area: 'tools', name: 'rust', path: 'C:\\AgentData\\tools\\rust', bytes: 4.6e9 },
        { area: 'tools', name: 'vscode', path: 'C:\\AgentData\\tools\\vscode', bytes: 2.5e9 },
        { area: 'state', name: 'state/claude', path: 'C:\\AgentData\\state\\claude', bytes: 1.8e9 },
        { area: 'host', name: 'accounts', path: 'C:\\Users\\me\\AppData\\Local\\AgentSandbox\\accounts', bytes: 4096 },
      ],
      disks: [{ drive: 'C:\\', totalBytes: 40e9, freeBytes: 22e9, usedBytes: 18e9, holdsStorage: true }],
      total: 8.9e9,
    },
    logs: [
      { name: 'guest-2026-10-14.log', path: 'x', bytes: 120000, modified: NOW - 60000 },
      { name: 'daemon-2026-10-14.log', path: 'y', bytes: 8000, modified: NOW - 600000 },
    ],
    doctor: [
      ['Windows Sandbox', 'available'],
      ['Config file', 'C:\\Users\\me\\.agent-sandbox\\config.json'],
    ],
    repair: [
      { name: 'Config file', status: 'ok', detail: 'valid' },
      { name: 'Stale run folders', status: 'fixed', detail: 'removed 2' },
      { name: 'Toolchain cache', status: 'needs-you', detail: 'close the sandbox first' },
    ],
    setup: {
      facts: {} as never,
      canEnable: true,
      checks: [
        { name: 'Windows edition', status: 'ok', detail: 'Pro' },
        { name: 'Windows Sandbox feature', status: 'action', detail: 'turned off' },
      ],
    },
    more: [
      { name: 'sync', summary: 'sync history now' },
      { name: 'audit', summary: 'show what the sandbox did' },
    ],
  };
  // Two unsaved changes in Settings.
  const settings = settingsOf(user);
  const harness = settings.find((s) => s.key.join('.') === 'defaultHarness');
  const flag = settings.find((s) => s.node.editor === 'boolean');
  if (harness) draft.stage(user, harness.key, 'codex');
  if (flag) draft.stage(user, flag.key, !(user.userConfig() as unknown as Record<string, unknown>)[flag.key[0]]);
  const apps = new AppsModel(user, path.join(dir, 'data'));
  const appsDraft = new Draft();
  apps.stageTicks(appsDraft, ['git-gui']);

  const out: string[] = [];
  for (const size of SIZES) {
    out.push(
      block(
        '1 Start',
        draw(
          0,
          startOptions(
            {
              folder: 'C:\\Projects\\api',
              defaultAgent: 'claude',
              agents: [
                { name: 'claude', ready: true },
                { name: 'codex', ready: false },
                { name: 'gemini', ready: false },
              ],
              last: ['launch', '--harness', 'claude', '--terminal'],
              attach: true,
              window: 'config',
            },
            'C:\\Projects\\api',
          ),
          size,
          status,
        ),
        size,
      ),
      block('2 Sessions', draw(1, sessionsOptions({ sandboxRunning: true, sessions: SESSIONS }), size, status), size),
      block('2 Sessions (no sandbox)', draw(1, sessionsOptions({ sandboxRunning: false, sessions: [] }), size), size),
    );
    for (const category of ['status', 'projects', 'databases'])
      out.push(
        block(
          '3 Sandbox · ' + category,
          draw(2, { ...sandboxOptions(sandbox), startCategory: category }, size, status),
          size,
        ),
      );
    out.push(
      block(
        '4 Apps (1 unsaved)',
        draw(3, appsOptions(apps, user, appsDraft, 'user'), size, status, appsDraft.count()),
        size,
      ),
      block(
        '5 Settings (2 unsaved)',
        draw(4, settingsOptions(files, 'user', draft), size, status, draft.count()),
        size,
      ),
    );
    // The leave dialog over the settings screen.
    const background = new ListScreen(settingsOptions(files, 'user', draft));
    const bodySize = { width: size.width, height: Frame.bodyHeight(size.height, true) };
    const dialog = new OverlayScreen(background, {
      title: 'Unsaved changes',
      lines: ['You have 2 unsaved changes in Settings and Apps.'],
      choices: [
        { value: 'save', label: 'Save', key: 's' },
        { value: 'discard', label: 'Discard', key: 'd', danger: true },
        { value: 'cancel', label: 'Cancel', key: 'c' },
      ],
      escape: 'cancel',
    });
    out.push(
      block(
        '5 Settings: Save / Discard / Cancel',
        Frame.render(
          { ...dialog.render(bodySize), tabs: { tabs: TAB_LABELS.map((label) => ({ label })), active: 4 } },
          size.width,
          size.height,
        ).map((l) => Text.strip(l).replace(/\s+$/, '')),
        size,
      ),
      block(
        '6 Accounts',
        draw(
          5,
          accountsOptions([
            {
              name: 'work',
              email: 'me@work.example',
              isDefault: true,
              isActive: true,
              savedAt: '2026-10-13T09:30:00Z',
            },
            { name: 'home', email: null, isDefault: false, isActive: false, savedAt: '2026-10-01T18:00:00Z' },
          ]),
          size,
          status,
        ),
        size,
      ),
    );
    for (const category of ['data', 'logs', 'doctor', 'repair', 'setup', 'more'])
      out.push(
        block(
          '7 Maintenance · ' + category,
          draw(6, { ...maintenanceOptions(maintenance), startCategory: category }, size, status),
          size,
        ),
      );
  }
  return out.join('\n');
}
