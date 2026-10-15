// Heavy load must slow builds down, not close the sandbox: memory sizing with the PC's commit, the agents' memory
// limit, the guest governor (thresholds, hysteresis, which programs), the host watchdog, the crash report and the C#
// helpers behind them.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULTS } from '../core/config/index.js';
import { isWin } from '../core/util/index.js';
import { SYSTEM } from '../shared/system.js';
import { GuestRequestSchema, PressureStatusSchema } from '../shared/channel/index.js';
import {
  GUEST_THRESHOLDS,
  HOST_THRESHOLDS,
  cargoJobs,
  effectiveCpuLimit,
  gentleCpuLimit,
  maxCompilers,
} from '../shared/memory/index.js';
import { agentMemoryLimitMb, decideMemory, memoryNote, resolveMemoryMb } from '../host/launch/index.js';
import { vgpuWarning, GENTLE_NOTE } from '../host/launch/risk-notes.js';
import {
  bugcheckCode,
  cpuPercentBetween,
  explainStop,
  findDumps,
  findingLines,
  freezeLine,
  hostPressure,
  lowReason,
  pageFileRisk,
  parseHostMemory,
  crashReportText,
  watchdogStep,
  WATCHDOG_START,
  type HostMemory,
  type StopEvent,
} from '../host/life/index.js';
import {
  canLower,
  canPause,
  decide,
  GovernorCore,
  INITIAL_STATE,
  type GovernorPort,
  type MemSample,
  type ProcSample,
} from '../guest/governor/index.js';
import type { Suite } from './support/suite.js';

const GB = 1024;
const MB_SANDBOX = DEFAULTS.sandbox;

const proc = (pid: number, name: string, mb: number, prio: ProcSample['prio'] = 'normal'): ProcSample => ({
  pid,
  name,
  mb,
  prio,
});
const sample = (ramFreePercent: number, commitPercent: number, procs: ProcSample[]): MemSample => ({
  ramTotalMb: 10000,
  ramAvailMb: ramFreePercent * 100,
  commitLimitMb: 10000,
  commitAvailMb: (100 - commitPercent) * 100,
  procs,
});
const pc = (over: Partial<HostMemory> = {}): HostMemory => ({
  totalMb: 32768,
  availableMb: 20000,
  commitLimitMb: 49152,
  commitAvailableMb: 40000,
  pageFile: 'auto',
  pageFileMaxMb: 0,
  ...over,
});

export const heavyLoadSuite: Suite = {
  name: 'heavy-load',
  title: 'heavy load: memory sizing, agent memory limit, governor, watchdog, crash report',
  run: async (t, f) => {
    t.section('memory sizing looks at the commit as well as free RAM');
    const base = decideMemory(MB_SANDBOX, 20 * GB, 32 * GB, null);
    t.check(base.mb === 12 * GB, 'without a commit reading: free RAM minus the reserve', String(base.mb));
    const tight = decideMemory(MB_SANDBOX, 20 * GB, 32 * GB, 14 * GB);
    t.check(
      tight.mb === 6 * GB && tight.limitedBy === 'commit',
      'a small commit lowers it (14 GB left - 8 GB reserve = 6 GB)',
      JSON.stringify(tight),
    );
    const roomy = decideMemory(MB_SANDBOX, 20 * GB, 32 * GB, 60 * GB);
    t.check(roomy.mb === base.mb && roomy.limitedBy === 'free', 'plenty of commit changes nothing');
    t.check(
      resolveMemoryMb(MB_SANDBOX, 20 * GB * 1048576, 32 * GB * 1048576, 14 * GB) === 6 * GB,
      'resolveMemoryMb uses it',
    );
    t.check(
      memoryNote(tight)?.includes('6 GB of memory instead of 12 GB') === true,
      'the launch note says plainly what happened',
    );
    t.check(
      memoryNote(base) === null && memoryNote(decideMemory(MB_SANDBOX, 20 * GB, 32 * GB, 19 * GB)) === null,
      'no note when it hardly changed',
    );
    let refused = '';
    try {
      resolveMemoryMb(MB_SANDBOX, 20 * GB * 1048576, 32 * GB * 1048576, 10 * GB);
    } catch (e) {
      refused = String(e instanceof Error ? e.message : e);
    }
    t.check(refused.includes('RAM plus paging file'), 'too little commit refuses with the real reason', refused);
    t.check(resolveMemoryMb({ ...MB_SANDBOX, memoryMb: 5000 }, 1, 1, 1) === 5000, 'a fixed memoryMb is never changed');

    t.section("the agents' memory limit");
    t.check(agentMemoryLimitMb(32768, 'auto') === 32768 - 3276, 'auto: sandbox memory minus 10 %');
    t.check(agentMemoryLimitMb(8192, 'auto') === 8192 - 2048, 'auto: at least 2 GB of headroom');
    t.check(agentMemoryLimitMb(4096, 'auto') === 2048, 'a small sandbox keeps at least half for agents');
    t.check(
      agentMemoryLimitMb(16384, 1000) === 15384 && agentMemoryLimitMb(16384, 'none') === null,
      'a number, or none',
    );
    const gen = await f.launch({}, { args: ['--version'] });
    const session = JSON.parse(fs.readFileSync(gen.sessionPath, 'utf8')) as Record<string, unknown>;
    t.check(
      session.agentMemoryLimitMb === agentMemoryLimitMb(gen.memoryMb, 'auto') &&
        session.pressureResponse === true &&
        session.loadProfile === 'normal',
      'session.json carries the limit, the governor switch and the profile (all on by default)',
      JSON.stringify(session.agentMemoryLimitMb),
    );
    const vgpuConfig = f.makeConfig();
    vgpuConfig.sandbox.vGpu = true;
    const gentle = await f.launch({}, { args: ['--version'], config: vgpuConfig });
    const gs = JSON.parse(fs.readFileSync(gentle.sessionPath, 'utf8')) as Record<string, unknown>;
    t.check(
      gs.loadProfile === 'gentle' && gs.cpuLimitPercent === 65,
      'vGPU on: the gentle profile and a CPU cap 15 points lower (80 -> 65)',
      JSON.stringify([gs.loadProfile, gs.cpuLimitPercent]),
    );
    t.check(gentleCpuLimit(60) === 50 && gentleCpuLimit('none') === 85, 'the gentle cap never goes below 50 %');
    t.check(
      effectiveCpuLimit('none', 'normal') === null && effectiveCpuLimit(80, 'normal') === 80,
      'normal profile: unchanged',
    );
    t.check(
      vgpuWarning('your settings').includes('can freeze the whole PC') && GENTLE_NOTE.includes('gentler'),
      'the vGPU texts',
    );

    t.section('cargo jobs fit the memory and the sessions');
    t.check(cargoJobs(16, 32, 1) === 4, '16 CPUs, 32 GB: 4 jobs');
    t.check(cargoJobs(16, 8, 1) === 2 && cargoJobs(16, 3, 1) === 1, 'about 4 GB per job');
    t.check(cargoJobs(16, 32, 3) === 2 && cargoJobs(16, 32, 8) === 1, 'fewer when several sessions build');

    t.section('the governor: which programs');
    t.check(
      canPause('rustc.exe') && canPause('link.exe') && canPause('ld.lld.exe'),
      'compilers and linkers may be paused',
    );
    t.check(
      !canPause('node.exe') && canLower('node.exe') && canLower('MSBuild.exe'),
      'build tools are only slowed down',
    );
    t.check(
      [
        'claude.exe',
        'codex.exe',
        'cmd.exe',
        'powershell.exe',
        'ptyhost.exe',
        'git.exe',
        'svchost.exe',
        'memgov.exe',
      ].every((n) => !canLower(n) && !canPause(n)),
      'agents, shells, ptyhost, git and system programs are never touched',
    );

    t.section('the governor: thresholds and hysteresis');
    const normal = GUEST_THRESHOLDS.normal;
    const procs = [
      proc(1, 'rustc.exe', 2800),
      proc(2, 'rustc.exe', 2000),
      proc(3, 'claude.exe', 900),
      proc(4, 'link.exe', 500),
    ];
    const calm = decide(INITIAL_STATE, sample(50, 50, procs), 1000, normal, 'normal');
    t.check(calm.level === 'ok' && calm.actions.length === 0, '50 % free: nothing happens');
    const edge = decide(INITIAL_STATE, sample(9, 91, procs), 1000, normal, 'normal');
    t.check(edge.level === 'ok', '9 % free and 91 % commit are still fine (limits: 8 % and 92 %)');
    const low = decide(INITIAL_STATE, sample(7, 50, procs), 1000, normal, 'normal');
    t.check(
      low.level === 'throttled' &&
        low.actions
          .filter((a) => a.kind === 'priority')
          .map((a) => a.kind === 'priority' && a.pid)
          .join() === '1,2,4',
      '7 % free: the compilers go below normal, the agent does not',
    );
    const lowCommit = decide(INITIAL_STATE, sample(50, 93, procs), 1000, normal, 'normal');
    t.check(lowCommit.level === 'throttled', 'commit above 92 % counts too');
    let s2 = INITIAL_STATE;
    const kinds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const d = decide(s2, sample(5, 50, procs), i * 2000, normal, 'normal');
      s2 = d.state;
      kinds.push(d.level);
    }
    t.check(kinds[0] === 'throttled' && kinds.includes('suspending'), 'throttled first, paused later: ' + kinds.join());
    const oneStep = decide(INITIAL_STATE, sample(5, 50, procs), 0, normal, 'normal');
    t.check(!oneStep.actions.some((a) => a.kind === 'pause'), 'never paused on the first sample');
    // Hysteresis: 10 % free is above the 8 % entry but below the 12 % exit: still under pressure.
    let h = decide(INITIAL_STATE, sample(5, 50, procs), 0, normal, 'normal').state;
    h = decide(h, sample(10, 50, procs), 2000, normal, 'normal').state;
    t.check(h.pressure, 'between the entry and exit limits it stays under pressure (no flapping)');
    for (let i = 0; i < normal.calmSamples; i++)
      h = decide(h, sample(30, 50, procs), 4000 + i * 2000, normal, 'normal').state;
    t.check(!h.pressure, 'ends only after ' + normal.calmSamples + ' calm samples');
    const back = decide(
      { ...INITIAL_STATE, pressure: true, calm: normal.calmSamples - 1, lowered: { 1: 'below' } },
      sample(30, 50, [proc(1, 'rustc.exe', 2800, 'below')]),
      9000,
      normal,
      'normal',
    );
    t.check(
      back.level === 'ok' &&
        back.actions.length === 1 &&
        back.actions[0].kind === 'priority' &&
        back.actions[0].to === 'normal',
      'when it ends the compilers get their normal priority back',
    );
    t.check(
      decide(INITIAL_STATE, sample(5, 50, [proc(1, 'rustc.exe', 100)]), 0, normal, 'normal').actions.length === 1 &&
        !decide(
          { ...INITIAL_STATE, samples: 10 },
          sample(5, 50, [proc(1, 'rustc.exe', 100)]),
          99999,
          normal,
          'normal',
        ).actions.some((a) => a.kind === 'pause'),
      'a small compiler (under 300 MB) is never worth pausing',
    );
    const hostAsked = decide({ ...INITIAL_STATE, hostUntil: 5000 }, sample(60, 40, procs), 1000, normal, 'normal');
    t.check(hostAsked.level === 'throttled', 'the PC asking for it counts as pressure while the request lasts');

    t.section('the gentle profile (vGPU on)');
    const gentleT = GUEST_THRESHOLDS.gentle;
    t.check(
      gentleT.enterAvailablePercent === 15 && normal.enterAvailablePercent === 8,
      'it acts at 15 % free instead of 8 %',
    );
    const g = decide(INITIAL_STATE, sample(50, 50, procs), 0, gentleT, 'gentle');
    t.check(
      g.level === 'ok' &&
        g.actions.length === 3 &&
        g.actions.every((a) => a.kind === 'priority' && a.to === 'below' && a.pid !== 3),
      'compilers start below normal even with plenty of memory (the agent does not)',
    );
    t.check(
      decide(INITIAL_STATE, sample(14, 50, procs), 0, gentleT, 'gentle').level === 'throttled',
      '14 % free is pressure',
    );

    t.section('the compiler cap (vGPU on)');
    t.check(
      maxCompilers(16, 'gentle') === 4 && maxCompilers(4, 'gentle') === 2 && maxCompilers(16, 'normal') === null,
      'at most max(2, cores / 4) with vGPU, none otherwise',
    );
    const many = [
      proc(10, 'rustc.exe', 800),
      proc(11, 'rustc.exe', 900),
      proc(12, 'clippy-driver.exe', 700),
      proc(13, 'link.exe', 100),
      proc(3, 'claude.exe', 500),
      proc(14, 'node.exe', 400),
    ];
    const capped = decide(INITIAL_STATE, sample(60, 40, many), 0, gentleT, 'gentle', 2);
    const holds = capped.actions.filter((a) => a.kind === 'hold').map((a) => a.pid);
    t.check(
      holds.length === 2 && holds.includes(12) && holds.includes(13),
      'the newest compilers beyond the cap wait; the oldest keep running',
      holds.join(','),
    );
    t.check(!holds.includes(3) && !holds.includes(14), 'agents and build tools are never held');
    t.check(
      decide(INITIAL_STATE, sample(60, 40, many), 0, gentleT, 'gentle', null).actions.every((a) => a.kind !== 'hold'),
      'no cap, no holds',
    );
    t.check(
      decide(INITIAL_STATE, sample(60, 40, many.slice(0, 2)), 0, gentleT, 'gentle', 2).actions.every(
        (a) => a.kind !== 'hold',
      ),
      'under the cap nothing waits',
    );

    t.section('the governor over a port (fake Windows)');
    const calls: string[] = [];
    const port: GovernorPort = {
      setPriority: (pid, to) => calls.push('prio ' + pid + ' ' + to),
      pause: (pid, ms) => calls.push('pause ' + pid + ' ' + ms),
    };
    const logs: string[] = [];
    const statuses: unknown[] = [];
    let clock = 0;
    const core = new GovernorCore({
      port,
      profile: 'normal',
      now: () => clock,
      logLine: (l) => logs.push(l),
      saveStatus: (s) => statuses.push(s),
    });
    for (let i = 0; i < 6; i++) {
      clock = i * 2000;
      core.onSample(sample(4, 60, procs));
    }
    t.check(
      calls.includes('prio 1 below') && calls.includes('pause 1 5000') && !calls.some((c) => c.includes(' 3 ')),
      'priority first, then a pause of the biggest; the agent untouched',
      calls.join('; '),
    );
    t.check(
      logs.some((l) => l.includes('memory is low')) && logs.some((l) => l.includes('paused rustc')),
      'what it did goes to the memory log',
    );
    t.check(
      statuses.length > 0 && PressureStatusSchema.safeParse(statuses[statuses.length - 1]).success,
      'its status file matches the schema the host reads',
    );
    core.hostPressure(60, 'test');
    t.check(core.current.hostUntil === clock + 60000, 'a host request is remembered for its seconds');

    t.section("the PC's watchdog");
    const input = (
      memory: HostMemory | null,
      nowMs: number,
      cpu: number | null = 10,
      profile: 'normal' | 'gentle' = 'normal',
    ) => ({
      memory,
      cpuPercent: cpu,
      intervalSeconds: 10,
      nowMs,
      reserveHostMb: 8192,
      profile,
    });
    t.check(watchdogStep(WATCHDOG_START, input(pc(), 0)).state.low === false, 'plenty of memory: quiet');
    t.check(lowReason(pc({ availableMb: 3000 }), 8192, HOST_THRESHOLDS.normal, 1) !== '', 'under 4 GB of RAM: low');
    t.check(
      lowReason(pc({ availableMb: 5000 }), 8192, HOST_THRESHOLDS.normal, 1) === '',
      '5 GB free on a 32 GB PC is fine (limit max(4 GB, 12 % = 3.9 GB))',
    );
    t.check(
      lowReason(pc({ totalMb: 65536, availableMb: 7000 }), 8192, HOST_THRESHOLDS.normal, 1) !== '',
      '12 % of 64 GB = 7.7 GB: 7 GB is low',
    );
    t.check(
      lowReason(pc({ commitAvailableMb: 6000 }), 8192, HOST_THRESHOLDS.normal, 1) !== '',
      'commit under 15 % of the limit: low',
    );
    t.check(
      lowReason(pc({ availableMb: 5000 }), 8192, HOST_THRESHOLDS.gentle, 1) !== '',
      'the gentle profile acts at 6 GB',
    );
    const first = watchdogStep(WATCHDOG_START, input(pc({ availableMb: 2000 }), 100000));
    t.check(first.send && first.changed && first.state.low, 'low: asks the sandbox at once');
    const second = watchdogStep(first.state, input(pc({ availableMb: 2000 }), 110000));
    t.check(!second.send, 'and not again within 30 s');
    t.check(
      watchdogStep(second.state, input(pc({ availableMb: 2000 }), 131000)).send,
      'but repeats every 30 s while it lasts',
    );
    let w = first.state;
    w = watchdogStep(w, input(pc({ availableMb: 4500 }), 140000)).state;
    t.check(w.low, 'just above the limit is not recovered yet (needs 1.25 times)');
    for (let i = 0; i < 3; i++) w = watchdogStep(w, input(pc({ availableMb: 12000 }), 150000 + i * 10000)).state;
    t.check(!w.low, 'recovered after 3 good samples');
    let cpu = WATCHDOG_START;
    let sent = false;
    for (let i = 0; i < 7; i++) {
      const s = watchdogStep(cpu, input(pc(), i * 10000, 97));
      cpu = s.state;
      sent = sent || s.send;
    }
    t.check(sent && cpu.low, 'CPU above 95 % for 60 s: asks the sandbox to slow down');
    t.check(!watchdogStep(WATCHDOG_START, input(pc(), 0, 97)).state.low, 'a short CPU peak is nothing');
    let disk = WATCHDOG_START;
    let diskSent = false;
    for (let i = 0; i < 5; i++) {
      const st = watchdogStep(disk, input(pc({ diskQueue: 40 }), i * 10000));
      disk = st.state;
      diskSent = diskSent || st.send;
    }
    t.check(diskSent && disk.low, 'a disk queue of 32 or more for 40 s: asks the sandbox to slow down');
    t.check(!watchdogStep(WATCHDOG_START, input(pc({ diskQueue: 40 }), 0)).state.low, 'a short disk peak is nothing');
    t.check(!watchdogStep(WATCHDOG_START, input(pc(), 0)).state.low, 'no disk counter: memory and CPU only');
    t.check(
      cpuPercentBetween(
        [{ times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } } as never],
        [{ times: { user: 90, nice: 0, sys: 0, idle: 10, irq: 0 } } as never],
      ) === 90,
      'CPU use from two readings',
    );
    t.check(
      GuestRequestSchema.safeParse({ kind: 'pressure', id: 'p1', reason: 'low', seconds: 90, createdAt: 'now' })
        .success &&
        !GuestRequestSchema.safeParse({ kind: 'pressure', id: 'p1', reason: 'x', seconds: 99999, createdAt: 'now' })
          .success &&
        !GuestRequestSchema.safeParse({ kind: 'pressure', id: '../x', reason: 'x', seconds: 30, createdAt: 'now' })
          .success &&
        !GuestRequestSchema.safeParse({
          kind: 'pressure',
          id: 'p1',
          reason: 'x',
          seconds: 30,
          createdAt: 'now',
          extra: 1,
        }).success,
      'the pressure request is validated (id, seconds, no extra fields)',
    );
    t.check(
      hostPressure(pc({ commitAvailableMb: 3000 }), 8192).low && !hostPressure(pc(), 8192).low,
      'hostPressure (launch-time helper)',
    );

    t.section('host memory reading and the page file warning');
    t.check(
      parseHostMemory(
        '{"totalMb":32766,"availableMb":23596,"commitLimitMb":49150,"commitAvailableMb":38910,"pageFile":"fixed","pageFileMaxMb":16384}',
      )?.pageFile === 'fixed' &&
        parseHostMemory('not json') === null &&
        parseHostMemory('{"totalMb":0}') === null &&
        parseHostMemory('{"totalMb":1,"availableMb":1,"commitLimitMb":1,"commitAvailableMb":1}')?.pageFile === 'auto',
      'memory-status output is parsed and checked',
    );
    t.check(pageFileRisk(pc(), 20000) === null, 'Windows manages the page file: no warning');
    const risk = pageFileRisk(pc({ pageFile: 'fixed', commitLimitMb: 40000, commitAvailableMb: 10000 }), 20000);
    t.check(
      risk !== null &&
        risk.text.includes('closes the sandbox instead of slowing it down') &&
        risk.text.includes('Automatically manage paging file size') &&
        risk.neededGb >= 1,
      'a fixed small page file: warns in plain words and names the size',
      JSON.stringify(risk),
    );
    t.check(
      pageFileRisk(pc({ pageFile: 'none', commitLimitMb: 32768, commitAvailableMb: 30000 }), 31000) !== null,
      'no page file at all warns too',
    );
    t.check(
      pageFileRisk(pc({ pageFile: 'fixed', commitLimitMb: 90000, commitAvailableMb: 80000 }), 20000) === null,
      'a fixed but large one is fine',
    );

    t.section('the crash report');
    const ev = (id: number, provider: string, at: string, process = ''): StopEvent => ({ id, provider, at, process });
    t.check(
      bugcheckCode('BugcheckCode 209') === '0xD1' && bugcheckCode('BugcheckCode 0') === null,
      'Kernel-Power 41 stop code',
    );
    const cause = explainStop([ev(41, 'Microsoft-Windows-Kernel-Power', '2026-10-15T20:53:47Z', 'BugcheckCode 0')]);
    t.check(cause?.kind === 'crash' && cause.text.includes('freeze'), 'no stop code: a freeze, crash or power cut');
    t.check(
      explainStop([
        ev(41, 'Microsoft-Windows-Kernel-Power', '2026-10-15T20:53:47Z', 'BugcheckCode 209'),
      ])?.text.includes('0xD1') === true,
      'with a stop code: a blue screen',
    );
    t.check(
      freezeLine(cause!, '2026-10-15T19:40:57Z')?.includes('73 minutes later') === true &&
        freezeLine(cause!, '2026-10-15T20:53:00Z') === null,
      'a long gap says the PC stopped responding; a short one says nothing',
    );
    const events = [
      ev(2004, 'Microsoft-Windows-Resource-Exhaustion-Detector', '2026-10-15T19:41:00Z', 'low virtual memory'),
      ev(41, 'Microsoft-Windows-Kernel-Power', '2026-10-15T20:53:47Z', 'BugcheckCode 0'),
      ev(19, 'Microsoft-Windows-WHEA-Logger', '2026-10-15T19:41:10Z', 'corrected hardware error'),
      ev(1000, 'Application Error', '2026-10-15T19:41:12Z', 'vmwp.exe crashed'),
    ];
    const meaning = findingLines(events).join('\n');
    t.check(
      meaning.includes('memory ran out') &&
        meaning.includes('froze, lost power') &&
        meaning.includes('hardware error') &&
        meaning.includes('vmwp.exe'),
      'what each finding usually means, in plain words',
      meaning,
    );
    const dumps = path.join(t.at('crash-dumps'), 'Minidump');
    fs.mkdirSync(dumps, { recursive: true });
    fs.writeFileSync(path.join(dumps, '101526-1.dmp'), 'x');
    t.check(
      findDumps([dumps], new Date(Date.now() - 3600000)).length === 1 &&
        findDumps([dumps], new Date(Date.now() + 3600000)).length === 0 &&
        findDumps([path.join(dumps, 'none')], new Date(0)).length === 0,
      'dumps: names and times only, newer than the start, a missing folder is fine',
    );
    const report = crashReportText(
      cause!,
      [...events, events[0]],
      'time | RAM\n19:40:45 | 9400/27600',
      '2026-10-15T19:40:57Z',
      {
        hostMemoryLog: '2026-10-15T19:40:50Z | RAM free/total MB 900/32768',
        dumps: [{ name: 'C:\\Windows\\Minidump\\a.dmp', at: '2026-10-15T20:54:00Z' }],
        vgpu: true,
      },
    );
    t.check(
      report.includes('stopped responding') &&
        report.includes('What that usually means') &&
        report.includes('RAM free/total MB 900/32768') &&
        report.includes('a.dmp') &&
        report.includes('vGPU was on') &&
        report.split('Resource-Exhaustion-Detector 2004').length === 3,
      "the report has the freeze, the meanings, this PC's memory, dumps and vGPU; a repeated event is shown once",
      report,
    );

    t.section('the C# helpers compile (C# 5, the csc that ships with Windows)');
    if (!isWin || !fs.existsSync(SYSTEM.csc())) {
      t.check(true, 'skipped: no Windows csc on this machine');
      return;
    }
    const out = t.at('heavy-csc');
    fs.mkdirSync(out, { recursive: true });
    const build = (name: string, files: string[], target = 'exe'): string => {
      const exe = path.join(out, name + '.exe');
      const r = spawnSync(SYSTEM.csc(), ['/nologo', '/target:' + target, '/out:' + exe, ...files], {
        encoding: 'utf8',
        windowsHide: true,
      });
      t.check(r.status === 0, name + ' compiles', r.stdout);
      return exe;
    };
    const sandboxCs = (n: string): string => path.join(t.packageRoot, 'sandbox', 'csharp', n);
    build('ptyhost', [sandboxCs('PtyHost.cs')]);
    const memgov = build('memgov', [sandboxCs('MemGov.cs')]);
    const hostDir = path.join(t.packageRoot, 'native', 'csharp', 'HostTools');
    const tools = build(
      'HostTools',
      fs
        .readdirSync(hostDir)
        .filter((n) => n.endsWith('.cs'))
        .map((n) => path.join(hostDir, n)),
    );
    const status = spawnSync(tools, ['memory-status'], { encoding: 'utf8', windowsHide: true });
    const parsed = parseHostMemory(status.stdout);
    t.check(
      parsed !== null && parsed.commitLimitMb >= parsed.totalMb,
      'HostTools memory-status answers with valid JSON',
      status.stdout,
    );
    const usage = spawnSync(memgov, [], { encoding: 'utf8', windowsHide: true });
    t.check(usage.status === 2, 'memgov without a command is a usage error (it starts nothing)');
    const served = spawnSync(memgov, ['serve', '--interval', '1'], {
      encoding: 'utf8',
      windowsHide: true,
      input: '',
      timeout: 15000,
    });
    const firstLine = (served.stdout ?? '').split(/\r?\n/)[0] ?? '';
    let sampleOk = false;
    try {
      // In a sandbox started by 1.10 or later the real agents job exists, so the list may hold its processes.
      const parsedSample = JSON.parse(firstLine) as { procs: { pid?: unknown; name?: unknown }[]; ramTotalMb: number };
      sampleOk =
        Array.isArray(parsedSample.procs) &&
        parsedSample.procs.every((p) => typeof p.pid === 'number' && typeof p.name === 'string') &&
        parsedSample.ramTotalMb > 0;
    } catch {
      // Not JSON: the check below fails.
    }
    t.check(
      sampleOk && served.status === 0,
      'memgov serve prints a well-formed sample and ends when its input closes',
      firstLine,
    );
    for (const script of ['memory-status.ps1', 'stop-events.ps1']) {
      const text = fs.readFileSync(path.join(t.packageRoot, 'native', 'scripts', script), 'utf8');
      t.check(text.startsWith('#Requires -Version 5.1'), script + ' says its PowerShell version');
    }
  },
};
