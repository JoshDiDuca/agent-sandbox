// Reopening the sessions of the last sandbox: the ledger of what ran, the decision to reopen, the limit on automatic
// restarts, which conversation file is a session's, and the arguments that open it again.
import fs from 'node:fs';
import { HarnessSchema } from '../core/schema/index.js';
import { DEFAULTS } from '../core/config/index.js';
import type { SessionStatus } from '../core/types.js';
import {
  autoRestartAllowed,
  describeLast,
  endedUnexpectedly,
  SessionLedger,
  shouldReopen,
  type Life,
  type ResumeSetting,
} from '../host/life/index.js';
import type { Registry } from '../host/projects/index.js';
import { notRunningYet } from '../cli/commands/sessions/reopen.js';
import { pickConversation, resumeArgumentsFor } from '../shared/paths/index.js';
import { SessionStatusSchema } from '../shared/channel/index.js';
import type { Suite } from './support/suite.js';

const ID_A = '0a1b2c3d-0000-4000-8000-000000000001';
const ID_B = '0a1b2c3d-0000-4000-8000-000000000002';
const ID_C = '0a1b2c3d-0000-4000-8000-000000000003';
const NOW = new Date('2026-10-14T12:00:00.000Z');
const minutes = (n: number): string => new Date(NOW.getTime() - n * 60000).toISOString();

const registry = (primary: string, other: string): Registry => ({
  launchId: 'L1',
  protections: {},
  roots: [],
  projects: [
    { name: 'api', host: primary, guest: 'C:\\Workspace\\api', primary: true, mechanism: 'launch', registeredAt: 'x' },
    { name: 'web', host: other, guest: 'C:\\Workspace\\web', primary: false, mechanism: 'boot', registeredAt: 'x' },
  ],
});

const status = (over: Partial<SessionStatus>): SessionStatus => ({
  id: 's1',
  launchId: 'L1',
  harness: 'claude',
  cwd: 'C:\\Workspace\\api',
  phase: 'running',
  message: 'ok',
  updatedAt: minutes(0),
  startedAt: minutes(30),
  ...over,
});

const life = (over: Partial<Life> = {}): Life => ({
  started: minutes(60),
  lastSeen: minutes(1),
  keepAwake: false,
  ...over,
});

export const resumeSuite: Suite = {
  name: 'resume',
  title: 'reopening the last sandbox: ledger, decision, restart limit, conversations',
  run: async (t) => {
    t.section('the ledger');
    const storage = t.dir('storage');
    const data = t.at('storage', 'data', 'main');
    const ledger = new SessionLedger(storage, data);
    t.equal(ledger.read(), null, 'no file: nothing recorded');
    const launch = { primary: 'F:\\code\\api', harness: 'claude', projects: [], headless: true, configPath: null };
    ledger.recordSessions([status({})], registry('F:\\code\\api', 'F:\\code\\web'), NOW);
    t.equal(ledger.read(), null, 'a sandbox this tool did not start records nothing');
    ledger.startLaunch(launch, NOW);
    t.equal(ledger.read()?.sessions, [], 'a launch with nothing before it starts with no sessions');
    const reg = registry('F:\\code\\api', 'F:\\code\\web');
    ledger.recordSessions(
      [
        status({ conversation: ID_A }),
        status({ id: 's2', harness: 'codex', cwd: 'C:\\Workspace\\web\\src', startedAt: minutes(20) }),
        status({ id: 's3', phase: 'exited' }),
        status({ id: 's4', cwd: 'D:\\nowhere' }),
      ],
      reg,
      NOW,
    );
    const saved = ledger.read();
    t.equal(
      saved?.sessions.map((s) => [s.harness, s.project, s.conversation]),
      [
        ['claude', 'F:\\code\\api', ID_A],
        ['codex', 'F:\\code\\web\\src', undefined],
      ],
      'running sessions are noted with their folder on this PC; ended ones and unknown folders are not',
    );
    t.equal(saved?.launch.projects, ['F:\\code\\web'], 'the projects the sandbox has now are noted for a restart');
    ledger.recordSessions(
      [
        status({ startedAt: minutes(30) }),
        status({ id: 's2', harness: 'codex', cwd: 'C:\\Workspace\\web\\src', startedAt: minutes(20) }),
      ],
      reg,
      NOW,
    );
    t.equal(
      ledger.read()?.sessions[0].conversation,
      ID_A,
      'a conversation noted before stays when the next look does not know it yet',
    );
    ledger.recordSessions([status({ conversation: 'not-an-id; rm -rf' })], reg, NOW);
    t.equal(
      ledger.read()?.sessions.map((s) => s.conversation),
      [ID_A],
      'a conversation that is not an id is never kept (it ends up on a command line)',
    );
    ledger.recordSessions(
      Array.from({ length: 60 }, (_, i) => status({ id: 'x' + i, startedAt: minutes(100 - i) })),
      reg,
      NOW,
    );
    t.equal(ledger.read()?.sessions.length, 50, 'at most 50 sessions are kept');
    ledger.markClosedOnPurpose();
    t.equal(ledger.read()?.closedOnPurpose, true, 'stopping on purpose is marked');
    const before = JSON.stringify(ledger.read()?.sessions);
    ledger.recordSessions([], reg, NOW);
    t.equal(
      JSON.stringify(ledger.read()?.sessions),
      before,
      'and the sessions that end while it shuts down do not erase it',
    );
    ledger.startLaunch(launch, NOW);
    t.equal(
      ledger.read()?.closedOnPurpose,
      false,
      'a new launch clears the mark and keeps the sessions of the last one',
    );
    t.equal(ledger.read()?.sessions.length, 50, '... until its own are noted');
    t.equal(
      describeLast([
        { harness: 'claude', project: 'F:\\code\\mw2-agent', startedAt: 'x' },
        { harness: 'codex', project: 'F:\\code\\web', startedAt: 'x' },
      ]),
      'claude in mw2-agent, codex in web (2 sessions)',
      'what ran last time in plain words',
    );

    t.section('the ledger file is validated');
    const file = t.at('storage', 'sync', 'main-sessions.json');
    const good = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    for (const [what, bad] of [
      [
        'a session with a huge folder',
        { ...good, sessions: [{ harness: 'a', project: 'x'.repeat(2000), startedAt: 'x' }] },
      ],
      [
        'a conversation too long to be one',
        { ...good, sessions: [{ harness: 'a', project: 'b', startedAt: 'x', conversation: 'y'.repeat(200) }] },
      ],
      ['sessions that are not a list', { ...good, sessions: 'many' }],
      ['no launch', { savedAt: 'x', sessions: [] }],
    ] as const) {
      fs.writeFileSync(file, JSON.stringify(bad));
      t.equal(ledger.read(), null, 'a bad file is refused: ' + what);
    }

    t.section('reopen, ask or leave');
    const withSessions = {
      sessions: [{ harness: 'claude', project: 'F:\\a', startedAt: 'x' }],
      closedOnPurpose: false,
    };
    const crashed = life({ ended: { at: minutes(1), cause: { kind: 'sandboxCrash', at: minutes(1), text: 'x' } } });
    const closed = life({ ended: { at: minutes(1), cause: null } });
    const settings: ResumeSetting[] = ['ask', 'always', 'afterCrash', 'never'];
    const expected: Record<string, ['ask' | 'reopen' | 'no', 'ask' | 'reopen' | 'no', 'ask' | 'reopen' | 'no']> = {
      // [last sandbox crashed, last sandbox closed normally, the PC went down (no end recorded)]
      ask: ['ask', 'ask', 'ask'],
      always: ['reopen', 'reopen', 'reopen'],
      afterCrash: ['reopen', 'no', 'reopen'],
      never: ['no', 'no', 'no'],
    };
    for (const setting of settings) {
      t.equal(
        [
          shouldReopen(setting, crashed, withSessions),
          shouldReopen(setting, closed, withSessions),
          shouldReopen(setting, life(), withSessions),
        ],
        expected[setting],
        'resume.sessions "' + setting + '": after a crash, a normal close, a PC that went down',
      );
      t.equal(
        shouldReopen(setting, crashed, { sessions: [], closedOnPurpose: false }),
        'no',
        '"' + setting + '": nothing recorded, nothing to reopen',
      );
      t.equal(shouldReopen(setting, crashed, null), 'no', '"' + setting + '": no ledger, nothing to reopen');
    }
    t.equal(
      shouldReopen('afterCrash', crashed, { ...withSessions, closedOnPurpose: true }),
      'no',
      '"afterCrash": stopped on purpose is not a crash',
    );
    t.check(!endedUnexpectedly(life(), false, true), 'a watcher that still runs means the sandbox did not end');
    t.check(!endedUnexpectedly(null, false, false), 'no record of how it lived: not a crash');

    t.section('automatic restarts: 3 in 6 hours');
    t.check(autoRestartAllowed([], NOW), 'the first is allowed');
    t.check(autoRestartAllowed([minutes(10), minutes(20)], NOW), 'the third is allowed');
    t.check(!autoRestartAllowed([minutes(10), minutes(20), minutes(30)], NOW), 'the fourth in six hours is not');
    t.check(
      autoRestartAllowed([minutes(10), minutes(20), minutes(7 * 60)], NOW),
      'an old one stops counting after six hours',
    );
    t.check(!autoRestartAllowed([minutes(10), minutes(20), minutes(359)], NOW), 'just inside six hours still counts');
    t.check(autoRestartAllowed(['garbage', '', minutes(1)], NOW), 'garbage in the file does not count');
    const restarts = new SessionLedger(storage, t.at('storage', 'data', 'other'));
    restarts.startLaunch(launch, NOW);
    for (let i = 0; i < 4; i++) restarts.recordAutoRestart(new Date(NOW.getTime() - (4 - i) * 3600000));
    t.equal(restarts.read()?.autoRestarts?.length, 4, 'automatic restarts are counted in the ledger');
    restarts.giveUp(NOW);
    t.check(restarts.takeGaveUp() !== null && restarts.takeGaveUp() === null, 'the launch hears that it gave up, once');

    t.section("which conversation is a session's");
    const at = (ms: number): number => NOW.getTime() + ms * 1000;
    const files = [
      { id: ID_A, createdMs: at(5) },
      { id: ID_B, createdMs: at(20) },
      { id: ID_C, createdMs: at(-100) },
      { id: 'notes', createdMs: at(6) },
    ];
    t.equal(
      pickConversation(files, NOW.getTime(), new Set()),
      ID_A,
      'the first file created since the session started',
    );
    t.equal(pickConversation(files, NOW.getTime(), new Set([ID_A])), ID_B, 'one another session has is skipped');
    t.equal(pickConversation(files, at(10), new Set()), ID_B, 'files from before the session started are not its own');
    t.equal(pickConversation(files, at(30), new Set()), null, 'none yet: the agent has written nothing');
    t.equal(pickConversation([], 0, new Set()), null, 'no folder, no files');

    t.section('the arguments that open it again');
    const claude = DEFAULTS.harnesses.claude;
    t.equal(resumeArgumentsFor(claude, ID_A), ['--resume', ID_A], 'a known conversation is opened by its id');
    t.equal(resumeArgumentsFor(claude), ['--continue'], 'without one, the last conversation');
    t.equal(
      resumeArgumentsFor(claude, 'x; calc'),
      ['--continue'],
      'an id that is not one is not put on the command line',
    );
    t.equal(
      resumeArgumentsFor(DEFAULTS.harnesses.codex, ID_A),
      ['resume', '--last'],
      'an agent that cannot open one by id continues its last',
    );
    t.equal(resumeArgumentsFor({}, ID_A), [], 'an agent with neither starts afresh');
    const harness = (extra: Record<string, unknown>): boolean =>
      HarnessSchema.safeParse({ npmPackage: 'x', npmBin: 'x', arguments: [], environment: {}, ...extra }).success;
    t.check(harness({ resumeOneArguments: ['--resume', '{id}'] }), 'resumeOneArguments with {id} is valid');
    t.check(!harness({ resumeOneArguments: ['--resume'] }), 'resumeOneArguments without {id} is refused');
    t.check(
      SessionStatusSchema.safeParse(status({ conversation: ID_A })).success &&
        !SessionStatusSchema.safeParse(status({ conversation: 'y'.repeat(200) })).success,
      'a session status may carry a conversation, capped',
    );

    t.section('not opening twice');
    const running = [{ harness: 'claude', hostDir: 'F:\\code\\API' }];
    t.equal(
      notRunningYet(
        [
          { harness: 'claude', hostDir: 'F:\\code\\api' },
          { harness: 'claude', hostDir: 'F:\\code\\api' },
          { harness: 'codex', hostDir: 'F:\\code\\api' },
        ],
        running,
      ).map((r) => r.harness),
      ['claude', 'codex'],
      'a session the sandbox already has is not opened again (one for one, any letter case)',
    );
    t.equal(DEFAULTS.resume, { sessions: 'ask', restartAfterCrash: false }, 'the defaults: ask, no automatic restart');
  },
};
