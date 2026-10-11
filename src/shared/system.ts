// Absolute paths for the Windows programs agent-sandbox runs. Never spawn them by bare name: Windows looks in the
// current folder before PATH, and the current folder is often the workspace, which the sandbox can write.
import path from 'node:path';

const systemRoot = (): string => process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';

export const system32 = (exe: string): string => path.join(systemRoot(), 'System32', exe);

export const SYSTEM = {
  cmd: (): string => system32('cmd.exe'),
  powershell: (): string => system32('WindowsPowerShell\\v1.0\\powershell.exe'),
  tasklist: (): string => system32('tasklist.exe'),
  tar: (): string => system32('tar.exe'),
  reg: (): string => system32('reg.exe'),
  netsh: (): string => system32('netsh.exe'),
  route: (): string => system32('ROUTE.EXE'),
  ipconfig: (): string => system32('ipconfig.exe'),
  robocopy: (): string => system32('Robocopy.exe'),
  shutdown: (): string => system32('shutdown.exe'),
  dism: (): string => system32('Dism.exe'),
} as const;
