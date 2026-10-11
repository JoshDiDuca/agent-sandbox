// The host <-> sandbox channel messages, defined once with zod. Both sides parse what they read: the guest only acts on
// these request kinds, and the host treats everything the guest writes as untrusted (shapes checked, sizes capped).
import { z } from 'zod';

export const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'invalid id');
const Text = (max = 4096) => z.string().max(max);
const Time = Text(64);

export const AttachEndpoint = z.strictObject({
  addresses: z.array(Text(64)).max(16),
  port: z.number().int().min(1024).max(65535),
  token: Text(256),
});

/** C:\AgentData\run\sandbox.json: boot progress of the sandbox as a whole. */
export const SandboxStatus = z.object({
  launchId: Text(64),
  phase: z.enum(['booting', 'provisioning', 'ready', 'failed']),
  message: Text(),
  updatedAt: Time,
  workspaceHost: Text(),
  guestWorkspace: Text(),
  headless: z.boolean(),
});

/** C:\AgentData\run\requests\<id>.json: the ONLY things the host can ask the sandbox to do. */
export const GuestRequest = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), id: Id, harness: Text(64), args: z.array(Text()).max(256), cwd: Text(), createdAt: Time }),
  z.strictObject({ kind: z.literal('exec'), id: Id, command: z.array(Text()).min(1).max(256), cwd: Text(), timeoutSeconds: z.number().positive().max(86400), createdAt: Time }),
  z.strictObject({ kind: z.literal('restart'), id: Id, harness: Text(64).nullable(), createdAt: Time }),
  z.strictObject({ kind: z.literal('ping'), id: Id, createdAt: Time }),
]);

/** C:\AgentData\run\responses\<id>.json: the guest's reply. */
export const GuestResponse = z.object({
  id: Id,
  ok: z.boolean(),
  message: Text(65536),
  exitCode: z.number().int().optional(),
  stdout: Text(4 * 1024 * 1024).optional(),
  stderr: Text(4 * 1024 * 1024).optional(),
  finishedAt: Time,
});

/** C:\AgentData\run\sessions\<id>.json: one agent session (its own pseudo console and terminal tab). */
export const SessionStatus = z.object({
  id: Id,
  launchId: Text(64),
  harness: Text(64),
  cwd: Text(),
  phase: z.enum(['starting', 'running', 'exited', 'failed']),
  message: Text(),
  updatedAt: Time,
  startedAt: Time,
  exitCode: z.number().int().optional(),
  attach: AttachEndpoint.optional(),
});

export type AttachEndpointT = z.output<typeof AttachEndpoint>;
export type SandboxStatusT = z.output<typeof SandboxStatus>;
export type GuestRequestT = z.output<typeof GuestRequest>;
export type GuestResponseT = z.output<typeof GuestResponse>;
export type SessionStatusT = z.output<typeof SessionStatus>;
