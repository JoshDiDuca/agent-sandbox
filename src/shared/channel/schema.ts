// The host <-> sandbox channel messages, defined once with zod. Both sides parse what they read: the guest only acts on
// these request kinds, and the host treats everything the guest writes as untrusted (shapes checked, sizes capped).
import { z } from 'zod';
import { HarnessSchema, ToolchainsSchema } from '../../core/schema/index.js';

export const IdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'invalid id');
const Text = (max = 4096) => z.string().max(max);
const TimeSchema = Text(64);

export const AttachEndpointSchema = z.strictObject({
  addresses: z.array(Text(64)).max(16),
  port: z.number().int().min(1024).max(65535),
  token: Text(256),
});

/** C:\AgentData\run\sandbox.json: boot progress of the sandbox as a whole. */
export const SandboxStatusSchema = z.object({
  launchId: Text(64),
  phase: z.enum(['booting', 'provisioning', 'ready', 'failed']),
  message: Text(),
  updatedAt: TimeSchema,
  workspaceHost: Text(),
  guestWorkspace: Text(),
  headless: z.boolean(),
  /** The sandbox's IPv4 addresses (for network.forwardPorts; the host only uses ones on its Hyper-V network). */
  addresses: z.array(z.string().max(45)).max(8).optional(),
});

const VersionSchema = z.strictObject({ spec: Text(128), source: Text(256) });
const DatabasePlanSchema = z.strictObject({
  database: z.enum(['postgres', 'mysql', 'sqlserver', 'mongodb', 'redis', 'dynamodb']),
  reasons: z.array(Text(1024)).max(32),
  version: Text(64),
  port: z.number().int().min(1024).max(65535),
  adminPort: z.number().int().min(1024).max(65535).optional(),
});

/**
 * A project the host registered after boot (sandbox claude from another folder): everything the guest needs to
 * provision it and run its sessions with its own environment, resolved on the host exactly like a fresh launch (its
 * approved .sandbox-config.json, version files, toolchain detection, database plan). Host -> guest only.
 */
export const ProjectSpecSchema = z.strictObject({
  name: IdSchema,
  /** Inside the sandbox: C:\Projects\<name>. */
  workspace: Text(1024),
  workspaceHost: Text(1024),
  toolchains: ToolchainsSchema,
  versions: z.strictObject({ node: VersionSchema, nodeExtra: z.array(Text(128)).max(16), python: VersionSchema }),
  databases: z.array(DatabasePlanSchema).max(8),
  /** Agents this project may start that the sandbox did not boot with (its .sandbox-config.json "harness"). */
  harnesses: z.record(Text(64), HarnessSchema).refine((h) => Object.keys(h).length <= 8, 'at most 8 agents'),
  /** Its hooks were staged in C:\AgentLaunch\projects\<name>\hooks. */
  hooks: z.boolean(),
});

/** C:\AgentData\run\requests\<id>.json: the ONLY things the host can ask the sandbox to do. */
export const GuestRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('session'),
    id: IdSchema,
    harness: Text(64),
    args: z.array(Text()).max(256),
    cwd: Text(),
    project: ProjectSpecSchema.optional(),
    harnessSpec: HarnessSchema.optional(),
    createdAt: TimeSchema,
  }),
  /** Provision a registered project without starting an agent (sandbox start / exec / db from its folder). */
  z.strictObject({ kind: z.literal('project'), id: IdSchema, project: ProjectSpecSchema, createdAt: TimeSchema }),
  z.strictObject({
    kind: z.literal('exec'),
    id: IdSchema,
    command: z.array(Text()).min(1).max(256),
    cwd: Text(),
    timeoutSeconds: z.number().positive().max(86400),
    createdAt: TimeSchema,
  }),
  /** cwd: only the sessions in this folder or below (one project's); omitted = every session. */
  z.strictObject({
    kind: z.literal('restart'),
    id: IdSchema,
    harness: Text(64).nullable(),
    cwd: Text().optional(),
    createdAt: TimeSchema,
  }),
  z.strictObject({ kind: z.literal('ping'), id: IdSchema, createdAt: TimeSchema }),
]);

/** C:\AgentData\run\responses\<id>.json: the guest's reply. */
export const GuestResponseSchema = z.object({
  id: IdSchema,
  ok: z.boolean(),
  message: Text(65536),
  exitCode: z.number().int().optional(),
  stdout: Text(4 * 1024 * 1024).optional(),
  stderr: Text(4 * 1024 * 1024).optional(),
  finishedAt: TimeSchema,
});

/** C:\AgentData\run\sessions\<id>.json: one agent session (its own pseudo console and terminal tab). */
export const SessionStatusSchema = z.object({
  id: IdSchema,
  launchId: Text(64),
  harness: Text(64),
  cwd: Text(),
  /** The project it runs in: its hub name, or the launch folder's for the first project. */
  project: Text(64).optional(),
  phase: z.enum(['starting', 'running', 'exited', 'failed']),
  message: Text(),
  updatedAt: TimeSchema,
  startedAt: TimeSchema,
  exitCode: z.number().int().optional(),
  attach: AttachEndpointSchema.optional(),
});

/** C:\AgentData\run\projects\<name>.json: how far a project's provisioning is (guest-written, so validated and capped). */
export const ProjectStatusSchema = z.object({
  name: IdSchema,
  workspace: Text(1024),
  phase: z.enum(['provisioning', 'ready', 'failed']),
  message: Text(),
  updatedAt: TimeSchema,
  databases: z.array(z.object({ database: Text(32), port: z.number().int() })).max(16),
  summary: z.array(Text(512)).max(64),
});

export type ProjectSpec = z.output<typeof ProjectSpecSchema>;
export type ProjectStatus = z.output<typeof ProjectStatusSchema>;
export type AttachEndpoint = z.output<typeof AttachEndpointSchema>;
export type SandboxStatus = z.output<typeof SandboxStatusSchema>;
export type GuestRequest = z.output<typeof GuestRequestSchema>;
export type GuestResponse = z.output<typeof GuestResponseSchema>;
export type SessionStatus = z.output<typeof SessionStatusSchema>;
