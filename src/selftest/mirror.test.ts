// Guest paths on other drive letters (C:\Mirror\<letter> + subst) and guestWorkspace "mirror".
import fs from 'node:fs';
import path from 'node:path';
import type { GuestSession } from '../core/types.js';
import { Config, Mapping } from '../core/schema.js';
import { guestPathFor } from '../cli/commands/context.js';
import { buildWsb } from '../host/generate.js';
import { guestDrive, isValidGuestPath, planMirrorWorkspace, sandboxFolder, substDrives } from '../shared/guest-paths.js';
import { guestWorkspaceAliases, projectFolderName } from '../shared/paths.js';
import { syncHistoryIn, syncHistoryOut } from '../sync/history.js';
import type { Fixtures } from './fixtures.js';
import type { Harness } from './harness.js';

export const mirrorTests = async (t: Harness, f: Fixtures): Promise<void> => {
  const { check, rejects, write } = t;

  t.section('mirrored guest paths (other drive letters)');
  check(['C:\\Assets', 'C:\\Workspace\\x', 'F:\\SteamLibrary\\steamapps\\common\\Game', 'f:\\x', 'Z:\\a b\\c (1)'].every(isValidGuestPath), 'guest paths under C:\\ or on D: to Z: are accepted');
  check(!['C:\\', 'F:\\', 'F:', 'C:\\Windows\\x', 'C:\\Users\\me', 'c:\\program files\\x', 'C:\\AgentData\\x', 'C:\\Mirror', 'C:\\Mirror\\F\\x', 'A:\\x', 'B:\\x', 'C:\\a\\..\\Windows', 'F:\\a\\..\\b', 'F:\\a:b', 'F:\\a/b', 'F:\\a\\\\b', 'F:\\a.\\b', 'F:\\a|b', 'F:\\a\nb', '\\\\server\\share\\x', 'relative\\x', 'F:x'].some(isValidGuestPath), 'drive roots, reserved folders, C:\\Mirror, A:/B:, .., streams, odd characters and UNC paths are refused');
  const mapping = (guest: string): boolean => Mapping.safeParse({ host: 'E:\\Games', guest, readOnly: true }).success;
  check(mapping('F:\\SteamLibrary\\Game') && !mapping('C:\\Mirror\\F\\x') && mapping('C:\\F') &&!mapping('F:\\'), 'schema: mappings[].guest may be on another drive letter, never C:\\Mirror or a drive root');
  check(Config.safeParse({ ...f.makeConfig(), guestWorkspace: 'mirror' }).success && Config.safeParse({ ...f.makeConfig(), guestWorkspace: 'F:\\AgentProjects\\x' }).success && !Config.safeParse({ ...f.makeConfig(), guestWorkspace: 'C:\\Users\\x' }).success, 'schema: guestWorkspace accepts "mirror" and D:-Z: paths, refuses reserved ones');
  check(guestDrive('f:\\x') === 'F' && guestDrive('\\\\s\\x') === null, 'drive letter of a guest path');
  check(sandboxFolder('F:\\SteamLibrary\\Game') === 'C:\\Mirror\\F\\SteamLibrary\\Game' && sandboxFolder('f:\\x') === 'C:\\Mirror\\F\\x' && sandboxFolder('C:\\Assets') === 'C:\\Assets', 'F:\\x really lives at C:\\Mirror\\F\\x; C: paths stay as they are');
  check(JSON.stringify(substDrives(['C:\\a', 'G:\\z', 'F:\\x', 'f:\\y'])) === JSON.stringify([{ letter: 'F', target: 'C:\\Mirror\\F' }, { letter: 'G', target: 'C:\\Mirror\\G' }]), 'one subst drive per used letter (never C:), sorted');
  check(JSON.stringify(guestWorkspaceAliases('F:\\AgentProjects\\mw2')) === JSON.stringify(['C:\\Mirror\\F\\AgentProjects\\mw2', 'F:\\AgentProjects\\mw2']) && guestWorkspaceAliases('C:\\Workspace\\x').length === 1, 'a mirrored workspace is also known by its real C:\\Mirror path');

  const wsb = buildWsb(f.baseConfig, 4096, [{ host: 'E:\\SteamLibrary\\steamapps\\common\\Game', guest: 'F:\\SteamLibrary\\steamapps\\common\\Game', readOnly: true }, { host: 'D:\\Assets', guest: 'C:\\Assets', readOnly: false }]);
  check(wsb.includes('<SandboxFolder>C:\\Mirror\\F\\SteamLibrary\\steamapps\\common\\Game</SandboxFolder>') && wsb.includes('<SandboxFolder>C:\\Assets</SandboxFolder>') && !wsb.includes('<SandboxFolder>F:'), 'the .wsb maps F:\\ guests under C:\\Mirror\\F');

  t.section('guestWorkspace "mirror"');
  const fallback = 'C:\\Workspace\\mw2-agent';
  const onF = planMirrorWorkspace('F:\\AgentProjects\\mw2-agent', fallback);
  check(onF.guest === 'F:\\AgentProjects\\mw2-agent' && (onF.note ?? '').includes('C:\\Mirror\\F\\AgentProjects\\mw2-agent'), 'a workspace on F: appears at its PC path (mirror + subst), with a note');
  check(planMirrorWorkspace('f:\\AgentProjects\\x\\', fallback).guest === 'F:\\AgentProjects\\x', 'trailing backslash and lower-case letter are normalised');
  const onC = planMirrorWorkspace('C:\\dev\\mw2-agent', fallback);
  check(onC.guest === 'C:\\dev\\mw2-agent' && onC.note === null, 'a workspace on C: outside reserved folders keeps its path');
  const reserved = planMirrorWorkspace('C:\\Users\\josh\\mw2-agent', fallback);
  check(reserved.guest === fallback && (reserved.note ?? '').includes('reserved'), 'C:\\Users\\... falls back to C:\\Workspace\\<name> with a note');
  check(planMirrorWorkspace('\\\\server\\share\\mw2-agent', fallback).guest === fallback && planMirrorWorkspace('A:\\mw2-agent', fallback).guest === fallback, 'UNC paths and A:/B: fall back too');

  const mirrorConfig = { ...f.makeConfig(), guestWorkspace: 'mirror' };
  const resolved = await f.run({}, mirrorConfig);
  const expected = planMirrorWorkspace(f.workA, 'C:\\Workspace\\work-a');
  check(resolved.config.guestWorkspace === expected.guest && (expected.note === null || resolved.notes.includes(expected.note)), 'resolveRun turns "mirror" into a concrete guest path (and explains a fallback in run.notes)');

  t.section('generate: mirrored mappings and workspace');
  const game = f.at('steam', 'Game');
  fs.mkdirSync(game, { recursive: true });
  const base = await f.run();
  const run = { ...base, config: { ...base.config, guestWorkspace: 'G:\\Projects\\work-a', mappings: [{ host: game, guest: 'F:\\SteamLibrary\\steamapps\\common\\Game', readOnly: true }] } };
  const generated = f.generate(run);
  const session = f.readJson(generated.sessionPath) as GuestSession & { substDrives?: { letter: string; target: string }[] };
  const text = fs.readFileSync(generated.wsbPath, 'utf8');
  check(session.workspace === 'G:\\Projects\\work-a' && JSON.stringify(session.substDrives) === JSON.stringify([{ letter: 'F', target: 'C:\\Mirror\\F' }, { letter: 'G', target: 'C:\\Mirror\\G' }]), 'session.json: workspace at its drive-letter path, subst drives listed for bootstrap.ps1');
  check(text.includes('<SandboxFolder>C:\\Mirror\\G\\Projects\\work-a</SandboxFolder>') && text.includes('<SandboxFolder>C:\\Mirror\\F\\SteamLibrary\\steamapps\\common\\Game</SandboxFolder>'), '.wsb: workspace and mapping under C:\\Mirror');
  check(JSON.stringify((f.readJson(f.generate(base).sessionPath) as { substDrives?: unknown[] }).substDrives) === '[]', 'no other drive letters: no subst drives');
  check(await rejects(() => f.generate({ ...run, config: { ...run.config, mappings: [{ host: game, guest: 'C:\\Mirror\\F\\x', readOnly: true }] } }), 'not a usable sandbox folder'), 'a mapping straight into C:\\Mirror is refused');
  check(await rejects(() => f.generate({ ...run, config: { ...run.config, mappings: [{ host: game, guest: 'C:\\Windows\\x', readOnly: true }] } }), 'not a usable sandbox folder'), 'a reserved guest folder is refused by the host too (not only the schema)');
  check(await rejects(() => f.generate({ ...run, config: { ...run.config, mappings: [{ host: game, guest: 'g:\\projects\\work-a\\game', readOnly: true }] } }), 'overlapping'), 'mappings overlapping on the same mirrored drive are refused');

  t.section('exec / attach cwd and history for a mirrored workspace');
  const ws = 'F:\\AgentProjects\\mw2-agent';
  check(guestPathFor(ws + '\\crates\\engine', ws, ws) === ws + '\\crates\\engine', 'a host folder maps to the same guest folder');

  const hostDot = f.at('mirror-host-claude');
  const guestDot = f.at('mirror-guest-claude');
  const project = projectFolderName(ws);
  check(project === 'F--AgentProjects-mw2-agent', 'Claude project folder for F:\\AgentProjects\\mw2-agent is F--AgentProjects-mw2-agent on both sides');
  write(path.join(hostDot, 'projects', project, 's1.jsonl'), '{"cwd":"F:\\\\AgentProjects\\\\mw2-agent","t":1}\n');
  write(path.join(hostDot, 'history.jsonl'), '{"display":"hi","timestamp":1,"project":"F:\\\\AgentProjects\\\\mw2-agent"}\n');
  const paths = { hostClaudeDir: hostDot, guestClaudeDir: guestDot, hostWorkspace: ws, guestWorkspace: ws };
  syncHistoryIn(paths);
  check(fs.readFileSync(path.join(guestDot, 'projects', project, 's1.jsonl'), 'utf8').includes('F:\\\\AgentProjects\\\\mw2-agent') && fs.readdirSync(path.join(guestDot, 'projects')).length === 1, 'history in: same folder name, paths unchanged');
  write(path.join(guestDot, 'projects', project, 's2.jsonl'), '{"cwd":"F:\\\\AgentProjects\\\\mw2-agent","t":2}\n');
  write(path.join(guestDot, 'projects', 'C--Mirror-F-AgentProjects-mw2-agent', 's3.jsonl'), '{"cwd":"C:\\\\Mirror\\\\F\\\\AgentProjects\\\\mw2-agent","f":"C:/Mirror/F/AgentProjects/mw2-agent/src/main.rs"}\n');
  fs.appendFileSync(path.join(guestDot, 'history.jsonl'), '{"display":"real path","timestamp":2,"project":"C:\\\\Mirror\\\\F\\\\AgentProjects\\\\mw2-agent"}\n');
  syncHistoryOut(paths);
  const s3 = path.join(hostDot, 'projects', project, 's3.jsonl');
  check(fs.existsSync(path.join(hostDot, 'projects', project, 's2.jsonl')) && fs.existsSync(s3) && !fs.existsSync(path.join(hostDot, 'projects', 'C--Mirror-F-AgentProjects-mw2-agent')), 'history out: transcripts under the real C:\\Mirror path come back into the PC project folder');
  const s3Text = fs.existsSync(s3) ? fs.readFileSync(s3, 'utf8') : '';
  check(s3Text.includes('"cwd":"F:\\\\AgentProjects\\\\mw2-agent"') && s3Text.includes('F:/AgentProjects/mw2-agent/src/main.rs') && !s3Text.includes('Mirror'), 'history out: C:\\Mirror\\F\\... paths are translated back to F:\\...');
  const hist = fs.readFileSync(path.join(hostDot, 'history.jsonl'), 'utf8');
  check(hist.includes('"project":"F:\\\\AgentProjects\\\\mw2-agent"}') && !hist.includes('Mirror'), 'prompt history out: real paths translated too');
};
