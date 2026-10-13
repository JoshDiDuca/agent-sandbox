// The host <-> sandbox channel and the terminal protocol: everything arriving from the sandbox is validated, sized and
// filtered before this PC acts on it.
import { safeId } from '../shared/rundir.js';
import { GuestRequest, SandboxStatus, SessionStatus } from '../shared/schema.js';
import { bootLine, firstStartNotice, pendingDownloads, readyIn, stillWorking } from '../cli/boot-progress.js';
import { encodeFrame, FrameReader, FrameType, fixWindowsKeys, helloFrame, MAX_FRAME_BYTES, OutputFilter } from '../shared/pty-client.js';
import type { Suite } from './suite.js';

export const channelSuite: Suite = {
  name: 'channel',
  title: 'request/status validation and the terminal protocol (frames, OSC 52, keys)',
  run: async (t) => {
    t.section('requests and session status');
    const validRequest = (r: unknown): boolean => GuestRequest.safeParse(r).success;
    const validSession = (s: unknown): boolean => SessionStatus.safeParse(s).success;
    await t.throws(() => safeId('../evil'), 'invalid id', 'a path-like id is rejected');
    t.check(!validRequest({ kind: 'shell', id: 'a' }), 'unknown request kinds are rejected');
    t.check(!validRequest({ kind: 'exec', id: 'a/b', command: ['x'], cwd: 'C:\\', timeoutSeconds: 1 }), 'request ids must be safe file names');
    t.check(validRequest({ kind: 'ping', id: 'abc', createdAt: 'x' }), 'a known request kind with a safe id is accepted');
    t.check(!validRequest({ kind: 'ping', id: 'abc', createdAt: 'x', extra: 1 }), 'requests with unknown keys are rejected');
    const goodSession = { id: 's1', launchId: 'l', harness: 'claude', cwd: 'C:\\Workspace', message: 'ok', phase: 'running', updatedAt: 'x', startedAt: 'x', attach: { addresses: ['172.20.1.5'], port: 5000, token: 't' } };
    t.check(validSession(goodSession), 'a well-formed session status is accepted');
    t.check(!validSession({ ...goodSession, attach: { ...goodSession.attach, port: 70000 } }), 'a session status with an impossible port is rejected');
    t.check(!validSession({ ...goodSession, phase: 'pwned' }), 'a session status with an unknown phase is rejected');

    t.section('boot progress');
    const goodStatus = { launchId: 'l1', phase: 'provisioning', message: '[3/8] Developer tools', updatedAt: 'x', workspaceHost: 'C:\\p', guestWorkspace: 'C:\\Workspace', headless: false };
    const progress = { step: 3, steps: 8, title: 'Developer tools', active: [{ name: 'Rust', percent: 40 }, { name: 'Go' }], done: 2, total: 6 };
    const parsed = (s: unknown) => SandboxStatus.safeParse(s);
    t.equal(parsed({ ...goodStatus, progress }).data?.progress, progress, 'a well-formed boot progress is accepted');
    t.check(parsed(goodStatus).success && parsed(goodStatus).data?.progress === undefined, 'a status without progress (an older sandbox) is accepted');
    const hostile = [
      { ...progress, title: 'x'.repeat(5000) }, { ...progress, active: Array.from({ length: 100 }, () => ({ name: 'a' })) },
      { ...progress, active: [{ name: 'a', percent: 500 }] }, { ...progress, step: -1 }, { ...progress, done: 1e9 }, { ...progress, extra: 1 }, 'pwned',
    ];
    t.equal(hostile.map((p) => { const r = parsed({ ...goodStatus, progress: p }); return r.success && r.data.progress === undefined; }), hostile.map(() => true), 'an oversized or malformed progress is dropped, the status itself still counts');
    t.check(!parsed({ ...goodStatus, phase: 'pwned', progress }).success, 'a status with an unknown phase is still rejected');
    const line = (p: unknown) => bootLine(parsed({ ...goodStatus, progress: p }).data ?? null).line;
    t.equal(line(progress), '[3/8] Developer tools: downloading Rust 40%; setting up Go (2 of 6 done)', 'the line shows the step, the download and what is set up');
    t.equal(line({ ...progress, title: 'Agent: claude', step: 6, active: [], done: 0, total: 0 }), '[6/8] Agent: claude', 'a step without tools is just its title');
    t.equal(line({ ...progress, active: [{ name: '\x1b]52;c;ZXZpbA==\x07Ru\x1b[2Jst\r\n', percent: 99 }] }), '[3/8] Developer tools: downloading Rust 99% (2 of 6 done)', 'escape sequences and control characters from the sandbox never reach the terminal');
    t.equal(bootLine(null).line, 'Starting Windows Sandbox', 'before the sandbox writes anything');
    t.equal(bootLine(parsed({ ...goodStatus, message: 'Installing Go (1 of 3 done)' }).data!).line, 'Installing Go (1 of 3 done)', 'an older sandbox: its message');
    t.equal(bootLine(parsed({ ...goodStatus, progress: { ...progress, active: [{ name: 'Rust', percent: 50 }] } }).data!).key, bootLine(parsed({ ...goodStatus, progress: { ...progress, active: [{ name: 'Rust', percent: 60 }] } }).data!).key, 'a download moving on is no new plain line (only a new step or tool is)');
    t.equal(stillWorking('Rust', 3 * 60 * 1000), 'Still working on Rust (3 min). Full log: sandbox logs -f', 'the notice after a long quiet spell');
    t.equal(readyIn(432_000), 'Ready in 7 min 12 s.', 'the time a first start took');
    const pending = pendingDownloads(['node', 'rust', 'cpp', 'postgres', 'node', 'constructor'], (dir) => dir === 'nvm');
    t.equal(pending, { names: ['rust', 'C/C++', 'PostgreSQL'], mb: 900 }, 'only what is not downloaded yet counts, once each');
    t.equal(firstStartNotice(false, { names: [], mb: 0 }), null, 'a later start with everything downloaded says nothing');
    t.check(/^First start: .*\(about 900 MB: rust, C\/C\+\+, PostgreSQL\)\. This can take 5-20 minutes/.test(firstStartNotice(true, pending) ?? ''), 'the first start says what it downloads, roughly how much, and how long it can take');
    t.check(/^New tools for this project: .*about 1\.8 GB: MSVC, rust/.test(firstStartNotice(false, pendingDownloads(['msvc', 'rust'], () => false)) ?? ''), 'a new toolchain later on gets its own heads-up');

    t.section('terminal frames');
    const filter = new OutputFilter();
    const filtered = Buffer.concat([
      filter.push(Buffer.from('a\x1b]52;c;ZXZpbA==\x07b\x1b]0;title\x07')),
      filter.push(Buffer.from('c\x1b]5')),
      filter.push(Buffer.from('2;c;cGF5\x1b\\d')),
    ]).toString('latin1');
    t.equal(filtered, 'a' + 'b\x1b]0;title\x07' + 'c' + 'd', 'clipboard writes (OSC 52) from the sandbox are stripped, even split across chunks; titles pass');
    const through = (...chunks: string[]): string => { const f = new OutputFilter(); return Buffer.concat(chunks.map((s) => f.push(Buffer.from(s, 'latin1')))).toString('latin1'); };
    t.equal(through('x\x1b]52;c;QUFB\x1b', '\\y'), 'xy', 'an OSC 52 whose terminator is split between chunks is still stripped');
    t.equal(through('x\x1b]052;c;QUFB\x07y'), 'xy', 'OSC 052 (leading zero) is stripped too');
    t.equal(through('x\x1b]52;c;' + 'A'.repeat(70000), 'B'.repeat(100), '\x07y'), 'xy', 'a huge OSC 52 stays stripped across chunks');
    t.equal(through('x\xc2\x9d52;c;QUFB\xc2\x9cy\x1bP1$qm\x1b\\z'), 'xyz', 'C1 (UTF-8) OSC and DCS strings are stripped');
    t.equal(through('\x1b]8;;https://a.b\x1b\\link\x1b]8;;\x1b\\ \x1b[31mred\x1b[0m é\xc2\xa0'), '\x1b]8;;https://a.b\x1b\\link\x1b]8;;\x1b\\ \x1b[31mred\x1b[0m é\xc2\xa0', 'links, colours and ordinary UTF-8 (incl. U+00A0) pass unchanged');
    t.equal(through('\x1b]9;9;macro\x07\x1b]9;4;1;50\x07'), '\x1b]9;4;1;50\x07', 'only the progress form of OSC 9 passes (ConEmu macros do not)');
    const oversizedHeader = Buffer.concat([Buffer.from([16]), Buffer.from([0, 0, 0, 0x7f])]);
    await t.throws(() => new FrameReader().push(oversizedHeader), 'frame too large', 'a frame announcing too much data is rejected instead of buffered');
    t.equal(new FrameReader().push(encodeFrame(16, Buffer.alloc(MAX_FRAME_BYTES))).length, 1, 'a frame of exactly the maximum size is accepted');
    const hello = new FrameReader().push(helloFrame('tok', 100, 30, 2))[0];
    t.equal({ type: hello.type, cols: hello.payload.readInt16LE(0), rows: hello.payload.readInt16LE(2), flags: hello.payload[4], token: hello.payload.subarray(5).toString() }, { type: FrameType.Hello, cols: 100, rows: 30, flags: 2, token: 'tok' }, 'a hello frame carries size, flags and token');
    t.equal(fixWindowsKeys(Buffer.from([0x61, 0x08, 0x7f, 0x1b])), Buffer.from([0x61, 0x7f, 0x08, 0x1b]), 'Windows console Backspace (^H) reaches the agent as DEL, so it deletes one character, not a word');
  },
};
