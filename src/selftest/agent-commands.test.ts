// Agent commands (Beta): which agents get a forwarding command, what the files contain, and that "off" changes nothing.
// Everything happens in the test's temp folder with a made-up PATH; your real PATH is never read or written.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '../core/config.js';
import { agentCommands, commandsDir, forwardingCmd, forwardingSh, realAgent, reconcileAgentCommands } from '../host/agent-commands.js';
import type { Harness } from './harness.js';

export const agentCommandTests = (t: Harness): void => {
  const { check } = t;
  t.section('agent commands (Beta)');
  const storage = path.join(t.temp, 'agent-cmd-storage');
  const npmDir = path.join(t.temp, 'agent-cmd-npm');
  const localBin = path.join(t.temp, 'agent-cmd-local');
  t.write(path.join(npmDir, 'codex.cmd'), '@echo codex');
  t.write(path.join(npmDir, 'gemini.cmd'), '@echo gemini');
  t.write(path.join(localBin, 'claude.exe'), 'MZ');
  // A forwarding file of our own, first on PATH, must never count as the real agent.
  t.write(path.join(commandsDir(storage), 'claude.cmd'), '@rem windows-development-sandbox agent command');
  const PATH = [commandsDir(storage), npmDir, localBin].join(path.delimiter);

  check(realAgent('claude', commandsDir(storage), PATH) === path.join(localBin, 'claude.exe') && realAgent('nope', commandsDir(storage), PATH) === null,
    'the real agent is found on PATH, skipping this tool\'s own forwarding files');

  const on = { ...DEFAULTS, agentCommands: { enabled: true, agents: 'auto' as const } };
  const found = agentCommands(on, storage, PATH).map((a) => a.command).sort().join(',');
  check(found === 'claude,codex,gemini', '"auto": every agent installed on this PC gets a command, agents not installed none (' + found + ')');
  const picked = agentCommands({ ...on, agentCommands: { enabled: true, agents: ['codex'] } }, storage, PATH).map((a) => a.command).join(',');
  check(picked === 'codex', 'a list limits it to the named agents');

  const claude = { harness: 'claude', command: 'claude', real: path.join(localBin, 'claude.exe') };
  const cmd = forwardingCmd(claude, 'C:\\node\\node.exe', 'C:\\tool\\dist\\bin\\sandbox.js');
  check(cmd.includes('"C:\\node\\node.exe" "C:\\tool\\dist\\bin\\sandbox.js" launch --harness claude --headless --terminal -- %*') && cmd.includes('if "%SANDBOX_AGENT_DIRECT%"=="1" goto direct') && cmd.includes('call "' + claude.real + '" %*'),
    'the .cmd starts the agent in a hidden sandbox attached to this terminal, or the real one with SANDBOX_AGENT_DIRECT=1');
  const sh = forwardingSh({ ...claude, real: 'C:\\Users\\me\\it\'s\\claude.exe' }, 'C:\\node\\node.exe', 'C:\\tool\\sandbox.js');
  check(sh.startsWith('#!/bin/sh') && sh.includes("exec '/c/node/node.exe' '/c/tool/sandbox.js' launch --harness claude --headless --terminal -- \"$@\"") && sh.includes("'/c/Users/me/it'\\''s/claude.exe'"),
    'Git Bash gets the same, with POSIX paths quoted safely');

  const unsafe = path.join(t.temp, 'agent%cmd^dir');
  t.write(path.join(unsafe, 'aider.cmd'), '@echo');
  check(!agentCommands(on, storage, unsafe).some((a) => a.command === 'aider'), 'an agent in a folder whose path has % or ^ (which cmd.exe would expand) is left alone');

  // Off with nothing set up: nothing to do, no PATH edit (which would be refused during the self-test anyway).
  const fresh = path.join(t.temp, 'agent-cmd-fresh');
  const off = reconcileAgentCommands(DEFAULTS, fresh, 'C:\\node\\node.exe', 'C:\\tool\\sandbox.js');
  check(!off.on && !off.changed && !fs.existsSync(commandsDir(fresh)), 'off (the default) writes nothing and leaves your PATH alone');
  let refused = false;
  try { reconcileAgentCommands(on, path.join(t.temp, 'agent-cmd-on'), 'C:\\node\\node.exe', 'C:\\tool\\sandbox.js'); } catch { refused = true; }
  check(refused, 'turning it on edits your PATH, which the self-test refuses (it never changes this PC)');
};
