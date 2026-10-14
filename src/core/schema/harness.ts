// An agent (claude, codex, ...) the sandbox can run.
import { z } from 'zod';
import { StringsSchema } from './common.js';

/** A folder below the agent's state folder: plain names only, no drive, no "..". */
const SubfolderSchema = z
  .string()
  .regex(/^(?!.*(^|[\\/])\.\.([\\/]|$))[A-Za-z0-9._ -]+([\\/][A-Za-z0-9._ -]+)*$/, 'a plain relative folder');

/** Where an agent keeps its login and settings inside the sandbox, so logins can be saved and switched. */
export const HarnessHomeSchema = z.strictObject({
  env: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), SubfolderSchema)
    .describe('Environment variable -> folder (below the sandbox state folder) the agent keeps its data in.'),
  loginFiles: z
    .array(SubfolderSchema)
    .describe("Files that make up the login, relative to the agent's own state folder (state\\<agent>)."),
  hostDir: z
    .string()
    .optional()
    .describe(
      "The agent's own folder on this PC (e.g. ~/.codex): loginFiles are read from it to save this PC's login.",
    ),
});

export const HarnessSchema = z
  .strictObject({
    hostExecutable: z
      .string()
      .optional()
      .describe('Executable copied from this PC when installed here (e.g. claude.exe).'),
    hostDir: z
      .string()
      .optional()
      .describe('Folder of hostExecutable on this PC, or "auto" to search PATH and ~/.local/bin.'),
    npmPackage: z.string().optional().describe('npm package installed inside the sandbox when there is no host copy.'),
    npmBin: z.string().optional().describe('Command the npm package provides.'),
    uvPackage: z
      .string()
      .optional()
      .describe('Python package installed with `uv tool install` inside the sandbox (e.g. aider-chat).'),
    uvBin: z.string().optional().describe('Command the uv package provides.'),
    arguments: StringsSchema.describe('Arguments always passed to the agent.'),
    environment: z.record(z.string(), z.string()).describe('Environment variables for the agent.'),
    home: HarnessHomeSchema.optional().describe(
      'Where its login lives inside the sandbox; leave out when the agent cannot be pointed at a folder (then its login is not kept between sandboxes).',
    ),
    resumeArguments: StringsSchema.optional().describe(
      'Arguments used when the agent is restarted in place (e.g. after an account switch) so it resumes the conversation.',
    ),
  })
  .refine((h) => h.hostExecutable || h.npmPackage || h.uvPackage, 'needs hostExecutable, npmPackage or uvPackage')
  .refine((h) => !h.uvPackage || h.uvBin, 'needs uvBin when uvPackage is set')
  .refine((h) => !h.npmPackage || h.npmBin, 'needs npmBin when npmPackage is set');
