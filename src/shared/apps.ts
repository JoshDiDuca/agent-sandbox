// The apps catalogue: desktop programs and command-line tools the sandbox can install on request (apps.install), each a
// portable download kept in C:\AgentData\tools\apps\<id> (installers would be lost when the sandbox closes). Pure data,
// shared by the menu on the PC (to list them) and the sandbox (to install them, guest/apps). VS Code and Windows
// Terminal have settings of their own (toolchains.vscode, provisioning.terminal) and are listed here too.
import type { Config, GitAccess } from '../core/types.js';

export type AppCategory =
  | 'editors'
  | 'databases'
  | 'api'
  | 'git'
  | 'utilities'
  | 'browsers'
  | 'gamedev'
  | 'cloud'
  | 'diagrams'
  | 'network'
  | 'cli';

export const APP_CATEGORIES: { id: AppCategory; label: string; description: string }[] = [
  {
    id: 'editors',
    label: 'Editors & IDEs',
    description: 'Code and text editors (VS Code is a setting of its own and on by default).',
  },
  {
    id: 'databases',
    label: 'Database clients',
    description: 'GUIs for the databases the sandbox runs (PostgreSQL, MySQL, MongoDB, Redis, SQLite, DynamoDB).',
  },
  { id: 'api', label: 'API clients', description: 'Send HTTP, REST and GraphQL requests to what you are building.' },
  {
    id: 'git',
    label: 'Git tools',
    description: "Git GUIs and terminal UIs. They use the sandbox's git, so its git access rules apply.",
  },
  {
    id: 'utilities',
    label: 'Utilities',
    description: 'Archives, comparing files, finding files, process tools, hex editing.',
  },
  { id: 'browsers', label: 'Browsers', description: 'Browsers for testing web apps (Edge is already in Windows).' },
  {
    id: 'gamedev',
    label: 'Game development',
    description: 'Engines and editors. They draw with OpenGL on the CPU (Mesa) when the sandbox has no GPU.',
  },
  {
    id: 'cloud',
    label: 'Cloud & Kubernetes',
    description: 'Command-line tools for clouds, Kubernetes and infrastructure as code.',
  },
  { id: 'diagrams', label: 'Diagrams & docs', description: 'Diagrams and document conversion.' },
  { id: 'network', label: 'Network & HTTP', description: 'Inspect and test HTTP traffic and APIs.' },
  {
    id: 'cli',
    label: 'Command-line tools',
    description: 'Small tools developers reach for: JSON and YAML, search, diff, builds, media, load testing ...',
  },
];

/** Where a download comes from. Resolvers (sublime, kubectl ...) are code in guest/apps, named here by id. */
export type AppSource = { github: string; asset: string } | { url: string } | { resolve: string } | { npm: string };

export interface AppEntry {
  id: string;
  name: string;
  category: AppCategory;
  about: string;
  size: string;
  source: AppSource;
  /** How the download is unpacked: an archive (zip/7z/tar, the default), the file itself, an NSIS installer or an MSI. */
  unpack?: 'archive' | 'file' | 'nsis' | 'msi';
  /** The program to start (or the tool on PATH): a file name, or a regex (/.../) for names with a version in them. */
  exe: string;
  /** A command-line tool: its folder goes on PATH (no desktop shortcut). */
  cli?: boolean;
  /** Needs these first: 7-Zip to unpack an installer, Mesa for OpenGL without a GPU. */
  needs?: ('7zip' | 'mesa')[];
  /** Settings elsewhere that this entry stands for (VS Code, Windows Terminal): shown in the catalogue, not installed by it. */
  setting?: string;
  /** Only with full git access (it pushes on its own, past the sandbox's git guard). */
  fullGitOnly?: boolean;
}

const gh = (github: string, asset: string): AppSource => ({ github, asset });

export const APPS: AppEntry[] = [
  // ---- editors
  {
    id: 'vscode',
    name: 'Visual Studio Code',
    category: 'editors',
    about: "Code editor with debugging, set up for the sandbox's languages.",
    size: '150 MB',
    source: { resolve: 'setting' },
    exe: 'Code.exe',
    setting: 'toolchains.vscode.enabled',
  },
  {
    id: 'windows-terminal',
    name: 'Windows Terminal',
    category: 'utilities',
    about: 'The sandbox window: tabs, panes, PowerShell 7 profile.',
    size: '40 MB',
    source: { resolve: 'setting' },
    exe: 'WindowsTerminal.exe',
    setting: 'provisioning.terminal.enabled',
  },
  {
    id: 'notepadpp',
    name: 'Notepad++',
    category: 'editors',
    about: 'Fast text and code editor.',
    size: '8 MB',
    source: gh('notepad-plus-plus/notepad-plus-plus', '^npp\\.[\\d.]+\\.portable\\.x64\\.zip$'),
    exe: 'notepad++.exe',
  },
  {
    id: 'sublime',
    name: 'Sublime Text',
    category: 'editors',
    about: 'Fast code editor (paid licence, free to evaluate).',
    size: '28 MB',
    source: { resolve: 'sublime' },
    exe: 'sublime_text.exe',
  },
  {
    id: 'neovim',
    name: 'Neovim',
    category: 'editors',
    about: 'Terminal text editor (nvim).',
    size: '12 MB',
    source: gh('neovim/neovim', '^nvim-win64\\.zip$'),
    exe: 'nvim.exe',
    cli: true,
  },
  // ---- database clients
  {
    id: 'dbeaver',
    name: 'DBeaver Community',
    category: 'databases',
    about: 'Universal database client: PostgreSQL, MySQL, SQLite, SQL Server and more.',
    size: '120 MB',
    source: gh('dbeaver/dbeaver', '^dbeaver-ce-[\\d.]+-windows-x86_64\\.zip$'),
    exe: 'dbeaver.exe',
  },
  {
    id: 'pgadmin',
    name: 'pgAdmin 4',
    category: 'databases',
    about: 'The PostgreSQL admin GUI (from the PostgreSQL binaries zip).',
    size: '330 MB',
    source: { resolve: 'pgadmin' },
    exe: 'pgAdmin4.exe',
  },
  {
    id: 'heidisql',
    name: 'HeidiSQL',
    category: 'databases',
    about: 'Light client for MySQL, MariaDB, PostgreSQL and SQL Server.',
    size: '28 MB',
    source: gh('HeidiSQL/HeidiSQL', '^HeidiSQL_[\\d.]+_64_Portable\\.zip$'),
    exe: 'heidisql.exe',
  },
  {
    id: 'sqlitebrowser',
    name: 'DB Browser for SQLite',
    category: 'databases',
    about: 'Open, browse and edit SQLite files.',
    size: '21 MB',
    source: gh('sqlitebrowser/sqlitebrowser', '^DB\\.Browser\\.for\\.SQLite-v?[\\d.]+-win64\\.zip$'),
    exe: 'DB Browser for SQLite.exe',
  },
  {
    id: 'compass',
    name: 'MongoDB Compass',
    category: 'databases',
    about: 'The MongoDB GUI.',
    size: '220 MB',
    source: gh('mongodb-js/compass', '^mongodb-compass-[\\d.]+-win32-x64\\.zip$'),
    exe: 'MongoDBCompass.exe',
  },
  {
    id: 'redisinsight',
    name: 'Redis Insight',
    category: 'databases',
    about: 'The Redis GUI.',
    size: '110 MB',
    source: gh('redis/RedisInsight', '^Redis-Insight-win-installer\\.exe$'),
    unpack: 'nsis',
    exe: 'Redis Insight.exe',
    needs: ['7zip'],
  },
  {
    id: 'dbgate',
    name: 'DbGate',
    category: 'databases',
    about: 'Database manager for SQL and NoSQL databases.',
    size: '180 MB',
    source: gh('dbgate/dbgate', '^dbgate-[\\d.]+-win_x64\\.zip$'),
    exe: 'DbGate.exe',
  },
  {
    id: 'beekeeper',
    name: 'Beekeeper Studio',
    category: 'databases',
    about: 'SQL editor and database manager.',
    size: '245 MB',
    source: gh('beekeeper-studio/beekeeper-studio', '^Beekeeper-Studio-[\\d.]+-portable\\.exe$'),
    unpack: 'nsis',
    exe: 'Beekeeper Studio.exe',
    needs: ['7zip'],
  },
  {
    id: 'dynamodb-admin',
    name: 'dynamodb-admin',
    category: 'databases',
    about: 'Web GUI for DynamoDB Local: run dynamodb-admin, then open http://localhost:8001.',
    size: '5 MB',
    source: { npm: 'dynamodb-admin' },
    exe: 'dynamodb-admin.cmd',
    cli: true,
  },
  // ---- API clients
  {
    id: 'bruno',
    name: 'Bruno',
    category: 'api',
    about: 'Offline, git-friendly API client (collections are files in your repo).',
    size: '175 MB',
    source: gh('usebruno/bruno', '^bruno_[\\d.]+_x64_win\\.zip$'),
    exe: 'Bruno.exe',
  },
  {
    id: 'insomnia',
    name: 'Insomnia',
    category: 'api',
    about: 'REST, GraphQL and gRPC client.',
    size: '590 MB',
    source: gh('Kong/insomnia', '^insomnia-[\\d.]+-full\\.nupkg$'),
    exe: 'Insomnia.exe',
  },
  // ---- git
  {
    id: 'sourcegit',
    name: 'SourceGit',
    category: 'git',
    about: 'Fast open-source Git GUI.',
    size: '26 MB',
    source: gh('sourcegit-scm/sourcegit', '^sourcegit_[\\d.]+\\.win-x64\\.zip$'),
    exe: 'SourceGit.exe',
  },
  {
    id: 'githubdesktop',
    name: 'GitHub Desktop',
    category: 'git',
    about: 'Simple Git GUI from GitHub. It has its own git, so it needs provisioning.git.access "full".',
    size: '300 MB',
    source: gh('desktop/desktop', '^GitHubDesktop-[\\d.]+-x64-full\\.nupkg$'),
    exe: 'GitHubDesktop.exe',
    fullGitOnly: true,
  },
  {
    id: 'lazygit',
    name: 'lazygit',
    category: 'git',
    about: 'Git in the terminal.',
    size: '7 MB',
    source: gh('jesseduffield/lazygit', '^lazygit_[\\d.]+_windows_x86_64\\.zip$'),
    exe: 'lazygit.exe',
    cli: true,
  },
  // ---- utilities
  {
    id: '7zip',
    name: '7-Zip',
    category: 'utilities',
    about: 'Archive manager (7z, zip, rar, tar ...). Also unpacks installers for other apps.',
    size: '2 MB',
    source: { resolve: '7zip' },
    exe: '7zFM.exe',
  },
  {
    id: 'winmerge',
    name: 'WinMerge',
    category: 'utilities',
    about: 'Compare and merge files and folders.',
    size: '23 MB',
    source: gh('WinMerge/winmerge', '^winmerge-[\\d.]+-x64-exe\\.zip$'),
    exe: 'WinMergeU.exe',
  },
  {
    id: 'everything',
    name: 'Everything',
    category: 'utilities',
    about: 'Finds files by name instantly.',
    size: '2 MB',
    source: { resolve: 'everything' },
    exe: 'Everything.exe',
  },
  {
    id: 'sysinternals',
    name: 'Sysinternals Suite',
    category: 'utilities',
    about: 'Process Explorer, Process Monitor, Autoruns, TCPView and more (on PATH).',
    size: '200 MB',
    source: { url: 'https://download.sysinternals.com/files/SysinternalsSuite.zip' },
    exe: 'procexp64.exe',
  },
  {
    id: 'imhex',
    name: 'ImHex',
    category: 'utilities',
    about: 'Hex editor for reverse engineering and binary formats.',
    size: '80 MB',
    source: gh('WerWolv/ImHex', '^imhex-[\\d.]+-Windows-Portable-NoGPU-x86_64\\.zip$'),
    exe: 'imhex-gui.exe',
  },
  // ---- browsers
  {
    id: 'chrome',
    name: 'Chrome for Testing',
    category: 'browsers',
    about: 'Chrome build made for automated tests (with chromedriver on PATH).',
    size: '170 MB',
    source: { resolve: 'chrome' },
    exe: 'chrome.exe',
  },
  {
    id: 'firefox',
    name: 'Firefox',
    category: 'browsers',
    about: 'Firefox for testing.',
    size: '75 MB',
    source: { resolve: 'firefox' },
    unpack: 'nsis',
    exe: 'firefox.exe',
    needs: ['7zip'],
  },
  // ---- game development
  {
    id: 'godot',
    name: 'Godot',
    category: 'gamedev',
    about: 'Open-source 2D and 3D game engine.',
    size: '80 MB',
    source: gh('godotengine/godot', '^Godot_v[\\d.]+-stable_win64\\.exe\\.zip$'),
    exe: '/^Godot_v[\\d.]+-stable_win64\\.exe$/',
    needs: ['mesa'],
  },
  {
    id: 'blender',
    name: 'Blender',
    category: 'gamedev',
    about: '3D modelling, animation and rendering.',
    size: '400 MB',
    source: { resolve: 'blender' },
    exe: 'blender.exe',
    needs: ['mesa'],
  },
  {
    id: 'love',
    name: 'LÖVE',
    category: 'gamedev',
    about: 'Lua framework for 2D games.',
    size: '4 MB',
    source: gh('love2d/love', '^love-[\\d.]+-win64\\.zip$'),
    exe: 'love.exe',
    needs: ['mesa'],
  },
  {
    id: 'defold',
    name: 'Defold',
    category: 'gamedev',
    about: 'Free 2D/3D game engine and editor.',
    size: '330 MB',
    source: gh('defold/defold', '^Defold-x86_64-win32\\.zip$'),
    exe: 'Defold.exe',
    needs: ['mesa'],
  },
  {
    id: 'pixelorama',
    name: 'Pixelorama',
    category: 'gamedev',
    about: 'Pixel-art and sprite editor.',
    size: '40 MB',
    source: gh('Orama-Interactive/Pixelorama', '^Pixelorama-Windows-64bit\\.zip$'),
    exe: 'Pixelorama.exe',
    needs: ['mesa'],
  },
  {
    id: 'tiled',
    name: 'Tiled',
    category: 'gamedev',
    about: 'Tile map editor.',
    size: '22 MB',
    source: gh('mapeditor/tiled', '^Tiled-[\\d.]+_Windows-10\\+_x86_64\\.msi$'),
    unpack: 'msi',
    exe: 'tiled.exe',
  },
  // ---- cloud
  {
    id: 'kubectl',
    name: 'kubectl',
    category: 'cloud',
    about: 'Kubernetes command line.',
    size: '60 MB',
    source: { resolve: 'kubectl' },
    unpack: 'file',
    exe: 'kubectl.exe',
    cli: true,
  },
  {
    id: 'helm',
    name: 'Helm',
    category: 'cloud',
    about: 'Kubernetes package manager.',
    size: '20 MB',
    source: { resolve: 'helm' },
    exe: 'helm.exe',
    cli: true,
  },
  {
    id: 'k9s',
    name: 'k9s',
    category: 'cloud',
    about: 'Kubernetes cluster UI in the terminal.',
    size: '40 MB',
    source: gh('derailed/k9s', '^k9s_Windows_amd64\\.zip$'),
    exe: 'k9s.exe',
    cli: true,
  },
  {
    id: 'terraform',
    name: 'Terraform',
    category: 'cloud',
    about: 'Infrastructure as code.',
    size: '30 MB',
    source: { resolve: 'terraform' },
    exe: 'terraform.exe',
    cli: true,
  },
  {
    id: 'azure-cli',
    name: 'Azure CLI',
    category: 'cloud',
    about: 'Manage Azure (az).',
    size: '90 MB',
    source: { url: 'https://aka.ms/installazurecliwindowszipx64' },
    exe: 'az.cmd',
    cli: true,
  },
  {
    id: 'gcloud',
    name: 'Google Cloud CLI',
    category: 'cloud',
    about: 'Manage Google Cloud (gcloud, gsutil, bq).',
    size: '120 MB',
    source: {
      url: 'https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-windows-x86_64-bundled-python.zip',
    },
    exe: 'gcloud.cmd',
    cli: true,
  },
  {
    id: 'aws-cli',
    name: 'AWS CLI',
    category: 'cloud',
    about: 'Manage AWS (aws).',
    size: '50 MB',
    source: { url: 'https://awscli.amazonaws.com/AWSCLIV2.msi' },
    unpack: 'msi',
    exe: 'aws.exe',
    cli: true,
  },
  // ---- diagrams and docs
  {
    id: 'drawio',
    name: 'draw.io',
    category: 'diagrams',
    about: 'Diagram editor (flowcharts, architecture, UML).',
    size: '170 MB',
    source: gh('jgraph/drawio-desktop', '^draw\\.io-[\\d.]+-windows\\.zip$'),
    exe: 'draw.io.exe',
  },
  {
    id: 'pandoc',
    name: 'Pandoc',
    category: 'diagrams',
    about: 'Convert documents between Markdown, HTML, Word, PDF ...',
    size: '35 MB',
    source: gh('jgm/pandoc', '^pandoc-[\\d.]+-windows-x86_64\\.zip$'),
    exe: 'pandoc.exe',
    cli: true,
  },
  // ---- network
  {
    id: 'mitmproxy',
    name: 'mitmproxy',
    category: 'network',
    about: 'Intercepting HTTPS proxy (mitmweb opens a web UI).',
    size: '90 MB',
    source: { resolve: 'mitmproxy' },
    exe: 'mitmweb.exe',
    cli: true,
  },
  {
    id: 'xh',
    name: 'xh',
    category: 'network',
    about: 'Friendly HTTP requests from the terminal (like HTTPie).',
    size: '5 MB',
    source: gh('ducaale/xh', '^xh-v[\\d.]+-x86_64-pc-windows-msvc\\.zip$'),
    exe: 'xh.exe',
    cli: true,
  },
  {
    id: 'grpcurl',
    name: 'grpcurl',
    category: 'network',
    about: 'curl for gRPC servers.',
    size: '10 MB',
    source: gh('fullstorydev/grpcurl', '^grpcurl_[\\d.]+_windows_x86_64\\.zip$'),
    exe: 'grpcurl.exe',
    cli: true,
  },
  {
    id: 'k6',
    name: 'k6',
    category: 'network',
    about: 'Load testing with JavaScript scripts.',
    size: '30 MB',
    source: gh('grafana/k6', '^k6-v[\\d.]+-windows-amd64\\.zip$'),
    exe: 'k6.exe',
    cli: true,
  },
  // ---- command-line tools
  {
    id: 'jq',
    name: 'jq',
    category: 'cli',
    about: 'Query and reshape JSON.',
    size: '1 MB',
    source: gh('jqlang/jq', '^jq-windows-amd64\\.exe$'),
    unpack: 'file',
    exe: 'jq.exe',
    cli: true,
  },
  {
    id: 'yq',
    name: 'yq',
    category: 'cli',
    about: 'Query and edit YAML, JSON, XML and TOML.',
    size: '10 MB',
    source: gh('mikefarah/yq', '^yq_windows_amd64\\.exe$'),
    unpack: 'file',
    exe: 'yq.exe',
    cli: true,
  },
  {
    id: 'ripgrep',
    name: 'ripgrep',
    category: 'cli',
    about: 'Very fast recursive search (rg).',
    size: '2 MB',
    source: gh('BurntSushi/ripgrep', '^ripgrep-[\\d.]+-x86_64-pc-windows-msvc\\.zip$'),
    exe: 'rg.exe',
    cli: true,
  },
  {
    id: 'fd',
    name: 'fd',
    category: 'cli',
    about: 'Fast, friendly alternative to find.',
    size: '2 MB',
    source: gh('sharkdp/fd', '^fd-v[\\d.]+-x86_64-pc-windows-msvc\\.zip$'),
    exe: 'fd.exe',
    cli: true,
  },
  {
    id: 'bat',
    name: 'bat',
    category: 'cli',
    about: 'cat with syntax highlighting and git changes.',
    size: '3 MB',
    source: gh('sharkdp/bat', '^bat-v[\\d.]+-x86_64-pc-windows-msvc\\.zip$'),
    exe: 'bat.exe',
    cli: true,
  },
  {
    id: 'fzf',
    name: 'fzf',
    category: 'cli',
    about: 'Fuzzy finder for the terminal.',
    size: '2 MB',
    source: gh('junegunn/fzf', '^fzf-[\\d.]+-windows_amd64\\.zip$'),
    exe: 'fzf.exe',
    cli: true,
  },
  {
    id: 'delta',
    name: 'delta',
    category: 'cli',
    about: 'Readable git diffs with syntax highlighting.',
    size: '3 MB',
    source: gh('dandavison/delta', '^delta-[\\d.]+-x86_64-pc-windows-msvc\\.zip$'),
    exe: 'delta.exe',
    cli: true,
  },
  {
    id: 'just',
    name: 'just',
    category: 'cli',
    about: 'Command runner (a simpler make for project tasks).',
    size: '2 MB',
    source: gh('casey/just', '^just-[\\d.]+-x86_64-pc-windows-msvc\\.zip$'),
    exe: 'just.exe',
    cli: true,
  },
  {
    id: 'hyperfine',
    name: 'hyperfine',
    category: 'cli',
    about: 'Benchmark commands.',
    size: '1 MB',
    source: gh('sharkdp/hyperfine', '^hyperfine-v[\\d.]+-x86_64-pc-windows-msvc\\.zip$'),
    exe: 'hyperfine.exe',
    cli: true,
  },
  {
    id: 'watchexec',
    name: 'watchexec',
    category: 'cli',
    about: 'Run a command when files change.',
    size: '5 MB',
    source: gh('watchexec/watchexec', '^watchexec-[\\d.]+-x86_64-pc-windows-msvc\\.zip$'),
    exe: 'watchexec.exe',
    cli: true,
  },
  {
    id: 'protoc',
    name: 'protoc',
    category: 'cli',
    about: 'Protocol Buffers compiler.',
    size: '3 MB',
    source: gh('protocolbuffers/protobuf', '^protoc-[\\d.]+-win64\\.zip$'),
    exe: 'protoc.exe',
    cli: true,
  },
  {
    id: 'ninja',
    name: 'Ninja',
    category: 'cli',
    about: "Small, fast build system (CMake's favourite generator).",
    size: '1 MB',
    source: gh('ninja-build/ninja', '^ninja-win\\.zip$'),
    exe: 'ninja.exe',
    cli: true,
  },
  {
    id: 'ffmpeg',
    name: 'FFmpeg',
    category: 'cli',
    about: 'Convert and process audio and video.',
    size: '200 MB',
    source: gh('BtbN/FFmpeg-Builds', '^ffmpeg-master-latest-win64-gpl\\.zip$'),
    exe: 'ffmpeg.exe',
    cli: true,
  },
  {
    id: 'sqlite',
    name: 'SQLite tools',
    category: 'cli',
    about: 'sqlite3 command-line shell.',
    size: '5 MB',
    source: { resolve: 'sqlite' },
    exe: 'sqlite3.exe',
    cli: true,
  },
  {
    id: 'shellcheck',
    name: 'ShellCheck',
    category: 'cli',
    about: 'Finds bugs in shell scripts.',
    size: '10 MB',
    source: gh('koalaman/shellcheck', '^shellcheck-v[\\d.]+\\.zip$'),
    exe: 'shellcheck.exe',
    cli: true,
  },
  {
    id: 'gitleaks',
    name: 'Gitleaks',
    category: 'cli',
    about: 'Finds secrets committed to git.',
    size: '8 MB',
    source: gh('gitleaks/gitleaks', '^gitleaks_[\\d.]+_windows_x64\\.zip$'),
    exe: 'gitleaks.exe',
    cli: true,
  },
];

export const appById = (id: string): AppEntry | undefined => APPS.find((a) => a.id === id);

/** A catalogue `exe` that is a regex ("/.../") matches names with a version in them. */
export const exeMatcher = (exe: string): ((name: string) => boolean) => {
  const regex = /^\/(.+)\/$/.exec(exe);
  if (regex) {
    const r = new RegExp(regex[1], 'i');
    return (name) => r.test(name);
  }
  return (name) => name.toLowerCase() === exe.toLowerCase();
};

/** Your own program as a catalogue entry (its folder is apps\custom\<id>). */
const customEntry = (id: string, app: Config['apps']['custom'][string]): AppEntry => ({
  id: 'custom/' + id,
  name: app.name,
  category: 'utilities',
  about: 'Your own program.',
  size: '?',
  source: app.github && app.asset ? { github: app.github, asset: app.asset } : { url: app.url! },
  unpack: app.unpack,
  exe: app.exe,
  cli: app.cli,
});

/** The apps to install, in order: 7-Zip first when anything needs it to unpack. */
export const appsToInstall = (
  apps: Config['apps'],
  gitAccess: GitAccess,
): { entries: AppEntry[]; skipped: string[] } => {
  const chosen = apps.install.flatMap((id) => {
    const e = appById(id);
    return e && !e.setting ? [e] : [];
  });
  const skipped = chosen
    .filter((e) => e.fullGitOnly && gitAccess !== 'full')
    .map((e) => e.name + ' (needs provisioning.git.access "full")');
  const allowed = [
    ...chosen.filter((e) => !(e.fullGitOnly && gitAccess !== 'full')),
    ...Object.entries(apps.custom).map(([id, app]) => customEntry(id, app)),
  ];
  const needs7zip =
    allowed.some((e) => e.needs?.includes('7zip') || e.unpack === 'nsis') && !allowed.some((e) => e.id === '7zip');
  return { entries: [...(needs7zip ? [appById('7zip')!] : []), ...allowed], skipped };
};

/** Does any chosen app draw with OpenGL (so the Mesa step must run first)? */
export const appsNeedMesa = (apps: Config['apps'] | undefined): boolean =>
  Boolean(apps?.install.some((id) => appById(id)?.needs?.includes('mesa')));
