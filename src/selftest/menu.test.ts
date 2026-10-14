// The menu's pure parts: the tab bar and key bar at every width, the dialog box, the Draft of unsaved changes, and
// the tab pages' lists. With MENU_SCREENS_OUT set it also writes every screen as text there, for review.
import fs from 'node:fs';
import { ConfigFile } from '../cli/menu/settings/config-file.js';
import { Draft } from '../cli/menu/settings/draft.js';
import { startArgv } from '../cli/menu/pages/start-page.js';
import { TAB_LABELS } from '../cli/menu/shell.js';
import { parseDatabaseList } from '../cli/services/index.js';
import { dialogBox, KeyBar, overlayBox, TabBar, Text, type KeyHint } from '../cli/tui/index.js';
import { renderScreens } from './menu-screens.js';
import type { Suite } from './support/suite.js';

const WIDTHS = [120, 100, 80, 60, 40];

export const menuSuite: Suite = {
  name: 'menu',
  title: 'menu tabs, key bar, dialogs and unsaved changes',
  run: (t) => {
    t.section('tab bar');
    const tabs = TAB_LABELS.map((label) => ({ label }));
    for (const width of WIDTHS)
      for (const active of [0, 3, 6]) {
        const line = TabBar.render(tabs, active, width);
        const plain = Text.strip(line);
        t.check(
          Text.width(line) <= width && plain.includes(TAB_LABELS[active]),
          'tab bar at width ' + width + ' (tab ' + (active + 1) + ') fits and names the open tab',
          width + ': "' + plain + '"',
        );
      }
    t.check(
      Text.strip(TabBar.render(tabs, 0, 120)).includes('7 Maintenance'),
      'a wide terminal shows every tab by name',
    );

    t.section('key bar');
    const keys: KeyHint[] = [
      ['ctrl+s', 'save (2)', 0],
      ['↵', 'edit', 1],
      ['r', 'reset', 2],
      ['tab', 'scope', 3],
      ['↑↓', 'move', 5],
      ['/', 'search', 6],
      ['esc', 'quit', 0],
    ];
    for (const width of WIDTHS) {
      const line = Text.strip(KeyBar.render(keys, width));
      t.check(
        Text.width(line) <= width && line.includes('quit') && line.includes('save (2)'),
        'key bar at width ' + width + ' fits and keeps save and the way out',
        line,
      );
    }
    t.check(
      !Text.strip(KeyBar.render(keys, 60)).includes('search') && Text.strip(KeyBar.render(keys, 60)).includes('edit'),
      'a narrow key bar drops search before edit',
    );
    t.check(Text.strip(KeyBar.render(keys, 200)).includes('search'), 'a wide terminal lists every key');

    t.section('dialog box');
    const box = dialogBox({ title: 'Unsaved changes', lines: ['You have 2 unsaved changes.'], buttons: 'Save' }, 61);
    const widths = new Set(box.map((l) => Text.width(l)));
    t.check(widths.size === 1, 'every row of the dialog box is the same width', [...widths].join(','));
    const base = Array.from({ length: 12 }, () => 'x'.repeat(60));
    const over = overlayBox(base, box, 61);
    t.check(over.length === base.length, 'the overlay keeps the number of rows');
    t.check(
      over.some((l) => Text.strip(l).includes('Unsaved changes')),
      'the overlay shows the dialog over the screen',
    );
    t.check(
      over.every((l) => Text.width(l) <= 60),
      'the overlay never exceeds the width',
    );

    t.section('unsaved changes (Draft)');
    const file = ConfigFile.user(t.at('draft', 'config.json'));
    t.write(file.file, '{\n  // keep this comment\n  "defaultHarness": "claude"\n}\n');
    const draft = new Draft();
    t.equal(draft.count(), 0, 'a new draft is empty');
    draft.stage(file, ['defaultHarness'], 'codex');
    draft.stage(file, ['agentCommands', 'enabled'], true);
    t.equal(draft.count(), 2, 'two staged changes are counted');
    t.equal(draft.value(file, ['defaultHarness']), 'codex', 'a staged value is what the screen shows');
    draft.stage(file, ['defaultHarness'], 'claude');
    t.equal(draft.count(), 1, 'staging what the file already says drops the change');
    draft.unstage(file, ['agentCommands', 'enabled']);
    t.equal(draft.count(), 0, 'undoing a change removes it');
    draft.stage(file, ['defaultHarness'], 'codex');
    draft.stage(file, ['sandbox', 'headless'], false);
    const result = draft.apply();
    t.check(
      result.problems.length === 0 && result.files.length === 1,
      'apply writes the file once',
      JSON.stringify(result.problems),
    );
    t.equal(draft.count(), 0, 'nothing is left unsaved after applying');
    const text = fs.readFileSync(file.file, 'utf8');
    t.includes(text, '// keep this comment', "saving keeps the file's comments");
    t.includes(text, '"codex"', 'saving writes the staged value');
    draft.stage(file, ['defaultHarness'], 42);
    const refused = draft.apply();
    t.check(refused.problems.length > 0 && draft.count() === 1, 'an invalid change is refused and stays staged');
    draft.discard();
    t.equal(draft.count(), 0, 'discard drops every staged change');

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
        },
        'codex',
        'C:\\code\\other',
      ),
      ['launch', '--harness', 'codex', '--terminal', '--headless', '--workspace', 'C:\\code\\api'],
      'the start tab builds the same command line the form would',
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

    t.section('every screen');
    const screens = renderScreens(t.dir('screens'));
    t.check(screens.includes('=== 7 Maintenance · repair (80x24) ==='), 'all screens render at both sizes');
    t.includes(screens, 'unsaved: 2', 'the settings screen shows its unsaved count');
    t.includes(screens, 'Save', 'the leave dialog offers Save');
    const out = process.env.MENU_SCREENS_OUT;
    if (out) fs.writeFileSync(out, screens, 'utf8');
  },
};
