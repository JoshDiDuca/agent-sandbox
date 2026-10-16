// `sandbox web start | stop | status | open`: the web UI's server runs in the background (as `_web`, like the sync
// watcher) and keeps running when no sandbox does. The work is in host/web.
import fs from 'node:fs';
import path from 'node:path';
import { fail, sleep } from '../../core/util/index.js';
import { spawnDetached } from '../../host/sandbox/index.js';
import { packageVersion } from '../../core/package-info.js';
import { IDLE_EXIT_MS, openBrowser, WebControl, WebRunner, WebStore, type WebState } from '../../host/web/index.js';
import { printJson } from '../output/index.js';
import { createRpcHost } from '../../app/registry.js';
import { WebService } from '../services/index.js';
import { requireOnPc, type Context } from './context.js';

const START_WAIT_MS = 15000;

function controlOf(ctx: Context): WebControl {
  return new WebControl(new WebStore(ctx.storageRoot));
}

/**
 * The running server when it is this version's. A server of another version (one left running across an update) is
 * stopped, so the page and the server always match; a state file without a server is removed.
 */
async function currentServer(control: WebControl): Promise<WebState | null> {
  const before = await control.status();
  if (before.running && before.state && before.state.version === packageVersion()) return before.state;
  if (before.running && before.state) {
    await control.stop(before.state);
    for (const started = Date.now(); Date.now() - started < START_WAIT_MS; await sleep(300))
      if (!(await control.status()).running) break;
  }
  if (before.state) control.clear();
  return null;
}

/** Starts the background server (when it is not running) and waits until it answers. */
async function startServer(ctx: Context, control: WebControl): Promise<number> {
  const running = await currentServer(control);
  if (running) {
    console.log('The web UI is already running on port ' + running.port + '.');
    return running.port;
  }
  const { config } = ctx.loaded;
  if (!config.web.enabled)
    console.log(
      'web.enabled is off: this starts the web UI for now only. Set it to true in Settings to keep it allowed.',
    );
  const configFile = ctx.options.config;
  spawnDetached(ctx.entry, ['_web', ...(configFile ? ['--config', path.resolve(configFile)] : [])]);
  for (const started = Date.now(); Date.now() - started < START_WAIT_MS; await sleep(300)) {
    const now = await control.status();
    if (now.running && now.state) {
      console.log('The web UI is running at http://127.0.0.1:' + now.state.port + '/ (this PC only).');
      console.log('Open it already signed in with: sandbox web open');
      return now.state.port;
    }
  }
  return fail(
    'The web UI did not start.',
    'Run sandbox _web to see why (the port ' + config.web.port + ' may be taken: change web.port).',
  );
}

/**
 * At a sandbox start, with web.enabled: the web UI is started in the background when it is not running, and with
 * web.openOnLaunch opened in the browser, signed in. Never stops the launch: a problem is one line.
 */
export async function startWebOnLaunch(ctx: Context): Promise<void> {
  const { web: settings } = ctx.loaded.config;
  if (!settings.enabled) return;
  try {
    const control = controlOf(ctx);
    let state = await currentServer(control);
    if (!state) {
      const configFile = ctx.options.config;
      spawnDetached(ctx.entry, ['_web', ...(configFile ? ['--config', path.resolve(configFile)] : [])]);
      for (const started = Date.now(); !state && Date.now() - started < START_WAIT_MS; await sleep(300)) {
        const now = await control.status();
        if (now.running && now.state) state = now.state;
      }
    }
    if (!state) {
      console.log(
        'The web UI did not start (port ' + settings.port + ' may be taken: change web.port). Try: sandbox web start',
      );
      return;
    }
    if (settings.openOnLaunch) {
      openBrowser(control.url(state));
      console.log('The web UI is open in your browser (http://127.0.0.1:' + state.port + '/).');
    } else
      console.log('The web UI is at http://127.0.0.1:' + state.port + '/ (open it signed in with: sandbox web open).');
  } catch (e) {
    console.log('The web UI could not be started: ' + (e instanceof Error ? e.message : String(e)));
  }
}

export async function web(ctx: Context): Promise<number> {
  requireOnPc('web');
  const action = ctx.options.positionals[0] ?? 'status';
  const control = controlOf(ctx);
  switch (action) {
    case 'start':
      await startServer(ctx, control);
      return 0;
    case 'open': {
      await startServer(ctx, control);
      const { state } = await control.status();
      if (!state) return fail('The web UI stopped right away.', 'Run sandbox web start again.');
      openBrowser(control.url(state));
      console.log('Opened in your browser.');
      return 0;
    }
    case 'stop': {
      const { running, state } = await control.status();
      if (!state) {
        console.log('The web UI is not running.');
        return 0;
      }
      if (!running || (await control.stop(state))) control.clear();
      else return fail('The web UI did not stop.', 'End the process ' + state.pid + ' in Task Manager.');
      console.log('The web UI stopped.');
      return 0;
    }
    case 'status': {
      const { running, state } = await control.status();
      const port = running && state ? state.port : null;
      if (printJson(ctx, { running, port, address: port ? 'http://127.0.0.1:' + port + '/' : null })) return 0;
      console.log(
        running && port
          ? 'The web UI is running at http://127.0.0.1:' + port + '/ (sandbox web open signs you in).'
          : 'The web UI is not running (sandbox web start).',
      );
      return 0;
    }
    default:
      return fail('Unknown action "' + action + '".', 'Use start, stop, status or open.');
  }
}

/** Body of the background process (`sandbox _web`): runs until stopped. */
export async function webServer(ctx: Context): Promise<void> {
  const staticRoot = path.join(ctx.packageRoot, 'dist', 'web');
  if (!fs.existsSync(path.join(staticRoot, 'index.html')))
    fail('The web app is not built (' + staticRoot + ').', 'Run npm run build in the install folder.');
  await new WebRunner({
    storageRoot: ctx.storageRoot,
    port: ctx.loaded.config.web.port,
    backend: new WebService(ctx),
    rpc: createRpcHost(ctx),
    staticRoot,
    version: packageVersion(),
    idleExitMs: IDLE_EXIT_MS,
  }).run();
  process.exit(0);
}
