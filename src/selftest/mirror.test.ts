// Guest paths on other drive letters (C:\Mirror\<letter> + subst) and guestWorkspace "mirror".
import fs from 'node:fs';
import path from 'node:path';
import type { GuestSession } from '../core/types.js';
import { ConfigSchema } from '../core/schema/index.js';
import { guestPathFor } from '../cli/commands/context.js';
import { buildWsb } from '../host/launch/index.js';
import {
  deriveGuest,
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
    const valid = ['C:\\Assets', 'F:\\SteamLibrary\\steamapps\\common\\Game', 'f:\\x', 'Z:\\a b\\c (1)'];
    t.equal(
      valid.filter((p) => !isValidGuestPath(p)),
      [],
      'guest paths under C:\\ or on D: to Z: are accepted',
    );
    const invalid = [
      'F:\\',
      'C:\\Windows\\x',
      'C:\\Users\\me',
      'C:\\AgentData\\x',
      'C:\\Mirror\\F\\x',
      'A:\\x',
      'C:\\a\\..\\Windows',
      'F:\\a:b',
      'F:\\a|b',
      '\\\\server\\share\\x',
      'relative\\x',
    ];
    t.equal(
      invalid.filter(isValidGuestPath),
      [],
      'drive roots, reserved folders, C:\\Mirror, A:/B:, .., streams, odd characters and UNC paths are refused',
    );
    const workspaceAccepts = (guestWorkspace: string): boolean =>
      ConfigSchema.safeParse({ ...f.makeConfig(), guestWorkspace }).success;
    t.check(
      workspaceAccepts('mirror') && workspaceAccepts('F:\\AgentProjects\\x') && !workspaceAccepts('C:\\Users\\x'),
      'schema: guestWorkspace accepts "mirror" and D:-Z: paths, and refuses reserved paths',
    );

    t.section('where a drive-letter path really lives');
    t.equal(
      [sandboxFolder('F:\\SteamLibrary\\Game'), sandboxFolder('C:\\Assets'), substDrives(['C:\\a', 'G:\\z', 'F:\\x'])],
      [
        'C:\\Mirror\\F\\SteamLibrary\\Game',
        'C:\\Assets',
        [
          { letter: 'F', target: 'C:\\Mirror\\F' },
          { letter: 'G', target: 'C:\\Mirror\\G' },
        ],
      ],
      'F:\\x really lives at C:\\Mirror\\F\\x; C: paths stay; one subst drive per used letter (never C:)',
    );
    t.equal(
      [guestWorkspaceAliases('F:\\AgentProjects\\mw2'), guestWorkspaceAliases('C:\\Workspace\\x').length],
      [['C:\\Mirror\\F\\AgentProjects\\mw2', 'F:\\AgentProjects\\mw2'], 1],
      'a mirrored workspace is also known by its real C:\\Mirror path; a C: workspace has no alias',
    );
    const wsb = buildWsb(f.baseConfig, 4096, [
      {
        host: 'E:\\SteamLibrary\\steamapps\\common\\Game',
        guest: 'F:\\SteamLibrary\\steamapps\\common\\Game',
        readOnly: true,
      },
      { host: 'D:\\Assets', guest: 'C:\\Assets', readOnly: false },
    ]);
    t.check(
      wsb.includes('<SandboxFolder>C:\\Mirror\\F\\SteamLibrary\\steamapps\\common\\Game</SandboxFolder>') &&
        wsb.includes('<SandboxFolder>C:\\Assets</SandboxFolder>') &&
        !wsb.includes('<SandboxFolder>F:'),
      'the .wsb maps F:\\ guests under C:\\Mirror\\F, C:\\ guests as they are, and never a drive letter directly',
    );

    t.section('guestWorkspace "mirror"');
    const fallback = 'C:\\Workspace\\mw2-agent';
    const onF = planMirrorWorkspace('F:\\AgentProjects\\mw2-agent', fallback);
    const onC = planMirrorWorkspace('C:\\dev\\mw2-agent', fallback);
    const reserved = planMirrorWorkspace('C:\\Users\\josh\\mw2-agent', fallback);
    t.check(
      onF.guest === 'F:\\AgentProjects\\mw2-agent' &&
        (onF.note ?? '').includes('C:\\Mirror\\F\\AgentProjects\\mw2-agent') &&
        planMirrorWorkspace('f:\\AgentProjects\\x\\', fallback).guest === 'F:\\AgentProjects\\x' &&
        onC.guest === 'C:\\dev\\mw2-agent' &&
        onC.note === null,
      'a workspace on F: appears at its PC path with a note where it really is; one on C: outside reserved folders keeps its path',
    );
    t.check(
      reserved.guest === fallback &&
        (reserved.note ?? '').includes('reserved') &&
        planMirrorWorkspace('\\\\server\\share\\mw2-agent', fallback).guest === fallback &&
        planMirrorWorkspace('A:\\mw2-agent', fallback).guest === fallback,
      'C:\\Users\\..., UNC paths and A:/B: fall back to C:\\Workspace\\<name> (with a note for reserved)',
    );
    const resolved = await f.run({}, { ...f.makeConfig(), guestWorkspace: 'mirror' });
    const expected = planMirrorWorkspace(f.workA, 'C:\\Workspace\\work-a');
    t.check(
      resolved.config.guestWorkspace === expected.guest &&
        (expected.note === null || resolved.notes.includes(expected.note)),
      'resolveRun turns "mirror" into a concrete guest path and explains a fallback in run.notes',
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
    t.check(
      session.workspace === 'G:\\Projects\\work-a' &&
        session.substDrives?.map((d) => d.letter).join() === 'F,G' &&
        text.includes('<SandboxFolder>C:\\Mirror\\G\\Projects\\work-a</SandboxFolder>') &&
        text.includes('<SandboxFolder>C:\\Mirror\\F\\SteamLibrary\\steamapps\\common\\Game</SandboxFolder>') &&
        f.readJson<{ substDrives?: unknown[] }>(f.generate(base).sessionPath).substDrives?.length === 0,
      'session.json lists the subst drives for bootstrap.ps1 and the .wsb maps workspace and folders under C:\\Mirror; no other letters, no subst drives',
    );

    t.section('where an extra folder goes: guest left out, or one the sandbox cannot use');
    t.equal(
      [
        deriveGuest('F:\\P\\mw2\\data\\maps', 'F:\\P\\mw2', 'C:\\Workspace\\mw2'),
        deriveGuest('C:\\Steam\\MOHAA', 'F:\\P\\mw2', 'C:\\Workspace\\mw2'),
        deriveGuest('f:\\SteamLibrary\\steamapps\\common\\MW2\\', 'F:\\P\\mw2', 'C:\\Workspace\\mw2'),
      ],
      ['C:\\Workspace\\mw2\\data\\maps', 'C:\\Steam\\MOHAA', 'F:\\SteamLibrary\\steamapps\\common\\MW2'],
      'no guest: inside the project = the same place in it; outside = the same path as on the PC',
    );
    const other = t.dir('steam', 'Other');
    const placed = (mappings: { host: string; guest?: string; readOnly: boolean }[]) => {
      const g = f.generate({ ...run, config: { ...run.config, mappings } });
      return g.mappings.filter((m) => m.host === game || m.host === other).map((m) => m.guest);
    };
    t.equal(
      placed([
        { host: game, guest: 'D:\\Games', readOnly: true },
        { host: game, guest: 'c:/assets/', readOnly: true },
        { host: game, guest: 'C:\\assets', readOnly: true },
      ]),
      ['D:\\Games', 'C:\\assets'],
      'a usable guest path is used as asked (c:/assets/ tidied); the same folder at the same place is mapped once',
    );
    const refused = await t.thrownMessage(() =>
      placed([
        { host: game, guest: 'C:\\Windows\\foo', readOnly: true },
        { host: game, guest: 'steamapps\\Game', readOnly: true },
        { host: game, guest: 'G:\\Projects\\work-a', readOnly: true },
        { host: game, guest: 'C:\\Assets', readOnly: true },
        { host: other, guest: 'C:\\Assets', readOnly: true },
      ]),
    );
    t.check(
      refused.includes('4 mapped folders cannot be used') &&
        refused.includes('C:\\Windows\\foo is a folder the sandbox keeps for itself') &&
        refused.includes('steamapps\\Game is not a full path') &&
        refused.includes('already used by') &&
        refused.includes('Fix: set "guest" to a full path') &&
        !refused.includes('C:\\Mapped'),
      'unusable guest paths stop the launch, all named in one message with why and the fix (never moved elsewhere)',
      refused,
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
        missingRequired.includes('"optional": true'),
      'folders that are not there: one message listing each, with the fix',
      missingRequired,
    );

    t.section('exec, attach and history for a mirrored workspace');
    const workspace = 'F:\\AgentProjects\\mw2-agent';
    const project = projectFolderName(workspace);
    t.check(
      guestPathFor(workspace + '\\crates\\engine', workspace, workspace) === workspace + '\\crates\\engine' &&
        project === 'F--AgentProjects-mw2-agent',
      'a host folder maps to the same guest folder, and the Claude project folder is the same on both sides',
    );
    const sides = f.historySides('mirror', workspace, workspace);
    const hostProject = path.join(sides.hostClaudeDir, 'projects', project);
    const guestProject = path.join(sides.guestClaudeDir, 'projects', project);
    t.write(path.join(hostProject, 's1.jsonl'), '{"cwd":"F:\\\\AgentProjects\\\\mw2-agent","t":1}\n');
    t.write(
      path.join(sides.hostClaudeDir, 'history.jsonl'),
      '{"display":"hi","timestamp":1,"project":"F:\\\\AgentProjects\\\\mw2-agent"}\n',
    );
    syncHistoryIn(sides);
    t.check(
      fs.readFileSync(path.join(guestProject, 's1.jsonl'), 'utf8').includes('F:\\\\AgentProjects\\\\mw2-agent') &&
        fs.readdirSync(path.join(sides.guestClaudeDir, 'projects')).length === 1,
      'history in: paths are unchanged and only the one project folder is created',
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
    const s3Text = fs.existsSync(s3) ? fs.readFileSync(s3, 'utf8') : '';
    t.check(
      fs.existsSync(path.join(hostProject, 's2.jsonl')) &&
        !fs.existsSync(path.join(sides.hostClaudeDir, 'projects', 'C--Mirror-F-AgentProjects-mw2-agent')) &&
        s3Text.includes('"cwd":"F:\\\\AgentProjects\\\\mw2-agent"') &&
        s3Text.includes('F:/AgentProjects/mw2-agent/src/main.rs') &&
        !s3Text.includes('Mirror'),
      'history out: transcripts under the PC path or the real C:\\Mirror path land in the PC project folder with paths translated back',
    );
    const promptHistory = fs.readFileSync(path.join(sides.hostClaudeDir, 'history.jsonl'), 'utf8');
    t.check(
      promptHistory.includes('"project":"F:\\\\AgentProjects\\\\mw2-agent"}') && !promptHistory.includes('Mirror'),
      'prompt history out: real paths are translated',
    );
  },
};
