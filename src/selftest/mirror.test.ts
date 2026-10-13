// Guest paths on other drive letters (C:\Mirror\<letter> + subst) and guestWorkspace "mirror".
import fs from 'node:fs';
import path from 'node:path';
import type { GuestSession } from '../core/types.js';
import { Config, Mapping } from '../core/schema.js';
import { guestPathFor } from '../cli/commands/context.js';
import { buildWsb } from '../host/launch/wsb.js';
import {
  guestDrive,
  isValidGuestPath,
  planMirrorWorkspace,
  sandboxFolder,
  substDrives,
} from '../shared/guest-paths.js';
import { guestWorkspaceAliases, projectFolderName } from '../shared/paths.js';
import { syncHistoryIn, syncHistoryOut } from '../sync/history.js';
import type { Suite } from './suite.js';

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
    const mappingAccepts = (guest: string): boolean =>
      Mapping.safeParse({ host: 'E:\\Games', guest, readOnly: true }).success;
    t.check(
      mappingAccepts('F:\\SteamLibrary\\Game') && mappingAccepts('C:\\F'),
      'schema: mappings[].guest may be on another drive letter',
    );
    t.check(
      !mappingAccepts('C:\\Mirror\\F\\x') && !mappingAccepts('F:\\'),
      'schema: mappings[].guest may never be C:\\Mirror or a drive root',
    );
    const workspaceAccepts = (guestWorkspace: string): boolean =>
      Config.safeParse({ ...f.makeConfig(), guestWorkspace }).success;
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
    const withMapping = (guest: string) => ({
      ...run,
      config: { ...run.config, mappings: [{ host: game, guest, readOnly: true }] },
    });
    await t.throws(
      () => f.generate(withMapping('C:\\Mirror\\F\\x')),
      'not a usable sandbox folder',
      'a mapping straight into C:\\Mirror is refused',
    );
    await t.throws(
      () => f.generate(withMapping('C:\\Windows\\x')),
      'not a usable sandbox folder',
      'a reserved guest folder is refused by the host too (not only the schema)',
    );
    await t.throws(
      () => f.generate(withMapping('g:\\projects\\work-a\\game')),
      'overlapping',
      'mappings overlapping on the same mirrored drive are refused',
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
