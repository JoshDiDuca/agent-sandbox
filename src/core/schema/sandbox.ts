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
export const Git = z.strictObject({ enabled: z.boolean().describe('Provide Git for Windows (and Git Bash, which Claude Code needs).'), access: GitAccess });
export const Provisioning = z.strictObject({
  copyFromHost: z.boolean().describe('Copy Node, Git, nvm and the agent from this PC when they are installed here.'),
  fallbackToInstall: z.boolean().describe('Download anything that cannot be copied from this PC.'),
  refresh: z.boolean().describe('Re-copy / re-download everything on the next launch.'),
  git: Git,
  terminal: toggle('Windows Terminal as the sandbox window (downloaded once).'),
});
