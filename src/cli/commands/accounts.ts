// `account list | save | use | default | remove`
import type { Account } from '../../host/profile/index.js';
import { fail, safeText } from '../../core/util/index.js';
import { printJson, table } from '../output/index.js';
import { AccountsService } from '../services/index.js';
import { type Context } from './context.js';

function label(a: Account): string {
  return '"' + a.name + '"' + (a.email ? ' (' + a.email + ')' : '');
}

function list(ctx: Context, accounts: AccountsService): number {
  const rows = accounts.list();
  if (printJson(ctx, rows)) return 0;
  if (rows.length === 0) {
    console.log(
      "No saved accounts. Sign in inside the sandbox, then: sandbox account save <name>   (or --from-host to save this PC's login)",
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

async function use(ctx: Context, accounts: AccountsService, name: string): Promise<number> {
  console.log('Sandbox now uses ' + label(accounts.activate(name)) + '.');
  if (accounts.hasRunningClaude() && !ctx.options.noRestart)
    console.log(
      safeText(await accounts.restartClaude()) + ' with --continue; the conversation carries on under the new account.',
    );
  return 0;
}

export async function account(ctx: Context): Promise<number> {
  const [action = 'list', name] = ctx.options.positionals;
  const accounts = new AccountsService(ctx);
  const needName = (): string => name ?? fail('Missing account name.', 'Usage: sandbox account ' + action + ' <name>');
  switch (action) {
    case 'list':
      return list(ctx, accounts);
    case 'save':
      console.log('Saved account ' + label(accounts.save(needName(), Boolean(ctx.options.fromHost))) + '.');
      return 0;
    case 'use':
      return use(ctx, accounts, needName());
    case 'default':
      accounts.setDefault(needName());
      console.log('Default account: ' + name);
      return 0;
    case 'remove':
      accounts.remove(needName());
      console.log('Removed account ' + name);
      return 0;
    default:
      fail(
        'Unknown account action "' + action + '".',
        'Use one of: sandbox account list | save <name> | use <name> | default <name> | remove <name>',
      );
  }
}
