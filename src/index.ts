import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { doctor, hostClaude, installCommands, probeHost, startSandbox } from './host.js';
import { generateSandbox } from './sandbox.js';
import { selfTest } from './selftest.js';
import { errMsg, expandPath } from './util.js';
import { askYesNo, resolveRun } from './workspace.js';
import { LOCAL_CONFIG_NAME } from './localconfig.js';
import type { CliOptions } from './types.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = [
  'agent-sandbox <command> [options] [-- <agent arguments>]',
  '',
  'Run it from ANY folder: that folder becomes the sandbox workspace (read/write). Nothing else is writable.',
  '',
  'Commands:',
  '  launch            generate + start the Windows Sandbox and run the agent in it',
  '  generate          generate the .wsb and launch folder only',
  '  doctor            check this PC and show what will be copied/installed',
  '  host-claude       run Claude on THIS PC (no sandbox) with a separate profile',
  '  install-commands  add claude-sbx / claude-host / agent-sandbox to your PATH',
  '  self-test         run the built-in offline test suite',
  '',
  'Options:',
  '  --config <file>     tool config (default: config.json next to this tool)',
  '  --workspace <dir>   use this folder instead of the current directory',
  '  --harness <name>    claude | codex | gemini | ... (default from config / ' + LOCAL_CONFIG_NAME + ')',
  '  --project <name>    use a named preset from config.json "projects" (optional, legacy)',
  '  --script <file>     also run this .ps1/.mjs/.cmd inside the sandbox before the agent (repeatable)',
  '  --no-agent          provision and open a shell without starting an agent',
  '  --trust-config      approve this folder\'s ' + LOCAL_CONFIG_NAME + ' without asking',
  '  --no-local-config   ignore ' + LOCAL_CONFIG_NAME + ' in the folder',
  '  --shadow            (install-commands) also create "claude" that launches the sandbox',
  '  --personal          (host-claude) use your normal Claude profile',
].join('\n');

function parse(argv: string[]): CliOptions {
  const [command, ...rest] = argv;
  const options: CliOptions = { command: command ?? '', config: path.join(projectRoot, 'config.json'), here: false, scripts: [], harnessArgs: [], shadow: false, personal: false, noAgent: false, noLocalConfig: false, trustConfig: false };
  let passthrough = false;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (passthrough) { options.harnessArgs.push(token); continue; }
    const value = (): string => { const next = rest[++i]; if (next === undefined) throw new Error(token + ' needs a value'); return next; };
    switch (token) {
      case '--': passthrough = true; break;
      case '--config': options.config = path.resolve(value()); break;
      case '--project': options.project = value(); break;
      case '--harness': options.harness = value(); break;
      case '--workspace': options.workspace = path.resolve(value()); break;
      case '--script': options.scripts.push(value()); break;
      case '--here': options.here = true; break;
      case '--no-agent': options.noAgent = true; break;
      case '--trust-config': options.trustConfig = true; break;
      case '--no-local-config': options.noLocalConfig = true; break;
      case '--shadow': options.shadow = true; break;
      case '--personal': options.personal = true; break;
      default: throw new Error('Unknown option: ' + token);
    }
  }
  return options;
}

async function run(): Promise<number> {
  const options = parse(process.argv.slice(2));
  if (!['launch', 'generate', 'doctor', 'host-claude', 'install-commands', 'self-test'].includes(options.command)) { console.log(USAGE); return options.command ? 1 : 0; }
  if (options.command === 'self-test') return selfTest(projectRoot);
  if (options.command === 'install-commands') { installCommands(projectRoot, options.shadow); return 0; }

  const loaded = loadConfig(options.config);
  if (options.command === 'host-claude') return hostClaude(expandPath(loaded.config.storage.root, loaded.base), path.join(projectRoot, 'bin'), options.personal, options.harnessArgs);
  if (options.command === 'doctor') { doctor(loaded.config, options.harness ?? loaded.config.defaultHarness); return 0; }

  const resolved = await resolveRun({ projectRoot, loaded, cwd: process.cwd(), project: options.project, workspace: options.workspace, harness: options.harness, noAgent: options.noAgent, noLocalConfig: options.noLocalConfig, trustConfig: options.trustConfig, scripts: options.scripts, ask: askYesNo });
  const config = resolved.config;
  const probe = probeHost(config, resolved.harnessName);
  const generated = generateSandbox({ projectRoot, config, base: loaded.base, dataName: resolved.dataName, harnessName: resolved.harnessName, harnessArgs: options.harnessArgs, workspaceHost: resolved.workspaceHost, scripts: resolved.scripts, probe });

  for (const note of resolved.notes) console.log(note);
  console.log('Workspace:  ' + generated.workspaceHost + '  ->  ' + config.guestWorkspace + (config.readOnly ? '  (read-only)' : '  (read/write)'));
  console.log('Agent:      ' + resolved.harnessName + '   Memory: ' + generated.memoryMb + ' MB   vGPU: ' + config.sandbox.vGpu + '   Network: ' + config.sandbox.networking);
  console.log('Provision:  ' + (config.provisioning.copyFromHost ? 'copy from this PC' + (probe.nodeDir ? ' (node: ' + probe.nodeDir + ')' : ' (no host node found)') + (probe.harnessExe ? ' (' + resolved.harnessName + ': ' + path.join(probe.harnessExe.dir, probe.harnessExe.file) + ')' : ' (no host ' + resolved.harnessName + ' found)') + (config.provisioning.fallbackToInstall ? ', falling back to install' : '') : 'install inside the sandbox'));
  if (resolved.harnessName === 'claude') console.log('Claude settings: ' + (generated.profile.staged.length ? 'copied ' + generated.profile.staged.join(', ') + (generated.profile.credentials ? '  (INCLUDING YOUR LOGIN)' : '') : 'none copied') + (generated.profile.skipped.length ? '  | skipped: ' + generated.profile.skipped.join('; ') : ''));
  for (const m of generated.mappings) console.log('  map ' + (m.readOnly ? 'ro' : 'rw') + '  ' + m.host + '  ->  ' + m.guest);
  console.log('Generated:  ' + generated.wsbPath);
  if (options.command === 'launch') { startSandbox(generated.wsbPath); console.log('Sandbox starting. Watch the PowerShell window inside it; first boot downloads/copies tools and then starts ' + resolved.harnessName + '.'); }
  return 0;
}

run().then((code: number) => { process.exitCode = code; }, (e: unknown) => { console.error('Error: ' + errMsg(e)); process.exitCode = 1; });
