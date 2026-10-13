// The audit log: kept small (repeats folded, a cap per minute, old days compressed, limits on days and size), read back
// filtered, and what the sandbox reports is checked like everything else that comes from it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { AuditCollector } from '../host/audit/collect.js';
import { AuditLog, fold, type AuditEvent } from '../host/audit/log.js';
import { parseProcessEvents } from '../guest/audit/parse.js';
import { runPaths } from '../shared/channel/index.js';
import type { Suite } from './suite.js';

const ev = (t: string, extra: Partial<AuditEvent> = {}): AuditEvent => ({
  t,
  k: 'proc',
  p: 'C:\\x\\cargo.exe',
  c: 'cargo build',
  ...extra,
});

export const auditSuite: Suite = {
  name: 'audit',
  title: 'audit log (folding, compression, limits, untrusted reports)',
  run: (t) => {
    t.section('small');
    const folded = fold([
      ev('2026-01-01T10:00:01Z'),
      ev('2026-01-01T10:00:02Z'),
      ev('2026-01-01T10:00:03Z', { c: 'cargo test' }),
      ev('2026-01-01T10:01:00Z'),
    ]);
    t.equal(
      folded.map((e) => [e.c, e.n ?? 1]),
      [
        ['cargo build', 2],
        ['cargo test', 1],
        ['cargo build', 1],
      ],
      'repeats within a minute become one line with a count',
    );
    const flood = fold(
      Array.from({ length: 50 }, (_, i) => ev('2026-01-01T10:00:00Z', { c: 'step ' + i })),
      10,
    );
    t.check(
      flood.length === 11 && flood[10].k === 'note' && flood[10].p!.startsWith('40 more'),
      'past the per-minute cap the rest is one note',
    );

    const dir = t.at('audit-log');
    const log = new AuditLog(dir, { days: 3, maxMb: 5 });
    log.append([
      ev('2026-01-01T10:00:00Z'),
      ev('2026-01-02T10:00:00Z'),
      ev('2026-01-04T10:00:00Z', { k: 'file', p: 'src/a.ts', a: 'change', w: 'C:\\app' }),
    ]);
    log.maintain('2026-01-04');
    t.equal(
      fs.readdirSync(dir).sort(),
      ['2026-01-02.jsonl.gz', '2026-01-04.jsonl'],
      'finished days are compressed and days past audit.days are deleted',
    );
    t.includes(
      zlib.gunzipSync(fs.readFileSync(path.join(dir, '2026-01-02.jsonl.gz'))).toString(),
      'cargo build',
      'a compressed day still holds its events',
    );
    const big = new AuditLog(t.at('audit-big'), { days: 30, maxMb: 5 });
    // Random text: compression must not make the test data fit after all.
    const line = (day: string): AuditEvent => ev(day + 'T00:00:00Z', { c: crypto.randomBytes(900).toString('hex') });
    for (const day of ['2026-02-01', '2026-02-02', '2026-02-03'])
      big.append(Array.from({ length: 1400 }, () => line(day)));
    big.maintain('2026-02-03');
    t.check(
      big.bytes() <= 5 * 1024 * 1024 && fs.readdirSync(big.dir).length < 3,
      'past audit.maxMb the oldest days go',
      String(big.bytes()),
    );

    t.section('reading');
    t.equal(
      log.read({ days: 10000, kinds: ['file'] }).map((e) => e.p),
      ['src/a.ts'],
      'events can be filtered by kind',
    );
    t.equal(log.read({ days: 10000, grep: 'SRC/A.TS' }).length, 1, '... and by text (any case)');

    t.section('what the sandbox reports');
    const xml =
      "<Event><System><TimeCreated SystemTime='2026-01-05T09:00:00.000Z'/><EventRecordID>41</EventRecordID></System><EventData><Data Name='NewProcessName'>C:\\AgentData\\tools\\git\\cmd\\git.exe</Data><Data Name='CommandLine'>git push --force &quot;origin&quot;</Data><Data Name='ParentProcessName'>C:\\nvm\\nodejs\\node.exe</Data></EventData></Event>" +
      "<Event><System><EventRecordID>42</EventRecordID></System><EventData><Data Name='NewProcessName'>C:\\Windows\\System32\\conhost.exe</Data></EventData></Event>";
    const parsed = parseProcessEvents(xml);
    t.equal(
      { last: parsed.last, lines: parsed.lines.map((l) => JSON.parse(l) as AuditEvent).map((e) => [e.p, e.c, e.pp]) },
      {
        last: 42,
        lines: [['C:\\AgentData\\tools\\git\\cmd\\git.exe', 'git push --force "origin"', 'C:\\nvm\\nodejs\\node.exe']],
      },
      "Windows process events become audit lines; Windows' own background programs are left out",
    );

    const data = t.at('audit-data', 'data', 'd');
    const storage = t.at('audit-data');
    const reports = runPaths(data).audit;
    t.write(
      path.join(reports, '1-1.jsonl'),
      [
        JSON.stringify({ t: '2026-01-05T09:00:00Z', k: 'guard', p: 'fake: all clear' }),
        JSON.stringify({ t: '2026-01-05T09:00:01Z', k: 'proc', p: 'C:\\x.exe', c: 'x --y', w: 'C:\\Users\\me' }),
        'not json',
        JSON.stringify({ t: '2026-01-05T09:00:02Z', k: 'proc', p: 'x'.repeat(5000) }),
      ].join('\n'),
    );
    t.write(path.join(reports, 'not-a-report.txt'), 'ignored');
    const collector = new AuditCollector(data, storage, {
      enabled: true,
      days: 14,
      maxMb: 50,
      processes: true,
      files: false,
      projects: [],
    });
    collector.flush();
    const got = new AuditLog(AuditLog.dirFor(storage, data), { days: 14, maxMb: 50 }).read({ days: 100000 });
    t.equal(
      got.map((e) => [e.k, e.p, e.w]),
      [
        ['proc', 'fake: all clear', undefined],
        ['proc', 'C:\\x.exe', undefined],
      ],
      'sandbox reports can only be programs: other kinds are recorded as such, fields it may not set are dropped, oversized lines are refused',
    );
    t.check(!fs.existsSync(path.join(reports, '1-1.jsonl')), 'reports are deleted once taken in');
  },
};
