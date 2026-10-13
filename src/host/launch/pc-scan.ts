// What this PC has installed (languages on PATH, MSVC for Rust, database services), so `auto` settings can follow it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pcHasPwsh } from '../../core/detect/index.js';
import { databasesFromServices, type Database } from '../../core/detect/index.js';
import { AUTO_TOOLCHAINS, type AutoToolchain } from '../../core/detect/index.js';
import { captureOutput, isWin } from '../../core/util/index.js';
import { system32 } from '../../shared/system.js';

/** This PC builds Rust with MSVC: rustup's default host is *-msvc (read from rustup's settings; nothing is run). */
const msvcRust = (): boolean => {
  const settings = path.join(process.env.RUSTUP_HOME ?? path.join(os.homedir(), '.rustup'), 'settings.toml');
  try {
    return /default_host_triple\s*=\s*"[^"]*-msvc"/.test(fs.readFileSync(settings, 'utf8').slice(0, 64 * 1024));
  } catch {
    return false;
  }
};

/** Languages this PC has (their commands on PATH; Windows' Store stubs for python do not count). */
export const pcLanguages = (): AutoToolchain[] => {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter((d) => d && !/WindowsApps/i.test(d));
  const has = (...names: string[]): boolean => dirs.some((d) => names.some((n) => fs.existsSync(path.join(d, n))));
  const found: Record<AutoToolchain, boolean> = {
    python: has('python.exe', 'py.exe'),
    rust: has('cargo.exe', 'rustc.exe'),
    cpp: has('gcc.exe', 'g++.exe', 'cl.exe', 'clang.exe'),
    msvc: msvcRust(),
    pwsh: pcHasPwsh(),
    dotnet: has('dotnet.exe'),
    go: has('go.exe'),
    java: has('java.exe', 'javac.exe'),
    ruby: has('ruby.exe'),
    php: has('php.exe'),
    deno: has('deno.exe'),
  };
  return AUTO_TOOLCHAINS.filter((t) => found[t]);
};

/** Database services installed on this PC (names from the service control manager; nothing is started or changed). */
export const hostDatabases = (): Database[] => {
  if (!isWin) return [];
  const output = captureOutput(system32('sc.exe'), ['query', 'type=', 'service', 'state=', 'all'], { timeout: 10000 });
  const names = [...output.matchAll(/^SERVICE_NAME:\s*(.+)$/gm)].map((m) => m[1].trim());
  return databasesFromServices(names);
};
