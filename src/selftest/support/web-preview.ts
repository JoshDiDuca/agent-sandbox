// A preview of the web UI for working on it: the real server and app, the real settings feature against a config file
// in a temp folder, and sample data for the sandbox and its sessions (a stand-in terminal plays a short agent screen).
// Nothing on this PC is read or changed. Run: npm run web:preview [-- --port 47900], then open the printed address.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AppContext } from '../../app/context.js';
import { listAgents } from '../../app/features/agents/index.js';
import { sandboxStatus } from '../../app/features/sandbox/index.js';
import { listAccounts } from '../../app/features/accounts/index.js';
import { listProjects } from '../../app/features/projects/index.js';
import { listSessions } from '../../app/features/sessions/index.js';
import { cancelled, type OperationIO, type RpcHost } from '../../app/kernel/index.js';
import { runDefinition } from '../../app/registry.js';
import { webSession } from '../../cli/services/index.js';
import type { SessionStatus } from '../../core/types.js';
import { WebServer, type WebBackend } from '../../host/web/index.js';
import { encodeFrame, FrameReader, FrameType } from '../../shared/pty/index.js';

const TOKEN = 'b'.repeat(64);
const MINUTE = 60_000;

/** A short agent screen with colours, so the terminal page has something real to draw. */
function agentScreen(id: string): string {
  return [
    '\x1b[2J\x1b[H',
    '\x1b[38;5;208m✻\x1b[0m Welcome to \x1b[1mClaude Code\x1b[0m  \x1b[2m(preview session ' + id + ')\x1b[0m\r\n\r\n',
    '\x1b[2m  /help for help, /status for your current setup\x1b[0m\r\n\r\n',
    '\x1b[1m> \x1b[0mFix the failing test in src/app/kernel/view.ts\r\n\r\n',
    '\x1b[32m●\x1b[0m Read(\x1b[1msrc/app/kernel/view.ts\x1b[0m)\r\n',
    '  ⎿  Read 181 lines\r\n\r\n',
    '\x1b[32m●\x1b[0m Update(\x1b[1msrc/app/kernel/view.ts\x1b[0m)\r\n',
    '  ⎿  Updated with \x1b[32m3 additions\x1b[0m and \x1b[31m1 removal\x1b[0m\r\n\r\n',
    '\x1b[2m╭──────────────────────────────────────────────────────────────╮\x1b[0m\r\n',
    '\x1b[2m│\x1b[0m > ' + ' '.repeat(59) + '\x1b[2m│\x1b[0m\r\n',
    '\x1b[2m╰──────────────────────────────────────────────────────────────╯\x1b[0m\r\n',
  ].join('');
}

/** A ptyhost stand-in: sends the screen on HELLO and echoes what is typed. */
function startFakePty(): Promise<number> {
  const server = net.createServer((socket) => {
    const reader = new FrameReader();
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      for (const frame of reader.push(chunk)) {
        if (frame.type === FrameType.Hello) {
          socket.write(encodeFrame(FrameType.Console, Buffer.from('conpty.dll')));
          socket.write(encodeFrame(FrameType.Output, Buffer.from(agentScreen('preview'))));
        } else if (frame.type === FrameType.Input) {
          const text = frame.payload.toString('utf8').replace(/\r/g, '\r\n');
          socket.write(encodeFrame(FrameType.Output, Buffer.from(text)));
        }
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)),
  );
}

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

const SESSIONS: SessionStatus[] = [
  {
    id: 'mva4ungc50e051',
    launchId: 'launch1',
    harness: 'claude',
    cwd: 'C:\\Projects\\AgentProjects\\windows-sandbox',
    project: 'windows-sandbox',
    phase: 'running',
    message: 'running',
    updatedAt: iso(MINUTE),
    startedAt: iso(42 * MINUTE),
  },
  {
    id: '1792104624667-1a3599',
    launchId: 'launch1',
    harness: 'claude',
    cwd: 'C:\\Projects\\AgentProjects\\mw2-agent',
    project: 'mw2-agent',
    phase: 'running',
    message: 'running',
    updatedAt: iso(MINUTE),
    startedAt: iso(43 * MINUTE),
  },
  {
    id: 'k2q9codex0001',
    launchId: 'launch1',
    harness: 'codex',
    cwd: 'C:\\Projects\\AgentProjects\\windows-sandbox',
    project: 'windows-sandbox',
    phase: 'exited',
    message: 'exited',
    exitCode: 0,
    updatedAt: iso(20 * MINUTE),
    startedAt: iso(30 * MINUTE),
  },
];

/** The sandbox as the status query would say it: running, two projects, the helper answering. */
function sampleStatus(running: boolean): unknown {
  const project = (name: string, here: boolean, sessions: SessionStatus[]): unknown => ({
    name,
    host: 'F:\\AgentProjects\\' + name,
    guest: 'C:\\Projects\\AgentProjects\\' + name,
    mechanism: here ? 'launch' : 'root',
    here,
    setup: { phase: 'ready', message: 'Set up 6 toolchains and databases.' },
    databases: name === 'mw2-agent' ? [{ database: 'postgres', port: 5432, state: 'running' }] : [],
    sessions: sessions.map((s) => ({ id: s.id, harness: s.harness, viewers: '1 here', started: s.startedAt })),
    repoGuard: [],
  });
  return sandboxStatus.output.parse({
    sandbox: {
      running,
      phase: running ? 'ready' : 'stopped',
      message: running ? 'Ready' : undefined,
      headless: false,
      startedAt: running ? Date.now() - 45 * MINUTE : null,
      daemon: running ? 'pong (2 session(s) running)' : 'not running',
      account: running ? 'personal' : null,
      syncWatcher: running,
    },
    here: {
      folder: 'F:\\AgentProjects\\windows-sandbox',
      project: 'windows-sandbox',
      guest: 'C:\\Projects\\AgentProjects\\windows-sandbox',
    },
    roots: [{ host: 'F:\\AgentProjects', guest: 'C:\\Projects\\AgentProjects' }],
    projects: running
      ? [
          project(
            'windows-sandbox',
            true,
            SESSIONS.filter((s) => s.project === 'windows-sandbox'),
          ),
          project(
            'mw2-agent',
            false,
            SESSIONS.filter((s) => s.project === 'mw2-agent'),
          ),
        ]
      : [],
    otherSessions: [],
    repoGuard: { guarded: 2, findings: [] },
  });
}

/** Sample logins (names and emails only, no credentials): Claude with two, codex with one, opencode keeps none. */
function sampleAccounts(): unknown {
  return listAccounts.output.parse({
    agent: 'claude',
    agents: [
      {
        name: 'claude',
        kept: true,
        canSavePc: true,
        accounts: [
          {
            name: 'work',
            email: 'dev@example.com',
            isDefault: true,
            isActive: true,
            savedAt: iso(3 * 24 * 60 * MINUTE),
          },
          { name: 'personal', email: null, isDefault: false, isActive: false, savedAt: iso(9 * 24 * 60 * MINUTE) },
        ],
      },
      {
        name: 'codex',
        kept: true,
        canSavePc: false,
        accounts: [{ name: 'main', email: null, isDefault: true, isActive: false, savedAt: iso(2 * 24 * 60 * MINUTE) }],
      },
      { name: 'opencode', kept: false, canSavePc: false, accounts: [] },
    ],
  });
}

function sampleSessions(running: boolean): unknown {
  return listSessions.output.parse({
    sandboxRunning: running,
    defaultAgent: 'claude',
    wide: false,
    sessions: running
      ? SESSIONS.map((s) => ({
          ...s,
          projectName: s.project,
          here: s.project === 'windows-sandbox',
          viewers: s.phase === 'running' ? { viewers: 1, remote: 0 } : undefined,
          canOpen: s.phase === 'running',
        }))
      : [],
  });
}

/** The agents as settings and the sandbox say them: two built in (one ready), two added (one ready). */
function sampleAgents(): unknown {
  return listAgents.output.parse({
    folder: 'F:\\AgentProjects\\windows-sandbox',
    defaultAgent: 'claude',
    agents: [
      { name: 'claude', ready: true, isDefault: true, removable: false },
      { name: 'codex', ready: true, isDefault: false, removable: false },
      { name: 'gemini', ready: false, isDefault: false, removable: true },
      { name: 'aider', ready: false, isDefault: false, removable: true },
    ],
  });
}

/** Sample projects: this folder's project and a root's (mapped), one not mapped, and one excluded. */
function sampleProjects(running: boolean): unknown {
  const inSandbox = (name: string, how: string): string | null => (running ? name + ' (' + how + ')' : null);
  return listProjects.output.parse({
    all: false,
    roots: ['F:\\AgentProjects'],
    exclude: ['F:\\AgentProjects\\old-demo'],
    projects: [
      {
        folder: 'F:\\AgentProjects\\windows-sandbox',
        here: true,
        known: true,
        root: 'F:\\AgentProjects',
        excluded: false,
        mappedAtStart: true,
        running: inSandbox('windows-sandbox', 'launch'),
      },
      {
        folder: 'F:\\AgentProjects\\mw2-agent',
        here: false,
        known: true,
        root: 'F:\\AgentProjects',
        excluded: false,
        mappedAtStart: true,
        running: inSandbox('mw2-agent', 'root'),
      },
      {
        folder: 'F:\\Code\\scratch',
        here: false,
        known: true,
        root: null,
        excluded: false,
        mappedAtStart: false,
        running: null,
      },
      {
        folder: 'F:\\AgentProjects\\old-demo',
        here: false,
        known: true,
        root: null,
        excluded: true,
        mappedAtStart: false,
        running: null,
      },
    ],
  });
}

/** The real features where they only touch the temp folder, sample data for the rest. */
function previewRpc(ctx: AppContext, state: { running: boolean }): RpcHost {
  const sample = async (id: string, io: OperationIO): Promise<unknown> => {
    switch (id) {
      case 'sandbox.status':
        return sampleStatus(state.running);
      case 'sessions.list':
        return sampleSessions(state.running);
      case 'agents.list':
        return sampleAgents();
      case 'agents.start':
        return { session: SESSIONS[0].id, message: 'Started claude in windows-sandbox (preview: nothing started).' };
      case 'agents.makeDefault':
        return { message: 'codex is the default agent (preview: nothing was changed).' };
      case 'agents.remove':
        if (!(await io.confirm({ title: 'Remove aider?', yes: 'Remove', danger: true, implied: true }))) cancelled();
        return { message: 'Removed aider (preview: nothing was changed).' };
      case 'agents.add':
        return { name: 'preview', message: 'Added preview (preview: nothing was saved).' };
      case 'accounts.list':
        return sampleAccounts();
      case 'accounts.remove':
        if (!(await io.confirm({ title: 'Remove the saved account?', yes: 'Remove', danger: true }))) cancelled();
        return { message: 'Removed account (preview: nothing was changed).' };
      case 'accounts.use':
        return { lines: ['Sandbox now uses "work" (dev@example.com) (preview: nothing was changed).'] };
      case 'accounts.save':
      case 'accounts.default':
      case 'accounts.rename':
        return { name: 'preview', message: 'Done (preview: nothing was changed).' };
      case 'sandbox.stop':
        if (!(await io.confirm({ title: 'Stop the sandbox?', yes: 'Stop', danger: true }))) cancelled();
        io.progress('Stopping the sandbox');
        await new Promise((r) => setTimeout(r, 800));
        state.running = false;
        return { message: 'The sandbox is stopped (preview).' };
      case 'sandbox.show':
      case 'sandbox.hide':
        return { message: 'Done (preview: nothing was changed).' };
      case 'sessions.restart':
        return { message: 'Restarted (preview: nothing was changed).', restarted: 0 };
      case 'projects.list':
        return sampleProjects(state.running);
      case 'projects.add':
        return { message: 'Added F:\\Code\\scratch to your projects. (preview: nothing was saved)' };
      case 'projects.remove':
        if (!(await io.confirm({ title: 'Forget scratch?', yes: 'Forget', danger: true, implied: true }))) cancelled();
        return { message: 'Removed F:\\Code\\scratch from your projects (preview: nothing was changed).' };
      case 'projects.include':
      case 'projects.exclude':
        return { message: 'Excluded F:\\AgentProjects\\old-demo. (preview: nothing was changed)' };
      case 'projects.all':
        return { message: 'Mapping all projects at every start is on. (preview: nothing was changed)' };
      case 'projects.roots':
        if (
          !(await io.confirm({ title: 'Remove the root AgentProjects?', yes: 'Remove', danger: true, implied: true }))
        )
          cancelled();
        return { message: 'Removed the project root F:\\AgentProjects. (preview: nothing was changed)' };
      case 'projects.choose': {
        const picked = await io.checklist({
          title: 'Projects mapped at every start, so they open without a restart:',
          choices: [
            { value: 'windows-sandbox', label: 'F:\\AgentProjects\\windows-sandbox  (this folder)' },
            { value: 'mw2-agent', label: 'F:\\AgentProjects\\mw2-agent' },
            { value: 'scratch', label: 'F:\\Code\\scratch' },
          ],
          checked: ['windows-sandbox', 'mw2-agent'],
        });
        if (picked === undefined) cancelled();
        return { message: picked.length + ' project(s) mapped at every start (preview: nothing was changed).' };
      }
      case 'apps.request':
        // The real operation opens a browser on this PC; the preview only shows the address it would open.
        return {
          url: 'https://github.com/JoshDiDuca/windows-development-sandbox/issues/new (preview: nothing opened)',
        };
      default:
        return undefined;
    }
  };
  const kinds: Record<string, 'operation' | 'query'> = {
    'sandbox.status': 'query',
    'sessions.list': 'query',
    'settings.list': 'query',
    'sandbox.stop': 'operation',
    'sandbox.show': 'operation',
    'sandbox.hide': 'operation',
    'sessions.restart': 'operation',
    'agents.list': 'query',
    'agents.start': 'operation',
    'agents.makeDefault': 'operation',
    'agents.remove': 'operation',
    'agents.add': 'operation',
    'accounts.list': 'query',
    'accounts.save': 'operation',
    'accounts.use': 'operation',
    'accounts.default': 'operation',
    'accounts.rename': 'operation',
    'accounts.remove': 'operation',
    'settings.set': 'operation',
    'settings.reset': 'operation',
    'files.browse': 'query',
    'apps.list': 'query',
    'apps.toggle': 'operation',
    'apps.setCustom': 'operation',
    'apps.request': 'operation',
    'projects.list': 'query',
    'projects.add': 'operation',
    'projects.remove': 'operation',
    'projects.include': 'operation',
    'projects.exclude': 'operation',
    'projects.all': 'operation',
    'projects.roots': 'operation',
    'projects.choose': 'operation',
  };
  return {
    kind: (id) => kinds[id],
    liveMs: (id) => (id === 'sandbox.status' || id === 'sessions.list' ? 2500 : undefined),
    run: async (id, input, io) =>
      id !== 'apps.request' && (id.startsWith('settings.') || id.startsWith('apps.') || id === 'files.browse')
        ? runDefinition(id, ctx, input, io)
        : ((await sample(id, io)) ?? {}),
  };
}

async function main(): Promise<void> {
  const portArg = process.argv.indexOf('--port');
  const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 47900;
  const packageRoot = path.resolve(
    path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')),
    '../../..',
  );
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-web-preview-'));
  const project = path.join(temp, 'project');
  fs.mkdirSync(project);
  const configPath = path.join(temp, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      sandbox: { memoryMb: 16384, vGpu: true },
      web: { enabled: true },
      apps: { install: ['lazygit', 'bruno', 'chrome'] },
    }),
  );
  // Apps: three of the catalogue are downloaded already (the marker a finished download leaves in the data folder).
  const dataPath = path.join(temp, 'data');
  for (const id of ['lazygit', 'bruno', 'sysinternals']) {
    const marker = path.join(dataPath, 'tools', 'apps', id);
    fs.mkdirSync(marker, { recursive: true });
    fs.writeFileSync(path.join(marker, '.agent-sandbox-app'), id);
  }
  const ctx = {
    loaded: { configPath },
    options: { workspace: project },
    storageRoot: path.join(temp, 'storage'),
    dataPath,
  } as unknown as AppContext;
  const state = { running: true };
  const ptyPort = await startFakePty();
  const backend: WebBackend = {
    info: () =>
      Promise.resolve({
        sandbox: state.running ? 'running' : 'stopped',
        owner: null,
        canUse: true,
        harnesses: ['claude', 'codex', 'gemini', 'opencode'],
        defaultHarness: 'claude',
        projects: [
          { name: 'windows-sandbox', guest: 'C:\\Projects\\AgentProjects\\windows-sandbox' },
          { name: 'mw2-agent', guest: 'C:\\Projects\\AgentProjects\\mw2-agent' },
        ],
      }),
    sessions: () => Promise.resolve(state.running ? SESSIONS.map((s, i) => webSession(s, i)) : []),
    endpoint: (id) =>
      SESSIONS.some((s) => s.id === id) ? { addresses: ['127.0.0.1'], port: ptyPort, token: 'preview' } : null,
  };
  const server = new WebServer({
    port,
    token: TOKEN,
    backend,
    staticRoot: path.join(packageRoot, 'dist', 'web'),
    rpc: previewRpc(ctx, state),
    onStop: () => process.exit(0),
  });
  await server.start();
  console.log('Web UI preview (sample data; settings in ' + configPath + '):');
  console.log('http://127.0.0.1:' + server.port + '/#k=' + TOKEN);
}

void main();
