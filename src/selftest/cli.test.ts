// The command manifest, the argument parser, the interactive menu helpers and the settings screen. One definition
// (cli/manifest.ts) drives both the flags and the menu.
import fs from 'node:fs';
import path from 'node:path';
import { buildProgram, parseCli } from '../cli/args.js';
import { COMMANDS } from '../cli/manifest.js';
import { commandLine, readHistory, recordHistory } from '../cli/history.js';
import { splitArgs } from '../cli/args.js';
import { optionProblem } from '../cli/menu/index.js';
import { cleanTargetOf, type DataEntry } from '../cli/commands/data/collect.js';
import { ago, colorEnabled, shorten, shortenMiddle } from '../cli/colors.js';
import { hoistConfig, withoutConfig } from '../cli/index.js';
import { closest, validNodeSpec, validPythonSpec } from '../cli/validate.js';
import { CATEGORIES, editConfigText, nameOf, SchemaNode } from '../cli/menu/settings/index.js';
import { Frame, ListScreen, Text, TextScreen, type Key } from '../cli/tui/index.js';
import { Config, LocalOverrides } from '../core/schema.js';
import type { Suite } from './suite.js';

export const cliSuite: Suite = {
  name: 'cli',
  title: 'command manifest, argument parser, menu helpers, settings screen',
  run: async (t) => {
    t.section('manifest and parser');
    const program = buildProgram(() => undefined);
    const visible = COMMANDS.filter((c) => !c.hidden).map((c) => c.name);
    const missingFromParser = visible.filter((name) => !program.commands.some((c) => c.name() === name));
    t.equal(missingFromParser, [], 'every manifest command exists in the parser');
    t.check(program.commands.find((c) => c.name() === 'launch')!.options.some((o) => o.long === '--terminal'), 'every manifest option exists in the parser (launch --terminal)');
    const packageJson = JSON.parse(fs.readFileSync(path.join(t.packageRoot, 'package.json'), 'utf8')) as { version: string };
    t.equal(program.version(), packageJson.version, '--version prints the package version');
    t.check(program.options.some((o) => o.short === '-v' && o.long === '--version'), '-v is a short form of --version');

    const start = parseCli(['start', '--headless']);
    t.equal({ command: start.command, noAgent: start.noAgent, headless: start.headless }, { command: 'launch', noAgent: true, headless: true }, '`start` is launch without an agent');
    const clean = parseCli(['data', 'clean', 'tools/go', 'logs', '--yes']);
    t.equal({ command: clean.command, positionals: clean.positionals, yes: clean.yes }, { command: 'data', positionals: ['clean', 'tools/go', 'logs'], yes: true }, 'data clean takes targets and --yes');
    t.equal(parseCli(['start', '--database', 'postgres,redis', '--database', 'mongodb']).databases, ['postgres', 'redis', 'mongodb'], '--database takes lists and can repeat');
    t.equal(parseCli(['db', 'start', 'redis']).positionals, ['start', 'redis'], '`db` takes an action and a name');
    t.equal(parseCli(['launch', '--harness', 'opencode', '--', '--continue']).passthrough, ['--continue'], 'agent arguments after -- reach the agent');

    t.section('parser: agent wrappers (claude-sbx ...) and agent-sandbox');
    const wrapped = parseCli(['--terminal', '--continue', '--headless', '--node', '20', '--', '--terminal'], true);
    t.equal(
      { command: wrapped.command, terminal: wrapped.terminal, headless: wrapped.headless, node: wrapped.node, passthrough: wrapped.passthrough },
      { command: 'launch', terminal: true, headless: true, node: '20', passthrough: ['--continue', '--terminal'] },
      'claude-sbx: sandbox flags are consumed, everything else goes to the agent',
    );
    await t.throws(() => parseCli(['status', '--bogus']), 'unknown option', 'agent-sandbox: unknown options are errors');
    t.equal(parseCli(['account', 'use', 'work', '--no-restart']).positionals, ['use', 'work'], 'agent-sandbox: positionals are collected');
    t.equal(parseCli(['clean', '--days=3']).days, 3, 'agent-sandbox: --opt=value works');
    const agentFlags = parseCli(['--model', 'opus', '-p', 'fix it', '--json', '-f', 'x', '--timeout', '5', '--resume', 'abc'], true);
    t.equal(agentFlags.passthrough, ['--model', 'opus', '-p', 'fix it', '--json', '-f', 'x', '--timeout', '5', '--resume', 'abc'], 'claude-sbx: any flag that is not a launch option goes to the agent, in order (even ones agent-sandbox uses elsewhere)');
    t.equal({ json: agentFlags.json, follow: agentFlags.follow, timeout: agentFlags.timeout }, { json: false, follow: false, timeout: 600 }, 'claude-sbx: the agent\'s flags do not set agent-sandbox options');
    const reserved = parseCli(['--sbx-terminal', '--terminal', '--sbx-node=18'], true);
    t.equal({ terminal: reserved.terminal, node: reserved.node, passthrough: reserved.passthrough }, { terminal: true, node: '18', passthrough: [] }, '--sbx-<option> always means agent-sandbox');
    t.equal(parseCli(['launch', '--continue', '--sbx-headless']).passthrough, ['--continue'], 'agent-sandbox launch passes agent flags too');
    await t.throws(() => parseCli(['--sbx-nope'], true), 'Unknown option: --sbx-nope', 'an unknown --sbx-<option> is an error');

    t.section('menu helpers');
    t.equal(splitArgs('--model "big one" -c \'x y\''), ['--model', 'big one', '-c', 'x y'], 'menu: arguments split like a shell');
    t.equal(commandLine(['exec', 'echo', 'a b']), 'sandbox exec echo "a b"', 'menu: command lines are quoted');
    const optionOf = (flag: string) => COMMANDS.flatMap((cmd) => cmd.options).find((o) => o.flag === flag)!;
    t.check(optionProblem(optionOf('--node'), 'abc') !== undefined, 'menu: a bad Node version is rejected while typing');
    t.check(optionProblem(optionOf('--node'), '22') === undefined, 'menu: a good Node version is accepted');
    t.check(optionProblem(optionOf('--workspace'), path.join(t.packageRoot, 'no-such-folder-here')) !== undefined, 'menu: a missing folder is rejected');
    t.check(optionProblem(optionOf('--workspace'), t.packageRoot) === undefined, 'menu: an existing folder is accepted');
    t.check(optionProblem(optionOf('--days'), '0') !== undefined, 'menu: a number below the minimum is rejected');
    const rowOf = (area: DataEntry['area'], name: string): DataEntry => ({ area, name, path: 'x', bytes: 1 });
    t.equal(
      [cleanTargetOf(rowOf('tools', 'go')), cleanTargetOf(rowOf('tools', 'agents/claude')), cleanTargetOf(rowOf('databases', 'databases/pg')), cleanTargetOf(rowOf('host', 'launches'))],
      ['tools/go', 'tools/agents/claude', 'databases/pg', 'launches'],
      'data menu: removable rows become checkbox targets',
    );
    t.equal([cleanTargetOf(rowOf('host', 'accounts')), cleanTargetOf(rowOf('tools', '(files in tools)'))], [null, null], 'data menu: accounts and loose files are never offered');
    t.equal(COMMANDS.find((cmd) => cmd.name === 'data')!.options.find((o) => o.flag === '--yes')?.noMenu, true, 'data menu: --yes is never offered');

    t.section('--config placement, history, validation, text helpers');
    t.equal(hoistConfig(['--config', 'a.json', 'status', '--json']), ['status', '--config', 'a.json', '--json'], '--config before the command is moved behind it');
    t.equal(hoistConfig(['--config=a.json']), ['menu', '--config', 'a.json'], '--config alone opens the menu with it');
    t.equal(withoutConfig(['status', '--config', 'a.json', '--json']), ['status', '--json'], 'the recorded history drops --config');
    recordHistory(['launch', '--harness', 'claude']);
    recordHistory(['status']);
    recordHistory(['launch', '--harness', 'claude']);
    recordHistory(['menu']);
    t.equal(readHistory().map((h) => h.argv.join(' ')), ['launch --harness claude', 'status'], 'history: newest first, no duplicates, the menu itself is not recorded');
    t.check(validNodeSpec('22') && validNodeSpec('v22.1.0') && validNodeSpec('lts/*') && !validNodeSpec('abc'), 'validation: Node version syntax');
    t.check(validPythonSpec('3.12') && !validPythonSpec('2.7'), 'validation: Python version syntax');
    t.equal(closest('cluade', ['claude', 'codex']), 'claude', 'validation: did-you-mean for agent names');
    t.equal(closest('zzzzzz', ['claude']), undefined, 'validation: nothing is suggested for an unrelated name');
    const env = (vars: NodeJS.ProcessEnv, isTty: boolean): boolean => colorEnabled(vars, isTty);
    t.check(env({}, true), 'colours: on for a terminal');
    t.check(!env({}, false), 'colours: off for a pipe');
    t.check(!env({ NO_COLOR: '1' }, true) && !env({ TERM: 'dumb' }, true), 'colours: off for NO_COLOR and TERM=dumb');
    t.check(env({ FORCE_COLOR: '1' }, false) && !env({ FORCE_COLOR: '0' }, true), 'colours: FORCE_COLOR overrides');
    t.equal(shorten('abcdefghij', 6), 'abcde…', 'text helpers: shorten');
    t.equal(shortenMiddle('C:\\Users\\me\\project', 11), 'C:\\Us…oject', 'text helpers: shorten in the middle');
    t.equal([ago(0, 10 * 60 * 1000), ago(0, 5000), ago(0, 3 * 86400 * 1000)], ['10 min ago', 'just now', '3 d ago'], 'text helpers: relative time');

    t.section('settings screen');
    const original = '{\n  // my notes stay\n  "sandbox": { "headless": true }\n}\n';
    const set = editConfigText(original, ['attach', 'auto'], true);
    const nested = 'text' in set ? editConfigText(set.text, ['databases', 'postgres', 'port'], 6543) : set;
    const reset = 'text' in nested ? editConfigText(nested.text, ['sandbox', 'headless'], undefined) : nested;
    t.check('text' in reset, 'editing a config file gives new text');
    const resetText = 'text' in reset ? reset.text : '';
    t.includes(resetText, '// my notes stay', 'settings screen: changes keep the file\'s comments');
    t.includes(resetText, '"auto": true', 'settings screen: a new setting is added');
    t.includes(resetText, '"port": 6543', 'settings screen: nested keys are created');
    t.excludes(resetText, 'headless', 'settings screen: reset removes a key');
    const invalid = editConfigText(original, ['sandbox', 'memoryMb'], 12);
    t.check('problems' in invalid && invalid.problems.join().includes('memoryMb'), 'settings screen: invalid values are not saved', JSON.stringify(invalid));
    const missing = editConfigText('{ "storage": { "root": "C:\\\\x" } }', ['agentCommands', 'enabled'], undefined);
    t.check('text' in missing && missing.text.includes('"root"'), 'removing a setting the file does not have changes nothing (no crash)');
    const projectEdit = editConfigText('{}', ['downloads', 'requireChecksum'], true, 'project');
    const projectBad = editConfigText('{}', ['storage', 'root'], 'C:\\x', 'project');
    t.check('text' in projectEdit && projectEdit.text.includes('requireChecksum'), 'settings screen: a project file accepts project settings');
    t.check('problems' in projectBad, 'settings screen: a project file is validated against the project schema (storage cannot be set there)');

    // Every setting must be reachable in the settings screen, in a category, with an editor that fits it.
    const userSchema = new SchemaNode(Config);
    const projectSchema = new SchemaNode(LocalOverrides);
    const userLeaves = userSchema.leaves();
    const projectLeaves = projectSchema.leaves();
    t.check(userLeaves.length > 100 && projectLeaves.length > 50, 'settings screen: every setting is a leaf (' + userLeaves.length + ' settings, ' + projectLeaves.length + ' in a project file)');
    const uncategorised = [...userSchema.children(), ...projectSchema.children()].map(([name]) => name).filter((name) => !CATEGORIES.some((c) => c.keys.includes(name)));
    t.equal(uncategorised, [], 'settings screen: every top-level setting belongs to a category');
    const kinds = new Set(userLeaves.map((l) => l.node.editor));
    t.equal(['boolean', 'choice', 'union', 'number', 'string', 'string-list', 'object-list', 'string-map', 'object-map'].filter((k) => !kinds.has(k as never)), [], 'settings screen: every kind of editor is used');
    t.equal(userLeaves.filter((l) => l.node.editor === 'json').map((l) => l.key.join('.')), [], 'settings screen: no setting falls back to typing JSON');
    t.check(userLeaves.some((l) => l.key.join('.') === 'downloads.requireChecksum') && projectLeaves.some((l) => l.key.join('.') === 'downloads.requireChecksum'), 'settings screen: downloads.requireChecksum is reachable in both files');
    const harness = userSchema.child('harnesses')!.element!;
    t.includes(String(harness.check(harness.initial())), 'npmPackage', 'settings screen: a new agent says what it still needs (a package to install)');
    t.equal(harness.check({ ...(harness.initial() as object), npmPackage: 'my-cli', npmBin: 'my-cli' }), true, '... and is valid once it has one');
    const mapping = userSchema.child('mappings')!.element!;
    t.check(mapping.check(mapping.initial()) !== true, 'settings screen: a new mapped folder needs its folders filled in before it is valid');
    t.equal([Text.humanize('memoryMb'), Text.humanize('vGpu'), nameOf('node')], ['Memory MB', 'V GPU', 'Node.js'], 'settings screen: readable names');

    t.section('screens');
    const fit = Text.fit('\x1b[31mred text\x1b[0m', 5);
    t.equal([Text.width(fit), Text.strip(fit)], [5, 'red …'], 'a coloured label is cut to the width without breaking its colour');
    t.equal(Text.width('日本'), 4, 'wide characters take two columns');
    const screen = new ListScreen<string>({ path: ['T'], items: [{ value: 'a', label: 'Alpha', category: 'x' }, { value: 'b', label: 'Beta', category: 'y', description: 'second' }], categories: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }] });
    const key = (name: string, text = ''): Key => ({ name, text, ctrl: false, meta: false, shift: false });
    screen.handle(key('left'));
    screen.handle(key('down'));
    screen.handle(key('right'));
    t.equal(screen.handle(key('return')), { done: { kind: 'pick', value: 'b' } }, 'list screen: arrows switch category, Enter picks');
    const search = new ListScreen<string>({ path: ['T'], items: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }] });
    for (const k of [key('', '/'), key('b', 'b'), key('e', 'e')]) search.handle(k);
    t.equal(search.handle(key('return')), { done: { kind: 'pick', value: 'b' } }, 'list screen: / searches');
    const lines = Frame.render(screen.render({ width: 60, height: Frame.bodyHeight(20) }), 60, 20);
    t.equal(lines.length, 20, 'a frame fills the terminal height exactly');
    const multi = new ListScreen<string>({ path: ['T'], multi: true, items: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', checked: true }] });
    multi.handle(key('space'));
    t.equal(multi.handle(key('return')), { done: { kind: 'multi', values: ['a', 'b'] } }, 'list screen: space ticks several');
    const typed = new TextScreen({ path: ['T'], label: 'Port', validate: (v) => (Number(v) > 0 ? true : 'a number') });
    for (const ch of 'x') typed.handle(key(ch, ch));
    t.equal(typed.handle(key('return')), undefined, 'text field: an invalid value is not accepted');
    typed.handle(key('backspace'));
    typed.handle(key('8', '8'));
    t.equal(typed.handle(key('return')), { done: '8' }, 'text field: a valid value is');
  },
};
