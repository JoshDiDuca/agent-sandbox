// The command manifest, parser and menu helpers: one definition drives both the flags and the menu.
import fs from 'node:fs';
import path from 'node:path';
import { buildProgram, parseCli } from '../cli/args.js';
import { COMMANDS } from '../cli/manifest.js';
import { commandLine, readHistory, recordHistory } from '../cli/history.js';
import { splitArgs } from '../cli/menu.js';
import { editConfigText, SECTION_TITLES } from '../cli/settings/index.js';
import { childrenOf, isSection, jsonExample, leavesOf, promptKind, type Schema } from '../cli/settings/schema.js';
import { Config, LocalOverrides } from '../core/schema.js';
import type { Harness } from './harness.js';

export const cliTests = (t: Harness): void => {
  const { check } = t;
  t.section('CLI: manifest, parser, menu');
  const program = buildProgram(() => undefined);
  const visible = COMMANDS.filter((c) => !c.hidden).map((c) => c.name);
  check(visible.every((name) => program.commands.some((c) => c.name() === name)) && program.commands.find((c) => c.name() === 'launch')!.options.some((o) => o.long === '--terminal'), 'every manifest command and option exists in the parser');
  const packageJson = JSON.parse(fs.readFileSync(path.join(t.packageRoot, 'package.json'), 'utf8')) as { version: string };
  check(program.version() === packageJson.version && program.options.some((o) => o.short === '-v' && o.long === '--version'), '--version and -v print the package version');
  const start = parseCli(['start', '--headless']);
  check(start.command === 'launch' && start.noAgent && start.headless === true, '`start` is launch without an agent');
  const clean = parseCli(['data', 'clean', 'tools/go', 'logs', '--yes']);
  check(clean.command === 'data' && clean.positionals.join() === 'clean,tools/go,logs' && clean.yes, 'data clean takes targets and --yes');
  check(parseCli(['start', '--database', 'postgres,redis', '--database', 'mongodb']).databases.join() === 'postgres,redis,mongodb' && parseCli(['db', 'start', 'redis']).positionals.join() === 'start,redis', '--database takes lists and repeats; `db` takes an action and a name');
  check(parseCli(['launch', '--harness', 'opencode', '--', '--continue']).passthrough.join() === '--continue', 'agent arguments after -- reach the agent');
  check(JSON.stringify(splitArgs('--model "big one" -c \'x y\'')) === '["--model","big one","-c","x y"]' && commandLine(['exec', 'echo', 'a b']) === 'sandbox exec echo "a b"', 'menu: arguments split like a shell, command lines quoted');
  const original = '{\n  // my notes stay\n  "sandbox": { "headless": true }\n}\n';
  const set = editConfigText(original, ['attach', 'auto'], true);
  const nested = 'text' in set ? editConfigText(set.text, ['databases', 'postgres', 'port'], 6543) : set;
  const reset = 'text' in nested ? editConfigText(nested.text, ['sandbox', 'headless'], undefined) : nested;
  const invalid = editConfigText(original, ['sandbox', 'memoryMb'], 12);
  check('text' in reset && reset.text.includes('// my notes stay') && reset.text.includes('"auto": true') && reset.text.includes('"port": 6543') && !reset.text.includes('headless') && 'problems' in invalid && invalid.problems.join().includes('memoryMb'),
    'settings screen: changes keep the file\'s comments, nested keys are created, reset removes a key, invalid values are not saved');
  // Every setting must be reachable in the settings screen: each leaf has a prompt, each top-level section a title.
  const userLeaves = leavesOf(Config as unknown as Schema);
  const projectLeaves = leavesOf(LocalOverrides as unknown as Schema);
  const sections = childrenOf(Config as unknown as Schema).filter(([, s]) => isSection(s)).map(([name]) => name);
  const projectSections = childrenOf(LocalOverrides as unknown as Schema).filter(([, s]) => isSection(s)).map(([name]) => name);
  const kinds = new Set(userLeaves.map((l) => promptKind(l.schema)));
  check(userLeaves.length > 100 && projectLeaves.length > 50 && ['boolean', 'enum', 'union', 'number', 'string', 'string-list', 'json'].every((k) => kinds.has(k as never)), 'settings screen: every setting maps to a prompt (' + userLeaves.length + ' settings, kinds: ' + [...kinds].join(', ') + ')');
  check(userLeaves.some((l) => l.key.join('.') === 'downloads.requireChecksum') && projectLeaves.some((l) => l.key.join('.') === 'downloads.requireChecksum'), 'settings screen: downloads.requireChecksum is reachable in your settings and in a project file');
  check([...sections, ...projectSections].every((name) => SECTION_TITLES[name]), 'settings screen: every top-level section has a title (missing: ' + [...sections, ...projectSections].filter((n) => !SECTION_TITLES[n]).join(', ') + ')');
  const json = userLeaves.filter((l) => promptKind(l.schema) === 'json');
  check(json.length > 0 && json.every((l) => jsonExample(l.key, l.schema).length > 5) && jsonExample(['harnesses'], json[0].schema).includes('npmPackage'), 'settings screen: JSON settings show an example of the expected shape');
  const projectEdit = editConfigText('{}', ['downloads', 'requireChecksum'], true, 'project');
  const projectBad = editConfigText('{}', ['storage', 'root'], 'C:\\x', 'project');
  check('text' in projectEdit && projectEdit.text.includes('requireChecksum') && 'problems' in projectBad, 'settings screen: a project file is validated against the project schema (storage cannot be set there)');
  recordHistory(['launch', '--harness', 'claude']);
  recordHistory(['status']);
  recordHistory(['launch', '--harness', 'claude']);
  recordHistory(['menu']);
  check(readHistory().map((h) => h.argv.join(' ')).join('|') === 'launch --harness claude|status', 'history: newest first, no duplicates, the menu itself is not recorded');
};
