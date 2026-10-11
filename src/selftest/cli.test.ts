// The command manifest, parser and menu helpers: one definition drives both the flags and the menu.
import { buildProgram, parseCli } from '../cli/args.js';
import { COMMANDS } from '../cli/manifest.js';
import { commandLine, readHistory, recordHistory, splitArgs } from '../cli/menu.js';
import { editConfigText } from '../cli/settings.js';
import type { Harness } from './harness.js';

export const cliTests = (t: Harness): void => {
  const { check } = t;
  t.section('CLI: manifest, parser, menu');
  const program = buildProgram(() => undefined);
  const visible = COMMANDS.filter((c) => !c.hidden).map((c) => c.name);
  check(visible.every((name) => program.commands.some((c) => c.name() === name)) && program.commands.find((c) => c.name() === 'launch')!.options.some((o) => o.long === '--terminal'), 'every manifest command and option exists in the parser');
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
  recordHistory(['launch', '--harness', 'claude']);
  recordHistory(['status']);
  recordHistory(['launch', '--harness', 'claude']);
  recordHistory(['menu']);
  check(readHistory().map((h) => h.argv.join(' ')).join('|') === 'launch --harness claude|status', 'history: newest first, no duplicates, the menu itself is not recorded');
};
