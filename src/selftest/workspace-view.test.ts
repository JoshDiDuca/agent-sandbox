// workspaceFilter: the sandbox works on a copy of the project without what git ignores, kept in step both ways.
import fs from 'node:fs';
import path from 'node:path';
import { IgnoreRules } from '../host/workspace-view/index.js';
import { WorkspaceView } from '../host/workspace-view/index.js';
import type { Suite } from './support/suite.js';

export const workspaceViewSuite: Suite = {
  name: 'workspace-view',
  title: 'git-ignored files kept out of the sandbox (filtered view, two-way sync)',
  run: async (t, f) => {
    t.section('a filtered launch');
    const project = t.dir('filtered-app');
    fs.mkdirSync(path.join(project, '.git'));
    const filtered = { ...f.baseConfig, workspaceFilter: { enabled: true, exclude: [], include: [] } };
    const gen = await f.launch({ cwd: project }, { config: filtered });
    const workspace = gen.mappings.find((m) => m.guest.toLowerCase().endsWith('\\filtered-app'));
    const git = gen.mappings.find((m) => m.guest.toLowerCase().endsWith('\\filtered-app.git'));
    t.check(
      Boolean(workspace) &&
        !workspace!.host.toLowerCase().startsWith(project.toLowerCase()) &&
        workspace!.host.includes('views'),
      'the sandbox maps the filtered view, not the project folder',
    );
    t.check(
      git?.host === path.join(project, '.git') && !git.readOnly,
      "... and the project's .git beside it, so git works",
    );
    const noGit = await f.launch(
      { cwd: project },
      {
        config: {
          ...filtered,
          provisioning: { ...filtered.provisioning, git: { ...filtered.provisioning.git, access: 'none' } },
        },
      },
    );
    t.check(
      !noGit.mappings.some((m) => m.guest.toLowerCase().endsWith('.git')),
      'with git access "none" no .git is mapped at all',
    );

    t.section('which files git ignores');
    const rulesRoot = t.at('rules');
    t.write(path.join(rulesRoot, '.gitignore'), 'node_modules/\n*.log\n!keep.log\n.env*\n!.env.example\ndist\n');
    t.write(path.join(rulesRoot, 'sub', '.gitignore'), 'secret.txt\n!*.log\n');
    t.write(path.join(rulesRoot, '.git', 'info', 'exclude'), 'local-notes.md\n');
    const rules = new IgnoreRules(rulesRoot, ['*.pem'], ['dist/keep-me.js']);
    const verdicts = Object.fromEntries(
      [
        'src/a.ts',
        'node_modules/x/index.js',
        'a.log',
        'keep.log',
        '.env',
        '.env.local',
        '.env.example',
        'dist/out.js',
        'sub/secret.txt',
        'sub/b.log',
        'local-notes.md',
        'key.pem',
        'dist/keep-me.js',
        '.git/config',
      ].map((p) => [p, rules.isIgnored(p)]),
    );
    t.equal(
      verdicts,
      {
        'src/a.ts': false,
        'node_modules/x/index.js': true,
        'a.log': true,
        'keep.log': false,
        '.env': true,
        '.env.local': true,
        '.env.example': false,
        'dist/out.js': true,
        'sub/secret.txt': true,
        'sub/b.log': false,
        'local-notes.md': true,
        'key.pem': true,
        'dist/keep-me.js': false,
        '.git/config': true,
      },
      'rules: nested .gitignore files, ! exceptions, .git/info/exclude, your own exclude and include patterns',
    );

    t.section('the view');
    const host = t.at('project');
    t.write(path.join(host, '.gitignore'), 'node_modules/\n.env\ndist/\n');
    t.write(path.join(host, 'src', 'main.ts'), 'console.log(1);\n');
    t.write(path.join(host, 'README.md'), '# hi\n');
    t.write(path.join(host, '.env'), 'API_KEY=secret\n');
    t.write(path.join(host, 'node_modules', 'pkg', 'index.js'), 'host build');
    fs.mkdirSync(path.join(host, '.git'), { recursive: true });
    const paths = WorkspaceView.pathsFor(t.at('storage'), host);
    const view = new WorkspaceView({ ...paths, guestGitDir: 'C:\\Workspace\\project.git' });
    view.prepare();
    const inView = (rel: string): boolean => fs.existsSync(path.join(paths.view, ...rel.split('/')));
    t.check(inView('src/main.ts') && inView('README.md') && inView('.gitignore'), 'view: what git tracks is there');
    t.check(!inView('.env') && !inView('node_modules'), 'view: ignored files (.env, node_modules) are not');
    t.equal(
      fs.readFileSync(path.join(paths.view, '.git'), 'utf8'),
      'gitdir: C:/Workspace/project.git\n',
      "view: its .git points at the project's real .git (mapped separately)",
    );
    t.check(!paths.view.toLowerCase().startsWith(host.toLowerCase()), 'view: it lives outside the project');

    t.section('both ways');
    t.write(path.join(host, 'src', 'main.ts'), 'console.log(2);\n');
    t.touch(path.join(host, 'src', 'main.ts'), 5);
    view.syncChanged(['src/main.ts']);
    t.equal(
      fs.readFileSync(path.join(paths.view, 'src', 'main.ts'), 'utf8'),
      'console.log(2);\n',
      'your edit reaches the sandbox',
    );
    t.write(path.join(paths.view, 'src', 'new.ts'), 'export {};\n');
    t.write(path.join(paths.view, 'node_modules', 'pkg', 'index.js'), 'sandbox build');
    t.write(path.join(paths.view, 'dist', 'bundle.js'), 'built');
    view.syncAll();
    t.check(fs.existsSync(path.join(host, 'src', 'new.ts')), 'a file the agent creates reaches your project');
    t.equal(
      fs.readFileSync(path.join(host, 'node_modules', 'pkg', 'index.js'), 'utf8'),
      'host build',
      "the sandbox's own node_modules never overwrite yours",
    );
    t.check(!fs.existsSync(path.join(host, 'dist')), 'its build output stays in the sandbox');
    fs.rmSync(path.join(paths.view, 'README.md'));
    view.syncAll();
    t.check(!fs.existsSync(path.join(host, 'README.md')), 'a deletion in the sandbox is repeated in your project');
    fs.rmSync(path.join(host, 'src', 'new.ts'));
    view.syncAll();
    t.check(!inView('src/new.ts'), 'a deletion in your project is repeated in the sandbox');

    t.section('conflicts and changing rules');
    t.write(path.join(host, 'src', 'main.ts'), 'yours\n');
    t.touch(path.join(host, 'src', 'main.ts'), 20);
    t.write(path.join(paths.view, 'src', 'main.ts'), 'sandbox\n');
    t.touch(path.join(paths.view, 'src', 'main.ts'), 30);
    const stats = view.syncAll();
    const conflicts = fs.readdirSync(path.join(host, 'src')).filter((n) => n.includes('.sandbox-conflict-'));
    t.check(
      stats.conflicts === 1 &&
        fs.readFileSync(path.join(host, 'src', 'main.ts'), 'utf8') === 'yours\n' &&
        conflicts.length === 1 &&
        fs.readFileSync(path.join(host, 'src', conflicts[0]), 'utf8') === 'sandbox\n',
      "changed on both sides: yours stays, the sandbox's version is kept next to it",
    );
    t.equal(
      fs.readFileSync(path.join(paths.view, 'src', 'main.ts'), 'utf8'),
      'yours\n',
      '... and the sandbox sees yours',
    );
    t.write(path.join(host, '.gitignore'), 'node_modules/\ndist/\n');
    view.syncChanged(['.gitignore']);
    t.check(inView('.env'), 'a file no longer ignored comes in when .gitignore changes');
    t.equal(
      view.syncAll(),
      { toView: 0, toHost: 0, deleted: 0, conflicts: 0, skipped: 0 },
      'a pass with nothing changed copies nothing',
    );
    t.check(
      view.syncChanged(['../outside.txt', 'C:/Windows/x', '']).toHost === 0,
      'paths from outside the project are ignored',
    );

    t.section('live');
    const stop = view.watch(60000);
    t.write(path.join(host, 'live.txt'), 'from you');
    const arrived = await t.waitFor(() => inView('live.txt'), 5000);
    t.write(path.join(paths.view, 'live-back.txt'), 'from the sandbox');
    const back = await t.waitFor(() => fs.existsSync(path.join(host, 'live-back.txt')), 5000);
    stop();
    t.check(Boolean(arrived) && Boolean(back), 'changes on either side arrive within a second or two while it watches');
  },
};
