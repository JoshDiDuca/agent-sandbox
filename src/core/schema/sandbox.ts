// The sandbox machine, folders mapped into it, and what is provisioned (Git, terminal).
import { z } from 'zod';
import { GitAccess, GuestPath, toggle } from './common.js';

export const GuestWorkspace = z.union([z.literal('auto'), z.literal('mirror'), GuestPath]).describe('Where the workspace appears inside the sandbox. "auto" = C:\\Workspace\\<folder name>. "mirror" = the same path as on this PC, so absolute paths in configs and build caches match (another drive letter such as F: is a subst drive onto C:\\Mirror\\F); paths the sandbox reserves (C:\\Users\\..., C:\\Program Files\\...) fall back to "auto".');

export const Mapping = z.strictObject({
  host: z.string().min(1).describe('Folder on this PC (relative paths are relative to the config file).'),
  guest: GuestPath.describe('Where it appears inside the sandbox, e.g. C:\\Assets, or on another drive letter (D: to Z:) such as F:\\SteamLibrary\\steamapps\\common\\Game: mapped to C:\\Mirror\\F\\... and shown as F: (subst) at boot.'),
  readOnly: z.boolean().describe('true = the agent can only read it.'),
  optional: z.boolean().optional().describe('true = skip it quietly when the host folder does not exist.'),
});

export const Sandbox = z.strictObject({
  memoryMb: z.union([z.literal('auto'), z.number().int().min(2048)]).describe('Sandbox RAM in MB (>= 2048), or "auto": free RAM minus reserveHostMb, capped at maxMemoryMb.'),
  maxMemoryMb: z.number().int().positive().describe('Upper limit for memoryMb "auto".'),
  maxMemoryPercent: z.number().int().min(10).max(100).describe('memoryMb "auto" never takes more than this share of this PC\'s total RAM (percent).'),
  cpuLimit: z.union([z.literal('none'), z.number().int().min(5).max(100)]).describe('Most of this PC\'s CPU the sandbox may use, in percent (5-100), e.g. 50 keeps half free for you; "none" = no cap (Windows Sandbox would take every processor). Covers everything this tool starts in the sandbox (agents, installs, builds, its terminal).'),
  reserveHostMb: z.number().int().nonnegative().describe('RAM always left for this PC when memoryMb is "auto".'),
  vGpu: z.boolean().describe('Virtual GPU. Off by default: Microsoft notes it widens the sandbox attack surface.'),
  networking: z.boolean().describe('Internet access. false is the only hard network isolation Windows Sandbox offers.'),
  clipboard: z.boolean().describe('Shared clipboard between this PC and the sandbox.'),
  audioInput: z.boolean().describe('Microphone access.'),
  videoInput: z.boolean().describe('Camera access.'),
  printerRedirection: z.boolean().describe('Printers from this PC.'),
  protectedClient: z.boolean().describe('Run the sandbox window in Protected Client mode (recommended).'),
  headless: z.boolean().describe('Hide the sandbox window (sbx-show brings it back). A headless sandbox shuts down when its last session ends.'),
});
const Port = z.number().int().min(1).max(65535);
const HostEntry = z.string().max(253).regex(/^(@developer|(\*\.)?([a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+)$/, 'a host name like example.com, *.example.com, or @developer');

export const Network = z.strictObject({
  blockPrivateRanges: z.boolean().describe('Block your LAN (10/8, 172.16/12, 192.168/16, SMB) from inside the sandbox.'),
  allowOnly: z.array(HostEntry).describe('Only these hosts can be reached once the sandbox is set up (tools still download first). *.example.com covers its subdomains; @developer adds package registries, GitHub, toolchain downloads and the AI providers. Programs go through a proxy in the sandbox (HTTP_PROXY); anything else is blocked by its firewall. Empty = no limit.'),
  blockHosts: z.array(z.string().max(253).regex(/^([a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+$/, 'a host name like telemetry.example.com')).describe('Never reachable from the sandbox, e.g. production servers or telemetry (each exact name; the sandbox\'s hosts file sends them nowhere).'),
  forwardPorts: z.array(z.strictObject({
    pc: Port.describe('The port on this PC (localhost only).'),
    sandbox: Port.describe('The port inside the sandbox (a server there may listen on localhost only).'),
  })).describe('Reach servers in the sandbox from this PC: http://localhost:<pc> here goes to <sandbox> inside, while it runs. Nothing else on your network can use them.'),
  dns: z.array(z.string().regex(/^\d{1,3}(\.\d{1,3}){3}$/, 'an IPv4 address like 1.1.1.1')).describe('DNS servers for the sandbox instead of your network\'s, e.g. 1.1.1.1 and 9.9.9.9.'),
  proxy: z.string().regex(/^(https?:\/\/[^\s]+)?$/, 'http://host:port').describe('An HTTP proxy the sandbox uses to reach the internet (HTTP_PROXY / HTTPS_PROXY for everything in it), e.g. http://proxy.corp:8080. Empty = none.'),
});

export const Audit = z.strictObject({
  enabled: z.boolean().describe('Keep an audit log on this PC of what happened in your sandboxes: programs started (with their command lines), files changed in the project, sessions, and what the repo guard caught. The sandbox cannot change it. Read it with sandbox audit.'),
  days: z.number().int().min(1).max(365).describe('Days the audit log is kept.'),
  maxMb: z.number().int().min(5).max(5000).describe('Most space the audit log may take, in MB (older days go first). Days before today are compressed.'),
  processes: z.boolean().describe('Record every program started in the sandbox with its command line (Windows process auditing; repeated runs are counted, not listed).'),
  files: z.boolean().describe('Record the files changed in the project while the sandbox runs.'),
});

export const WorkspaceFilter = z.strictObject({
  enabled: z.boolean().describe('Keep what your .gitignore lists (.env files, node_modules, build output ...) out of the sandbox. The sandbox works on a copy of the project without those files, kept in step with it both ways within about a second; what it creates that is ignored (its own node_modules, builds) stays in the sandbox. Git works as usual. Off = the project folder itself is mapped.'),
  exclude: z.array(z.string().max(500)).describe('Also keep these out, as .gitignore patterns, e.g. secrets/, *.pem, data/private/.'),
  include: z.array(z.string().max(500)).describe('Let these in although .gitignore lists them, e.g. .env.example, data/fixtures/.'),
});
export const Git = z.strictObject({ enabled: z.boolean().describe('Provide Git for Windows (and Git Bash, which Claude Code needs).'), access: GitAccess });
export const Provisioning = z.strictObject({
  copyFromHost: z.boolean().describe('Copy Node, Git, nvm and the agent from this PC when they are installed here.'),
  fallbackToInstall: z.boolean().describe('Download anything that cannot be copied from this PC.'),
  refresh: z.boolean().describe('Re-copy / re-download everything on the next launch.'),
  git: Git,
  terminal: toggle('Windows Terminal as the sandbox window (downloaded once).'),
  conpty: toggle('Agent sessions use Microsoft\'s newer pseudo console (conpty.dll, downloaded once) instead of the one built into Windows: no garbled screen after resizing, real scrollback for the mouse wheel. Off = the one built into Windows.'),
});

export const Downloads = z.strictObject({
  requireChecksum: z.boolean().describe('Refuse any toolchain, database or tool download that has no published checksum (SHA-256/SHA-512) to verify it against. false = allow those, as before. Downloads that do have a published checksum are always verified. A project\'s .sandbox-config.json can only turn this on.'),
});
