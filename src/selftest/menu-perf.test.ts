// The menu stays quick: no key or draw waits for a child process (tasklist is faked and counted), a slow tab load shows
// "Loading…" instead of holding up the keys, a held key is drawn once, and the terminal writes only the rows that
// changed (the screen after the diffs is the same as a full draw, also after a resize).
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DEFAULTS } from '../core/config/index.js';
import { sleep } from '../core/util/index.js';
import { Menu } from '../cli/menu/menu.js';
import { LiveStatus } from '../cli/menu/live.js';
import { ListPage, type Outcome } from '../cli/menu/pages/list-page.js';
import type { Context } from '../cli/commands/context.js';
import type { CliOptions } from '../cli/args.js';
import { App, Text, Terminal, type ListOptions, type Screen, type Size } from '../cli/tui/index.js';
import { supportsSyncUpdate } from '../cli/tui/terminal.js';
import { isSandboxRunning, useTasklistCache, useTasklistRunners } from '../host/sandbox/index.js';
import type { Harness } from './support/harness.js';
import type { Suite } from './support/suite.js';

const TASKLIST = [
  '"System Idle Process","0","Services","0","8 K"',
  '"WindowsSandboxClient.exe","4242","Console","1","9,000 K"',
].join('\r\n');

const KEYS = { down: '\x1b[B', up: '\x1b[A', left: '\x1b[D', right: '\x1b[C', tab: '\t', ctrlC: '\x03' };

/** A terminal the test can type into and read: the keys go in as bytes, everything written is kept. */
class FakeTty {
  readonly stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: (): void => undefined });
  readonly stdout = Object.assign(new EventEmitter(), {
    columns: 100,
    rows: 30,
    write: (chunk: string): boolean => {
      this.writes.push(String(chunk));
      return true;
    },
  });
  readonly writes: string[] = [];

  terminal(): Terminal {
    return new Terminal(this.stdin as unknown as NodeJS.ReadStream, this.stdout as unknown as NodeJS.WriteStream);
  }
  type(bytes: string): void {
    this.stdin.write(bytes);
  }
}

/** What the screen shows after a stream of writes: rows set by "ESC[r;1H", wiped by "ESC[H ESC[2J". */
function replay(writes: readonly string[], height: number): string[] {
  const rows = Array.from({ length: height }, () => '');
  for (const write of writes) {
    const body = write.replace(/\x1b\[\?2026[hl]/g, '');
    if (body.startsWith('\x1b[?1049h')) continue;
    for (const part of body.split(/(?=\x1b\[(?:\d+;1H|H))/)) {
      const clear = /^\x1b\[H\x1b\[2J/.exec(part);
      if (clear) rows.fill('');
      const at = /^\x1b\[(\d+);1H([\s\S]*?)\x1b\[0m/.exec(part.slice(clear ? clear[0].length : 0));
      if (at) rows[Number(at[1]) - 1] = at[2];
    }
  }
  return rows;
}

function context(t: Harness): Context {
  const root = t.dir('menu-perf');
  return {
    packageRoot: t.packageRoot,
    entry: 'sandbox.js',
    options: {} as CliOptions,
    loaded: {
      config: structuredClone(DEFAULTS),
      configPath: null,
      base: root,
      layers: { machine: null, user: null },
    },
    storageRoot: root,
    dataPath: t.dir('menu-perf', 'data'),
  };
}

export const menuPerfSuite: Suite = {
  name: 'menu-perf',
  title: 'menu speed: no child process on a key or a draw, diff rendering, slow loads',
  run: async (t) => {
    t.section('the terminal writes only what changed');
    {
      const tty = new FakeTty();
      const term = tty.terminal();
      const height = term.height;
      const frame = (mark: string): string[] =>
        Array.from({ length: height }, (_, i) => 'row ' + i + (i === 7 ? mark : ''));
      term.start();
      tty.writes.length = 0;
      term.render(frame('a'));
      const first = tty.writes.join('');
      term.render(frame('a'));
      const unchanged = tty.writes.length;
      term.render(frame('b'));
      const diff = tty.writes.slice(1).join('');
      t.check(
        unchanged === 1 && diff.includes('row 7b') && !diff.includes('row 6') && diff.length < first.length / 5,
        'an identical frame writes nothing and a change writes only its rows, in one write',
        diff,
      );
      t.equal(
        replay(tty.writes, height).map((r) => r.trimEnd()),
        frame('b').map((r) => Text.fit(r, term.width - 1).trimEnd()),
        'the screen after the diffs equals a full draw',
      );
      tty.stdout.rows = height + 5;
      tty.stdout.emit('resize');
      tty.writes.length = 0;
      const bigger = Array.from({ length: height + 5 }, (_, i) => 'big ' + i);
      term.render(bigger);
      t.check(
        tty.writes.length === 1 && tty.writes[0].includes('\x1b[2J'),
        'a resize repaints everything in one write',
      );
      t.equal(
        replay(tty.writes, height + 5).map((r) => r.trimEnd()),
        bigger.map((r) => Text.fit(r, term.width - 1).trimEnd()),
        'the screen after a resize equals a full draw',
      );
      term.stop();
      t.check(
        supportsSyncUpdate({ WT_SESSION: 'x' }) &&
          !supportsSyncUpdate({}) &&
          !supportsSyncUpdate({ WT_SESSION: 'x', AGENT_SANDBOX_SYNC_UPDATE: '0' }) &&
          supportsSyncUpdate({ AGENT_SANDBOX_SYNC_UPDATE: '1' }),
        'synchronized updates are used where the terminal is known to take them, and can be forced on or off',
      );
    }

    t.section('a held key is drawn once');
    {
      const tty = new FakeTty();
      const app = new App(tty.terminal());
      let renders = 0;
      let handled = 0;
      const screen: Screen<string> = {
        render: (_size: Size) => {
          renders++;
          return { path: [], body: ['x'], keys: [] };
        },
        handle: (key) => {
          handled++;
          return key.text === 'q' ? { done: 'bye' } : undefined;
        },
      };
      // Thirty keys arrive together (a held arrow, a paste).
      tty.type(KEYS.down.repeat(30) + 'q');
      const result = await app.show(screen);
      app.close();
      t.check(
        result === 'bye' && handled === 31 && renders < 10,
        'keys that are already waiting are handled first and drawn once, not once each',
        'handled ' + handled + ', drawn ' + renders,
      );
    }

    t.section('a slow load does not hold up the keys');
    {
      const tty = new FakeTty();
      const app = new App(tty.terminal());
      class Slow extends ListPage<string> {
        readonly label = 'Slow';
        private rows: string[] = [];
        protected async load(): Promise<void> {
          await sleep(500);
          this.rows = ['alpha', 'beta'];
        }
        protected options(): ListOptions<string> {
          return { path: [], items: this.rows.map((r) => ({ value: r, label: r })) };
        }
        protected act(): Promise<Outcome<string>> {
          return Promise.resolve({});
        }
      }
      const page = new Slow(app);
      const started = Date.now();
      await page.open();
      const waited = Date.now() - started;
      const text = (): string => Text.strip(page.render({ width: 80, height: 14 }).body.join('\n'));
      t.check(
        waited < 400 && page.loading && text().includes('Loading'),
        'the tab opens at once and says Loading… while the data comes',
        'waited ' + waited + ' ms',
      );
      const arrived = await t.waitFor(() => (text().includes('beta') ? true : null), 5000, 20);
      t.check(arrived === true && !page.loading, 'the list is built when the data arrives');
    }

    t.section('no child process on a key or a draw');
    const saved = { hostOnly: process.env.AGENT_SANDBOX_HOST_ONLY };
    process.env.AGENT_SANDBOX_HOST_ONLY = '1';
    const calls = { sync: 0, async: 0 };
    useTasklistRunners({
      sync: () => {
        calls.sync++;
        return TASKLIST;
      },
      async: async () => {
        calls.async++;
        // A busy PC: every look at the process list takes a second and a half.
        await sleep(1500);
        return TASKLIST;
      },
    });
    try {
      const tty = new FakeTty();
      const menu = new Menu(context(t), () => Promise.resolve(0), {
        terminal: tty.terminal(),
        fetchTasklist: async () => {
          calls.async++;
          await sleep(1500);
          return TASKLIST;
        },
        refreshMs: 100,
      });
      const done = menu.start();
      const shown = await t.waitFor(() => tty.writes.length > 0, 20000, 20);
      t.check(shown === true, 'the menu draws its first screen');
      const slowest = { ms: 0, key: '' };
      const press = async (name: string, bytes: string): Promise<void> => {
        const before = tty.writes.length;
        const at = Date.now();
        tty.type(bytes);
        // Not every key changes the screen: give the ones that do a chance, and measure those.
        await t.waitFor(() => tty.writes.length > before, 400, 5);
        const took = Date.now() - at;
        if (tty.writes.length > before && took > slowest.ms) {
          slowest.ms = took;
          slowest.key = name;
        }
        await sleep(15);
      };
      const syncBefore = calls.sync;
      for (const section of ['2', '3', '4', '5', '6', '7', '1']) await press('section ' + section, section);
      for (const k of ['down', 'down', 'up', 'left', 'down', 'down', 'right', 'down', 'down', 'tab'] as const)
        await press(k, KEYS[k]);
      for (const section of ['5', '4', '2', '1']) await press('section ' + section, section);
      t.check(
        calls.sync === syncBefore,
        'no key or draw ran tasklist (' + (calls.sync - syncBefore) + ' calls in 21 keys and every draw)',
        String(calls.sync - syncBefore),
      );
      t.check(calls.async >= 2, 'the process list is refreshed in the background (' + calls.async + ' times)');
      t.check(
        slowest.ms < 1000,
        'with a 1.5 second tasklist, no key took a second to show its result (slowest: ' +
          slowest.key +
          ' ' +
          slowest.ms +
          ' ms)',
      );
      tty.type(KEYS.ctrlC);
      const code = await Promise.race([done, sleep(5000).then(() => -1)]);
      t.check(code === 130, 'Ctrl+C leaves the menu');
      const after = calls.sync;
      isSandboxRunning();
      t.check(calls.sync === after + 1, 'after the menu, "is the sandbox running?" runs tasklist again');
    } finally {
      useTasklistRunners();
      useTasklistCache(null);
      if (saved.hostOnly === undefined) delete process.env.AGENT_SANDBOX_HOST_ONLY;
      else process.env.AGENT_SANDBOX_HOST_ONLY = saved.hostOnly;
    }

    t.section('the status line');
    {
      let facts = 'a';
      let changes = 0;
      const live = new LiveStatus({
        fetch: () => Promise.resolve(facts),
        derive: () => 'status ' + facts,
        onChange: () => changes++,
        intervalMs: 20,
      });
      await live.start();
      t.equal([live.line(), changes], ['status a', 1], 'the first look sets the line');
      facts = 'b';
      const changed = await t.waitFor(() => live.line() === 'status b', 3000, 10);
      t.check(changed === true && changes === 2, 'a change is picked up in the background and announced');
      live.stop();
      facts = 'c';
      await sleep(80);
      t.check(live.line() === 'status b' && changes === 2, 'a stopped status looks at nothing');
    }
  },
};
