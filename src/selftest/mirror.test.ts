// Guest paths on other drive letters (C:\Mirror\<letter> + subst) and guestWorkspace "mirror".
import fs from 'node:fs';
import path from 'node:path';
import type { GuestSession } from '../core/types.js';
import { ConfigSchema, MappingSchema } from '../core/schema/index.js';
import { guestPathFor } from '../cli/commands/context.js';
import { buildWsb } from '../host/launch/index.js';
import {
  deriveGuest,
  guestDrive,
  isValidGuestPath,
  planMirrorWorkspace,
  sandboxFolder,
  substDrives,
} from '../shared/paths/index.js';
import { guestWorkspaceAliases, projectFolderName } from '../shared/paths/index.js';
import { syncHistoryIn, syncHistoryOut } from '../sync/index.js';
import type { Suite } from './support/suite.js';

export const mirrorSuite: Suite = {
  name: 'mirror',
  title: 'guest paths on other drive letters, guestWorkspace "mirror"',
  run: async (t, f) => {
    t.section('which guest paths are valid');
    const valid = [
      'C:\\Assets',
      'C:\\Workspace\\x',
      'F:\\SteamLibrary\\steamapps\\common\\Game',
      'f:\\x',
      'Z:\\a b\\c (1)',
    ];
    t.equal(
      valid.filter((p) => !isValidGuestPath(p)),
      [],
      'guest paths under C:\\ or on D: to Z: are accepted',
    );
    const invalid = [
      'C:\\',
      'F:\\',
      'F:',
      'C:\\Windows\\x',
      'C:\\Users\\me',
      'c:\\program files\\x',
      'C:\\AgentData\\x',
      'C:\\Mirror',
      'C:\\Mirror\\F\\x',
      'A:\\x',
      'B:\\x',
      'C:\\a\\..\\Windows',
      'F:\\a\\..\\b',
      'F:\\a:b',
      'F:\\a/b',
      'F:\\a\\\\b',
      'F:\\a.\\b',
      'F:\\a|b',
      'F:\\a\nb',
      '\\\\server\\share\\x',
      'relative\\x',
      'F:x',
    ];
    t.equal(
      invalid.filter(isValidGuestPath),
      [],
      'drive roots, reserved folders, C:\\Mirror, A:/B:, .., streams, odd characters and UNC paths are refused',
    );
    const mappingAccepts = (guest?: string): boolean =>
      MappingSchema.safeParse({ host: 'E:\\Games', guest, readOnly: true }).success;
    t.check(
      mappingAccepts('F:\\SteamLibrary\\Game') && mappingAccepts('C:\\Windows\\x') && mappingAccepts(undefined),
      'schema: any mappings[].guest is accepted, or none (the launch places it; it never fails the config)',
    );
    const workspaceAccepts = (guestWorkspace: string): boolean =>
      ConfigSchema.safeParse({ ...f.makeConfig(), guestWorkspace }).success;
    t.check(
      workspaceAccepts('mirror') && workspaceAccepts('F:\\AgentProjects\\x'),
      'schema: guestWorkspace accepts "mirror" and D:-Z: paths',
    );
    t.check(!workspaceAccepts('C:\\Users\\x'), 'schema: guestWorkspace refuses reserved paths');
    t.equal([guestDrive('f:\\x'), guestDrive('\\\\s\\x')], ['F', null], 'drive letter of a guest path');

    t.section('where a drive-letter path really lives');
    t.equal(
      [sandboxFolder('F:\\SteamLibrary\\Game'), sandboxFolder('f:\\x'), sandboxFolder('C:\\Assets')],
      ['C:\\Mirror\\F\\SteamLibrary\\Game', 'C:\\Mirror\\F\\x', 'C:\\Assets'],
      'F:\\x really lives at C:\\Mirror\\F\\x; C: paths stay as they are',
    );
    t.equal(
      substDrives(['C:\\a', 'G:\\z', 'F:\\x', 'f:\\y']),
      [
        { letter: 'F', target: 'C:\\Mirror\\F' },
        { letter: 'G', target: 'C:\\Mirror\\G' },
      ],
      'one subst drive per used letter (never C:), sorted',
    );
    t.equal(
      guestWorkspaceAliases('F:\\AgentProjects\\mw2'),
      ['C:\\Mirror\\F\\AgentProjects\\mw2', 'F:\\AgentProjects\\mw2'],
      'a mirrored workspace is also known by its real C:\\Mirror path',
    );
    t.equal(guestWorkspaceAliases('C:\\Workspace\\x').length, 1, 'a C: workspace has no alias');
    const wsb = buildWsb(f.baseConfig, 4096, [
      {
        host: 'E:\\SteamLibrary\\steamapps\\common\\Game',
        guest: 'F:\\SteamLibrary\\steamapps\\common\\Game',
        readOnly: true,
      },
      { host: 'D:\\Assets', guest: 'C:\\Assets', readOnly: false },
    ]);
    t.includes(
      wsb,
      '<SandboxFolder>C:\\Mirror\\F\\SteamLibrary\\steamapps\\common\\Game</SandboxFolder>',
      'the .wsb maps F:\\ guests under C:\\Mirror\\F',
    );
    t.includes(wsb, '<SandboxFolder>C:\\Assets</SandboxFolder>', 'the .wsb maps C:\\ guests as they are');
    t.excludes(wsb, '<SandboxFolder>F:', 'the .wsb never maps a drive-letter folder directly');

    t.section('guestWorkspace "mirror"');
    const fallback = 'C:\\Workspace\\mw2-agent';
    const onF = planMirrorWorkspace('F:\\AgentProjects\\mw2-agent', fallback);
    t.equal(onF.guest, 'F:\\AgentProjects\\mw2-agent', 'a workspace on F: appears at its PC path (mirror + subst)');
    t.includes(
      onF.note ?? '',
      'C:\\Mirror\\F\\AgentProjects\\mw2-agent',
      'a workspace on F: comes with a note saying where it really is',
    );
    t.equal(
      planMirrorWorkspace('f:\\AgentProjects\\x\\', fallback).guest,
      'F:\\AgentProjects\\x',
      'a trailing backslash and a lower-case letter are normalised',
    );
    const onC = planMirrorWorkspace('C:\\dev\\mw2-agent', fallback);
    t.equal(
      { guest: onC.guest, note: onC.note },
      { guest: 'C:\\dev\\mw2-agent', note: null },
      'a workspace on C: outside reserved folders keeps its path',
    );
    const reserved = planMirrorWorkspace('C:\\Users\\josh\\mw2-agent', fallback);
    t.equal(reserved.guest, fallback, 'C:\\Users\\... falls back to C:\\Workspace\\<name>...');
    t.includes(reserved.note ?? '', 'reserved', '... with a note');
    t.equal(planMirrorWorkspace('\\\\server\\share\\mw2-agent', fallback).guest, fallback, 'UNC paths fall back');
    t.equal(planMirrorWorkspace('A:\\mw2-agent', fallback).guest, fallback, 'A: and B: fall back');

    const resolved = await f.run({}, { ...f.makeConfig(), guestWorkspace: 'mirror' });
    const expected = planMirrorWorkspace(f.workA, 'C:\\Workspace\\work-a');
    t.equal(resolved.config.guestWorkspace, expected.guest, 'resolveRun turns "mirror" into a concrete guest path');
    t.check(
      expected.note === null || resolved.notes.includes(expected.note),
      'resolveRun explains a fallback in run.notes',
      JSON.stringify(resolved.notes),
    );

    t.section('generating a sandbox with drive-letter folders');
    const game = t.dir('steam', 'Game');
    const base = await f.run();
    const run = {
      ...base,
      config: {
        ...base.config,
        guestWorkspace: 'G:\\Projects\\work-a',
        mappings: [{ host: game, guest: 'F:\\SteamLibrary\\steamapps\\common\\Game', readOnly: true }],
      },
    };
    const generated = f.generate(run);
    const session = f.readJson<GuestSession & { substDrives?: { letter: string; target: string }[] }>(
      generated.sessionPath,
    );
    const text = fs.readFileSync(generated.wsbPath, 'utf8');
    t.equal(session.workspace, 'G:\\Projects\\work-a', 'session.json: the workspace is at its drive-letter path');
    t.equal(
      session.substDrives,
      [
        { letter: 'F', target: 'C:\\Mirror\\F' },
        { letter: 'G', target: 'C:\\Mirror\\G' },
      ],
      'session.json: subst drives are listed for bootstrap.ps1',
    );
    t.includes(
      text,
      '<SandboxFolder>C:\\Mirror\\G\\Projects\\work-a</SandboxFolder>',
      '.wsb: the workspace is under C:\\Mirror',
    );
    t.includes(
      text,
      '<SandboxFolder>C:\\Mirror\\F\\SteamLibrary\\steamapps\\common\\Game</SandboxFolder>',
      '.wsb: the mapping is under C:\\Mirror',
    );
    t.equal(
      f.readJson<{ substDrives?: unknown[] }>(f.generate(base).sessionPath).substDrives,
      [],
      'no other drive letters: no subst drives',
    );

    t.section('where an extra folder goes: guest left out, or one the sandbox cannot use');
    t.equal(
      [
        deriveGuest('F:\\P\\mw2\\data\\maps', 'F:\\P\\mw2', 'C:\\Workspace\\mw2'),
        deriveGuest('C:\\Steam\\MOHAA', 'F:\\P\\mw2', 'C:\\Workspace\\mw2'),
        deriveGuest('f:\\SteamLibrary\\steamapps\\common\\MW2\\', 'F:\\P\\mw2', 'C:\\Workspace\\mw2'),
      ],
      ['C:\\Workspace\\mw2\\data\\maps', 'C:\\Steam\\MOHAA', 'F:\\SteamLibrary\\steamapps\\common\\MW2'],
      'no guest: inside the project = the same place in it; outside = the same path as on the PC (C: as is, F: through C:\\Mirror\\F + subst)',
    );
    const other = t.dir('steam', 'Other');
    const placed = (mappings: { host: string; guest?: string; readOnly: boolean }[]) => {
      const g = f.generate({ ...run, config: { ...run.config, mappings } });
      return {
        guests: g.mappings.filter((m) => m.host === game || m.host === other).map((m) => m.guest),
        notes: g.mappingNotes,
        wsb: fs.readFileSync(g.wsbPath, 'utf8'),
      };
    };
    const awkward = placed([
      { host: game, guest: 'C:\\Windows\\foo', readOnly: true },
      { host: game, guest: 'C:\\Users\\x', readOnly: true },
      { host: game, guest: 'C:\\AgentData\\y', readOnly: true },
      { host: game, guest: 'C:\\Mirror\\F\\x', readOnly: true },
      { host: game, guest: 'D:\\Games', readOnly: true },
      { host: game, guest: 'G:\\Projects\\work-a', readOnly: true },
      { host: game, guest: 'c:/assets/', readOnly: true },
      { host: other, guest: 'C:\\Assets', readOnly: true },
      { host: game, guest: 'C:\\Assets', readOnly: true },
    ]);
    t.equal(
      awkward.guests,
      [
        'C:\\Mapped\\C\\Windows\\foo',
        'C:\\Mapped\\C\\Users\\x',
        'C:\\Mapped\\C\\AgentData\\y',
        'C:\\Mapped\\C\\Mirror\\F\\x',
        'D:\\Games',
        'C:\\Mapped\\G\\Projects\\work-a',
        'C:\\assets',
        'C:\\Mapped\\C\\Assets',
      ],
      'reserved paths, C:\\Mirror and the workspace itself go to C:\\Mapped\\<drive>\\<path>; D:\\Games and a tidied c:/assets/ are used as they are; a repeat is mapped once; a second folder on the same path moves',
    );
    t.check(
      awkward.notes.some(
        (n) =>
          n.includes('C:\\Windows\\foo') && n.includes('keeps for itself') && n.includes('C:\\Mapped\\C\\Windows\\foo'),
      ),
      'a note says where a reserved path went and why',
      awkward.notes.join('\n'),
    );
    t.check(
      awkward.notes.some((n) => n.startsWith(other) && n.includes('already used by') && n.includes(game)),
      'a conflict note names both folders',
      awkward.notes.join('\n'),
    );
    t.check(
      !/<SandboxFolder>C:\\(Windows|Users|AgentData\\y|Mirror\\F\\x)/i.test(awkward.wsb),
      'a reserved guest path never reaches the .wsb',
    );
    const derived = placed([{ host: game, readOnly: true }]);
    t.check(
      derived.guests.length === 1 &&
        (/^C:\\Mapped\\C\\Users\\/i.test(derived.guests[0]) || derived.guests[0].toLowerCase() === game.toLowerCase()),
      'no guest, outside the project: the PC path, or C:\\Mapped\\... when that path is reserved (the temp folder is under C:\\Users)',
      JSON.stringify(derived),
    );
    const inside = t.dir('work-a', 'data');
    const insideRun = await f.run();
    const insideGen = f.generate({
      ...insideRun,
      config: { ...insideRun.config, mappings: [{ host: inside, readOnly: true }] },
    });
    t.check(
      !insideGen.mappings.some((m) => m.host === inside) &&
        insideGen.mappingNotes.some((n) => n.includes('already in the sandbox at C:\\Workspace\\work-a\\data')),
      'no guest, inside the project: already there, no second mapping',
      insideGen.mappingNotes.join('\n'),
    );
    const missingRequired = await t.thrownMessage(() =>
      f.generate({
        ...run,
        config: {
          ...run.config,
          mappings: [
            { host: t.at('nope-1'), readOnly: true },
            { host: t.at('nope-2'), guest: 'C:\\Windows', readOnly: true },
          ],
        },
      }),
    );
    t.check(
      missingRequired.includes('2 mapped folders cannot be used') &&
        missingRequired.includes('nope-1') &&
        missingRequired.includes('nope-2') &&
        missingRequired.includes('"optional": true'),
      'folders that are not there: one message listing each, with the fix',
      missingRequired,
    );

    t.section('exec, attach and history for a mirrored workspace');
    const workspace = 'F:\\AgentProjects\\mw2-agent';
    t.equal(
      guestPathFor(workspace + '\\crates\\engine', workspace, workspace),
      workspace + '\\crates\\engine',
      'a host folder maps to the same guest folder',
    );
    const project = projectFolderName(workspace);
    t.equal(project, 'F--AgentProjects-mw2-agent', 'the Claude project folder is the same on both sides');
    const sides = f.historySides('mirror', workspace, workspace);
    const hostProject = path.join(sides.hostClaudeDir, 'projects', project);
    const guestProject = path.join(sides.guestClaudeDir, 'projects', project);
    t.write(path.join(hostProject, 's1.jsonl'), '{"cwd":"F:\\\\AgentProjects\\\\mw2-agent","t":1}\n');
    t.write(
      path.join(sides.hostClaudeDir, 'history.jsonl'),
      '{"display":"hi","timestamp":1,"project":"F:\\\\AgentProjects\\\\mw2-agent"}\n',
    );
    syncHistoryIn(sides);
    t.includes(
      fs.readFileSync(path.join(guestProject, 's1.jsonl'), 'utf8'),
      'F:\\\\AgentProjects\\\\mw2-agent',
      'history in: paths are unchanged',
    );
    t.equal(
      fs.readdirSync(path.join(sides.guestClaudeDir, 'projects')).length,
      1,
      'history in: only the one project folder is created',
    );
    t.write(path.join(guestProject, 's2.jsonl'), '{"cwd":"F:\\\\AgentProjects\\\\mw2-agent","t":2}\n');
    const realPathProject = path.join(sides.guestClaudeDir, 'projects', 'C--Mirror-F-AgentProjects-mw2-agent');
    t.write(
      path.join(realPathProject, 's3.jsonl'),
      '{"cwd":"C:\\\\Mirror\\\\F\\\\AgentProjects\\\\mw2-agent","f":"C:/Mirror/F/AgentProjects/mw2-agent/src/main.rs"}\n',
    );
    fs.appendFileSync(
      path.join(sides.guestClaudeDir, 'history.jsonl'),
      '{"display":"real path","timestamp":2,"project":"C:\\\\Mirror\\\\F\\\\AgentProjects\\\\mw2-agent"}\n',
    );
    syncHistoryOut(sides);
    const s3 = path.join(hostProject, 's3.jsonl');
    t.check(fs.existsSync(path.join(hostProject, 's2.jsonl')), 'history out: transcripts under the PC path come back');
    t.check(
      fs.existsSync(s3),
      'history out: transcripts under the real C:\\Mirror path come back into the PC project folder',
    );
    t.check(
      !fs.existsSync(path.join(sides.hostClaudeDir, 'projects', 'C--Mirror-F-AgentProjects-mw2-agent')),
      'history out: no C:\\Mirror project folder appears on the PC',
    );
    const s3Text = fs.existsSync(s3) ? fs.readFileSync(s3, 'utf8') : '';
    t.includes(
      s3Text,
      '"cwd":"F:\\\\AgentProjects\\\\mw2-agent"',
      'history out: C:\\Mirror\\F\\... paths are translated back to F:\\...',
    );
    t.includes(s3Text, 'F:/AgentProjects/mw2-agent/src/main.rs', 'history out: forward-slash paths are translated too');
    t.excludes(s3Text, 'Mirror', 'history out: nothing mentions C:\\Mirror any more');
    const promptHistory = fs.readFileSync(path.join(sides.hostClaudeDir, 'history.jsonl'), 'utf8');
    t.includes(
      promptHistory,
      '"project":"F:\\\\AgentProjects\\\\mw2-agent"}',
      'prompt history out: real paths are translated',
    );
    t.excludes(promptHistory, 'Mirror', 'prompt history out: nothing mentions C:\\Mirror');
  },
};
