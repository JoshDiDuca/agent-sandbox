// The menu's pure parts: the tab bar and key bar at every width, the dialog box, the Draft of unsaved changes, and
// the tab pages' lists. With MENU_SCREENS_OUT set it also writes every screen as text there, for review.
import fs from 'node:fs';
import { ConfigFile } from '../cli/menu/settings/config-file.js';
import { Draft } from '../cli/menu/settings/draft.js';
import { hostAgentsToShow, startArgv } from '../cli/menu/pages/start-page.js';
import { TAB_LABELS } from '../cli/menu/shell.js';
import { DEFAULTS } from '../core/config/index.js';
import { HarnessSchema } from '../core/schema/index.js';
import { profileLinkPairs } from '../shared/paths/index.js';
import { AccountsService, parseDatabaseList } from '../cli/services/index.js';
import { dialogBox, KeyBar, overlayBox, TabBar, Text, type KeyHint } from '../cli/tui/index.js';
import { renderScreens } from './menu-screens.js';
import type { Suite } from './support/suite.js';

const WIDTHS = [120, 80, 40];

export const menuSuite: Suite = {
  name: 'menu',
  title: 'menu tabs, key bar, dialogs and unsaved changes',
  run: async (t) => {
    t.section('tab bar and key bar');
    const tabs = TAB_LABELS.map((label) => ({ label }));
    const tooWide: string[] = [];
    for (const width of WIDTHS)
      for (const active of [0, 3, 6]) {
        const line = TabBar.render(tabs, active, width);
        if (Text.width(line) > width || !Text.strip(line).includes(TAB_LABELS[active]))
          tooWide.push(width + '/' + active);
      }
    t.equal(tooWide, [], 'the tab bar fits at every width and names the open tab');
    const keys: KeyHint[] = [
      ['ctrl+s', 'save (2)', 0],
      ['↵', 'edit', 1],
      ['r', 'reset', 2],
      ['tab', 'scope', 3],
      ['↑↓', 'move', 5],
      ['/', 'search', 6],
      ['esc', 'quit', 0],
    ];
    const bar = (width: number): string => Text.strip(KeyBar.render(keys, width));
    t.check(
      WIDTHS.every((w) => Text.width(bar(w)) <= w && bar(w).includes('quit') && bar(w).includes('save (2)')) &&
        !bar(60).includes('search') &&
        bar(60).includes('edit') &&
        bar(200).includes('search'),
      'the key bar fits, keeps save and the way out, and drops the least important keys first',
    );

    t.section('dialog box');
    const box = dialogBox({ title: 'Unsaved changes', lines: ['You have 2 unsaved changes.'], buttons: 'Save' }, 61);
    const base = Array.from({ length: 12 }, () => 'x'.repeat(60));
    const over = overlayBox(base, box, 61);
    t.check(
      new Set(box.map((l) => Text.width(l))).size === 1 &&
        over.length === base.length &&
        over.some((l) => Text.strip(l).includes('Unsaved changes')) &&
        over.every((l) => Text.width(l) <= 60),
      'the dialog box has equal rows and overlays the screen without changing its size',
    );

    t.section('unsaved changes (Draft)');
    const file = ConfigFile.user(t.at('draft', 'config.json'));
    t.write(file.file, '{\n  // keep this comment\n  "defaultHarness": "claude"\n}\n');
    const draft = new Draft();
    draft.stage(file, ['defaultHarness'], 'codex');
    draft.stage(file, ['agentCommands', 'enabled'], true);
    const staged = [draft.count(), draft.value(file, ['defaultHarness'])];
    draft.stage(file, ['defaultHarness'], 'claude');
    const restaged = draft.count();
    draft.unstage(file, ['agentCommands', 'enabled']);
    t.equal(
      [staged, restaged, draft.count()],
      [[2, 'codex'], 1, 0],
      'staged changes are counted; staging what the file already says, or undoing, drops the change',
    );
    draft.stage(file, ['defaultHarness'], 'codex');
    draft.stage(file, ['sandbox', 'headless'], false);
    const result = draft.apply();
    const text = fs.readFileSync(file.file, 'utf8');
    t.check(
      result.problems.length === 0 &&
        result.files.length === 1 &&
        draft.count() === 0 &&
        text.includes('// keep this comment') &&
        text.includes('"codex"'),
      'apply writes the file once, keeps its comments and leaves nothing unsaved',
      JSON.stringify(result.problems),
    );
    draft.stage(file, ['defaultHarness'], 42);
    t.check(draft.apply().problems.length > 0 && draft.count() === 1, 'an invalid change is refused and stays staged');
    draft.discard();

    t.section('tab pages');
    t.equal(
      startArgv(
        {
          folder: 'C:\\code\\api',
          defaultAgent: 'claude',
          agents: [],
          last: undefined,
          attach: true,
          window: 'hide',
          hostAgents: [],
        },
        'codex',
        'C:\\code\\other',
      ),
      ['launch', '--harness', 'codex', '--terminal', '--headless', '--workspace', 'C:\\code\\api'],
      'the start tab builds the same command line the form would',
    );
    t.equal(
      [
        hostAgentsToShow(false, [{ harness: 'claude' }]),
        hostAgentsToShow(true, [{ harness: 'claude' }, { harness: 'codex' }]),
      ],
      [[], ['claude', 'codex']],
      'not-sandboxed entries show only while agent commands are on',
    );
    t.equal(
      parseDatabaseList(
        'postgres  running  port 5432  PostgreSQL 18\nredis     stopped  port 6379  Redis\nnoise\n',
      ).map((d) => [d.name, d.running, d.port]),
      [
        ['postgres', true, 5432],
        ['redis', false, 6379],
      ],
      'the database list reads sbx-db output and ignores other lines',
    );

    t.section('accounts for every agent');
    const service = new AccountsService({
      storageRoot: t.dir('acc', 'storage'),
      dataPath: t.dir('acc', 'data'),
      loaded: { config: structuredClone(DEFAULTS), configPath: null, base: t.temp },
    });
    const agents = service.agents();
    t.check(
      agents[0].name === 'claude' && agents.some((a) => a.name === 'qwen' && a.kept && !a.canSavePc),
      'Claude is listed first; an agent with only a profile folder cannot be saved from this PC',
    );
    const qwenCreds = t.at('acc', 'data', 'state', 'qwen', 'profile', '.qwen', 'oauth_creds.json');
    t.write(qwenCreds, '{"token":"Q"}');
    service.save('q', false, 'qwen');
    t.write(qwenCreds, '{"token":"Q2"}');
    service.activate('q', 'qwen');
    t.equal(fs.readFileSync(qwenCreds, 'utf8'), '{"token":"Q"}', 'login files below profile/ are saved and restored');
    t.equal(
      profileLinkPairs('qwen', ['.qwen', '.config/x', '.QWEN'], 'C:\\Users\\u', 'C:\\AgentData\\state'),
      [
        { link: 'C:\\Users\\u\\.qwen', target: 'C:\\AgentData\\state\\qwen\\profile\\.qwen' },
        { link: 'C:\\Users\\u\\.config\\x', target: 'C:\\AgentData\\state\\qwen\\profile\\.config\\x' },
      ],
      'the profile links: one pair per folder, below state\\<agent>\\profile, without repeats',
    );
    const home = (profileDirs: string[]): boolean =>
      HarnessSchema.safeParse({
        npmPackage: 'x',
        npmBin: 'x',
        arguments: [],
        environment: {},
        home: { env: {}, loginFiles: [], profileDirs },
      }).success;
    t.check(
      home(['.qwen', '.local/share/opencode']) &&
        !home(['..\\x']) &&
        !home(['C:\\x']) &&
        !home(['a/../b']) &&
        !home(Array.from({ length: 9 }, (_, i) => 'd' + i)),
      'profile folders: relative paths only (no "..", no drive), at most 8',
    );
    const codexAuth = t.at('acc', 'data', 'state', 'codex', 'auth.json');
    t.write(codexAuth, '{"token":"A"}');
    service.save('main', false, 'codex');
    t.write(codexAuth, '{"token":"B"}');
    service.save('other', false, 'codex');
    t.write(codexAuth, '{"token":"B2"}');
    service.activate('main', 'codex');
    const swapped = fs.readFileSync(codexAuth, 'utf8');
    service.activate('other', 'codex');
    t.equal(
      [swapped, fs.readFileSync(codexAuth, 'utf8')],
      ['{"token":"A"}', '{"token":"B2"}'],
      'using a login puts its files into the sandbox state; the outgoing login is saved back first (tokens rotate)',
    );
    service.rename('other', 'second', 'codex');
    service.setDefault('second', 'codex');
    t.equal(
      service.list('codex').map((a) => [a.name, a.isDefault, a.isActive]),
      [
        ['main', false, false],
        ['second', true, true],
      ],
      'rename keeps the default and active marks',
    );
    await t.throws(() => service.save('x', false, 'nobody'), 'Unknown agent', 'an unknown agent: refused');
    await t.throws(() => service.save('bad name', false, 'codex'), 'Invalid account name', 'bad names are refused');

    t.section('every screen');
    const screens = renderScreens(t.dir('screens'));
    t.check(
      screens.includes('=== 7 Maintenance · repair (80x24) ===') &&
        screens.includes('unsaved: 2') &&
        screens.includes('Save'),
      'all screens render at both sizes; the settings screen shows its unsaved count and the leave dialog offers Save',
    );
    const out = process.env.MENU_SCREENS_OUT;
    if (out) fs.writeFileSync(out, screens, 'utf8');
  },
};
