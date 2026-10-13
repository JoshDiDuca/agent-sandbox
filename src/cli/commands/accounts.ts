// `account list | save | use | default | remove`
import { AccountStore, type Account } from '../../host/profile/index.js';
import { SandboxChannel } from '../../host/channel/index.js';
import { hostClaudeDir, hostGlobalStateFile } from '../../host/profile/index.js';
import { isSandboxRunning } from '../../host/sandbox/index.js';
import { fail, safeText } from '../../core/util/index.js';
import { printJson, table } from '../output/index.js';
import { type Context } from './context.js';

const label = (a: Account): string => '"' + a.name + '"' + (a.email ? ' (' + a.email + ')' : '');

/** This PC's Claude login location (config folder + global state file). */
const hostLogin = (ctx: Context): { claudeDir: string; globalStateFile: string } => {
  const profile = ctx.loaded.config.claudeProfile;
  return { claudeDir: hostClaudeDir(profile), globalStateFile: hostGlobalStateFile(profile) };
};

const list = (ctx: Context): number => {
  const rows = new AccountStore(ctx.storageRoot).list(ctx.dataPath);
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
};

const use = async (ctx: Context, name: string): Promise<number> => {
  console.log('Sandbox now uses ' + label(new AccountStore(ctx.storageRoot).activate(ctx.dataPath, name)) + '.');
  const claudeRunning =
    isSandboxRunning() && new SandboxChannel(ctx.dataPath).runningSessions().some((s) => s.harness === 'claude');
  if (claudeRunning && !ctx.options.noRestart)
    console.log(
      safeText((await new SandboxChannel(ctx.dataPath).restart('claude')).message) +
        ' with --continue; the conversation carries on under the new account.',
    );
  return 0;
};

export const account = async (ctx: Context): Promise<number> => {
  const [action = 'list', name] = ctx.options.positionals;
  const needName = (): string => name ?? fail('Missing account name.', 'Usage: sandbox account ' + action + ' <name>');
  switch (action) {
    case 'list':
      return list(ctx);
    case 'save':
      console.log(
        'Saved account ' +
          label(
            new AccountStore(ctx.storageRoot).save(
              ctx.dataPath,
              needName(),
              ctx.options.fromHost ? hostLogin(ctx) : null,
            ),
          ) +
          '.',
      );
      return 0;
    case 'use':
      return use(ctx, needName());
    case 'default':
      new AccountStore(ctx.storageRoot).setDefault(needName());
      console.log('Default account: ' + name);
      return 0;
    case 'remove':
      new AccountStore(ctx.storageRoot).remove(needName());
      console.log('Removed account ' + name);
      return 0;
    default:
      fail(
        'Unknown account action "' + action + '".',
        'Use one of: sandbox account list | save <name> | use <name> | default <name> | remove <name>',
      );
  }
};
