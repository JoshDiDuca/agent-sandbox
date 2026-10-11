// An agent (claude, codex, ...) the sandbox can run.
import { z } from 'zod';
import { Strings } from './common.js';

export const Harness = z.strictObject({
  hostExecutable: z.string().optional().describe('Executable copied from this PC when installed here (e.g. claude.exe).'),
  hostDir: z.string().optional().describe('Folder of hostExecutable on this PC, or "auto" to search PATH and ~/.local/bin.'),
  npmPackage: z.string().optional().describe('npm package installed inside the sandbox when there is no host copy.'),
  npmBin: z.string().optional().describe('Command the npm package provides.'),
  uvPackage: z.string().optional().describe('Python package installed with `uv tool install` inside the sandbox (e.g. aider-chat).'),
  uvBin: z.string().optional().describe('Command the uv package provides.'),
  arguments: Strings.describe('Arguments always passed to the agent.'),
  environment: z.record(z.string(), z.string()).describe('Environment variables for the agent.'),
  resumeArguments: Strings.optional().describe('Arguments used when the agent is restarted in place (e.g. after an account switch) so it resumes the conversation.'),
})
  .refine((h) => h.hostExecutable || h.npmPackage || h.uvPackage, 'needs hostExecutable, npmPackage or uvPackage')
  .refine((h) => !h.uvPackage || h.uvBin, 'needs uvBin when uvPackage is set')
  .refine((h) => !h.npmPackage || h.npmBin, 'needs npmBin when npmPackage is set');
