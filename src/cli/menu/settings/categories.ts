// How the settings are grouped on screen: categories in the sidebar, readable names for sections and toolchains. Every
// top-level setting of both files must belong to a category (a self-test checks it), so nothing is ever hidden.
import { Text } from '../../tui/index.js';

export interface SettingsCategory {
  id: string;
  label: string;
  description: string;
  keys: string[];
}

export const CATEGORIES: SettingsCategory[] = [
  {
    id: 'general',
    label: 'General',
    description: 'Which agent starts, where the project appears in the sandbox, and extra folders from this PC.',
    keys: ['defaultHarness', 'harness', 'guestWorkspace', 'readOnly', 'mappings', 'scripts'],
  },
  {
    id: 'machine',
    label: 'Sandbox machine',
    description: 'Memory, CPU, window, GPU, clipboard, audio and network of the sandbox itself.',
    keys: ['sandbox'],
  },
  {
    id: 'languages',
    label: 'Languages & tools',
    description: 'Toolchains installed in the sandbox. "auto" follows your project\'s files and what this PC has.',
    keys: ['toolchains'],
  },
  {
    id: 'apps',
    label: 'Apps',
    description:
      'Desktop apps installed in the sandbox: editors, database clients, API clients, game engines ... (also: Apps catalogue on the home screen).',
    keys: ['apps'],
  },
  {
    id: 'databases',
    label: 'Databases',
    description: 'Databases that run inside the sandbox. Their data persists between sandboxes.',
    keys: ['databases'],
  },
  {
    id: 'agents',
    label: 'Agents & attaching',
    description: 'The agents you can start, attaching your terminal to them, and the (Beta) agent commands.',
    keys: ['harnesses', 'attach', 'agentCommands'],
  },
  {
    id: 'claude',
    label: 'Claude profile',
    description: 'Which of your Claude settings, history and memory are copied in and synced back.',
    keys: ['claudeProfile'],
  },
  {
    id: 'network',
    label: 'Network',
    description:
      'What the sandbox can reach: your LAN, only some hosts, blocked hosts, DNS, a proxy, and ports forwarded from this PC to servers inside. (No network at all: Sandbox machine > Networking.)',
    keys: ['network'],
  },
  {
    id: 'security',
    label: 'Security & privacy',
    description:
      'Git-ignored files kept out, secrets kept out of the sandbox, download checks, what is kept on this PC, and sharing your sandbox with other Windows users.',
    keys: ['workspaceFilter', 'audit', 'secrets', 'downloads', 'storage', 'sharing'],
  },
  {
    id: 'setup',
    label: 'Setup & hooks',
    description:
      'How tools get into the sandbox (copied from this PC or downloaded), Git, the terminal, and hook scripts.',
    keys: ['provisioning', 'hooks'],
  },
  {
    id: 'projects',
    label: 'Projects',
    description: 'Several projects in one sandbox: project roots mapped at every start, adding folders while it runs.',
    keys: ['projects'],
  },
  {
    id: 'resume',
    label: 'Reopening sessions',
    description: 'Open the sessions of the last sandbox again when a new one starts, or after a crash.',
    keys: ['resume'],
  },
  {
    id: 'desktop',
    label: 'Desktop look',
    description: 'Copy your theme, accent colour, taskbar and wallpaper into the sandbox.',
    keys: ['personalization'],
  },
];

/** Readable names for sections and toolchains (anything missing gets a name made from its key). */
const NAMES: Record<string, string> = {
  sandbox: 'Sandbox machine',
  attach: 'Attaching your terminal',
  agentCommands: 'Agent commands (Beta)',
  provisioning: 'Provisioning',
  downloads: 'Downloads',
  secrets: 'Secrets',
  claudeProfile: 'Claude profile',
  storage: 'Storage on this PC',
  network: 'Network',
  hooks: 'Hooks',
  personalization: 'Desktop look',
  projects: 'Projects',
  resume: 'Reopening sessions',
  harnesses: 'Agents',
  databases: 'Databases',
  toolchains: 'Toolchains',
  git: 'Git',
  terminal: 'Windows Terminal',
  conpty: 'Pseudo console',
  node: 'Node.js',
  python: 'Python',
  java: 'Java (JDK)',
  dotnet: '.NET',
  go: 'Go',
  rust: 'Rust',
  cpp: 'C / C++ (MinGW)',
  msvc: 'Visual C++ (MSVC)',
  ruby: 'Ruby',
  php: 'PHP',
  deno: 'Deno',
  bun: 'Bun',
  pwsh: 'PowerShell 7',
  vscode: 'VS Code',
  mesa: 'OpenGL (Mesa)',
  uv: 'uv',
  pnpm: 'pnpm',
  yarn: 'Yarn',
  cli: 'Command-line tools',
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mongodb: 'MongoDB',
  redis: 'Redis',
  dynamodb: 'DynamoDB Local',
  environment: 'Environment variables',
  workspaceFilter: 'Git-ignored files',
  audit: 'Audit log',
};

export function nameOf(key: string): string {
  return NAMES[key] ?? Text.humanize(key);
}

export function categoryOf(topKey: string): SettingsCategory | undefined {
  return CATEGORIES.find((c) => c.keys.includes(topKey));
}
