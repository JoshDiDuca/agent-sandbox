// `account list | save | use | default | rename | remove [--agent <name>]`
import { askChoice, askName, askRequired } from '../../core/prompt.js';
import { fail, safeText } from '../../core/util/index.js';
import { nextStep, printJson, table } from '../output/index.js';
import { AccountsService, type AccountRef } from '../services/index.js';
import { type Context } from './context.js';

function label(a: AccountRef): string {
  return '"' + a.name + '"' + (a.email ? ' (' + a.email + ')' : '');
}

function list(ctx: Context, accounts: AccountsService, agent: string): number {
  const rows = accounts.list(agent);
  if (printJson(ctx, rows)) return 0;
  if (rows.length === 0) {
    console.log(
      agent === 'claude'
        ? "No saved accounts. Sign in inside the sandbox, then: sandbox account save <name>   (or --from-host to save this PC's login)"
        : 'No saved ' +
            agent +
            ' accounts. Sign in inside the sandbox, then: sandbox account save <name> --agent ' +
            agent,
    );
    return 0;
  }
  table([
    ['', 'NAME', 'EMAIL', 'SAVED'],
    ...rows.map((a) => [
      (a.isActive ? '*' : ' ') + (a.isDefault ? 'D' : ' '),
      a.name,
      a.email ?? '-',
      a.savedAt.slice(0, 16).replace('T', ' '),
    ]),
  ]);
  console.log('\n* = active in the sandbox   D = default for new launches');
  return 0;
}

async function use(ctx: Context, accounts: AccountsService, name: string, agent: string): Promise<number> {
  const used = accounts.activate(name, agent);
  console.log('Sandbox now uses ' + label(used) + '.');
  if (used.note) console.log(safeText(used.note));
  if (accounts.hasRunningSessions(agent) && !ctx.options.noRestart)
    console.log(
      safeText(await accounts.restart(agent)) + ' with --continue; the conversation carries on under the new account.',
    );
  return 0;
}

/** The account the command is about: the one typed, or one picked from the saved accounts. */
async function accountName(accounts: AccountsService, action: string, agent: string, given?: string): Promise<string> {
  if (given) return given;
  const usage = 'Usage: sandbox account ' + action + ' <name>';
  if (action === 'save') return askName('Name for this login:', usage, (v) => v.length > 0 || 'Type a name.');
  const rows = accounts.list(agent);
  if (!rows.length) fail('No saved accounts.', 'Sign in inside the sandbox, then run: sandbox account save <name>');
  return askChoice(
    'Which account?',
    rows.map((a) => ({ name: safeText(label(a)), value: a.name })),
    usage,
  );
}

async function remove(ctx: Context, accounts: AccountsService, name: string, agent: string): Promise<number> {
  const sure =
    ctx.options.yes ||
    (await askRequired(
      'Remove the saved account "' + name + '"? Its login cannot be recovered; you would sign in again.',
      'Add --yes to remove it without asking.',
    ));
  if (!sure) {
    console.log('Nothing removed.');
    return 1;
  }
  accounts.remove(name, agent);
  console.log('Removed account ' + name + '.');
  return 0;
}

export async function account(ctx: Context): Promise<number> {
  const [action = 'list', given] = ctx.options.positionals;
  const agent = ctx.options.accountAgent ?? 'claude';
  const accounts = new AccountsService(ctx);
  if (action === 'list') return list(ctx, accounts, agent);
  const name = await accountName(accounts, action, agent, given);
  switch (action) {
    case 'save':
      console.log('Saved account ' + label(accounts.save(name, Boolean(ctx.options.fromHost), agent)) + '.');
      nextStep('sandbox account use ' + name + '   (the sandbox uses it)');
      return 0;
    case 'use':
      return use(ctx, accounts, name, agent);
    case 'default':
      accounts.setDefault(name, agent);
      console.log('Default account: ' + name);
      return 0;
    case 'rename': {
      const to =
        ctx.options.accountTo ??
        (await askName(
          'New name for "' + name + '":',
          'Usage: sandbox account rename <name> --to <new-name>',
          (v) => v.length > 0 || 'Type a name.',
        ));
      accounts.rename(name, to, agent);
      console.log('Renamed account ' + name + ' to ' + to + '.');
      return 0;
    }
    case 'remove':
      return remove(ctx, accounts, name, agent);
    default:
      return fail(
        'Unknown account action "' + action + '".',
        'Use one of: sandbox account list | save <name> | use <name> | default <name> | rename <name> --to <new-name> | remove <name>',
      );
  }
}
