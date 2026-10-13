import type { AgentCommand } from './commands.js';

/** Marks files this tool wrote, so only those are ever replaced or removed. */
export const MARKER = 'windows-development-sandbox agent command';

/** The .cmd file for one agent (cmd, PowerShell and Windows Terminal all run it). */
export const forwardingCmd = (a: AgentCommand, node: string, entry: string): string =>
  [
    '@echo off',
    'rem ' + MARKER + ' (Beta). Turn off: sandbox agent-commands off. Run the real one: set SANDBOX_AGENT_DIRECT=1',
    'if "%SANDBOX_AGENT_DIRECT%"=="1" goto direct',
    '"' + node + '" "' + entry + '" launch --harness ' + a.harness + ' --headless --terminal -- %*',
    'exit /b %errorlevel%',
    ':direct',
    'call "' + a.real + '" %*',
    '',
  ].join('\r\n');

/** The same for Git Bash, which looks for a file without an extension. */
export const forwardingSh = (a: AgentCommand, node: string, entry: string): string => {
  const posix = (p: string): string =>
    p.replace(/^([A-Za-z]):/, (_m, d: string) => '/' + d.toLowerCase()).replace(/\\/g, '/');
  const q = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";
  return [
    '#!/bin/sh',
    '# ' + MARKER + ' (Beta). Turn off: sandbox agent-commands off. Run the real one: SANDBOX_AGENT_DIRECT=1',
    'if [ "$SANDBOX_AGENT_DIRECT" = "1" ]; then exec ' + q(posix(a.real)) + ' "$@"; fi',
    'exec ' +
      q(posix(node)) +
      ' ' +
      q(posix(entry)) +
      ' launch --harness ' +
      a.harness +
      ' --headless --terminal -- "$@"',
    '',
  ].join('\n');
};
