// Databases that run inside the sandbox.
import { z } from 'zod';
import { Enabled } from './common.js';

export const Port = z.number().int().min(1024).max(65535);
export const dbEnabled = (name: string) =>
  Enabled.describe(
    name +
      ': true, false, or "auto" = only when the project needs it (found from compose files, dependencies of every language, Prisma/ORM config and connection strings).',
  );
export const Databases = z.strictObject({
  postgres: z.strictObject({
    enabled: dbEnabled('PostgreSQL (with psql, pg_dump). User postgres, no password, localhost only'),
    version: z
      .string()
      .min(1)
      .describe('"latest" or a major version such as "16". A compose file pinning postgres:<major> wins.'),
    port: Port.describe('Port inside the sandbox.'),
  }),
  mysql: z.strictObject({
    enabled: dbEnabled('MySQL-compatible database (MariaDB). User root, no password, localhost only'),
    version: z.string().min(1).describe('"lts" (newest MariaDB LTS) or a MariaDB series such as "11.4".'),
    port: Port.describe('Port inside the sandbox.'),
  }),
  mongodb: z.strictObject({
    enabled: dbEnabled('MongoDB with mongosh, localhost only'),
    version: z.string().min(1).describe('"latest" or a version prefix such as "8.0".'),
    port: Port.describe('Port inside the sandbox.'),
  }),
  redis: z.strictObject({
    enabled: dbEnabled('Redis (community Windows build), localhost only'),
    port: Port.describe('Port inside the sandbox.'),
  }),
  dynamodb: z.strictObject({
    enabled: dbEnabled(
      "DynamoDB Local (Amazon's official emulator, on the Java toolchain) with dynamodb-admin, a web UI to browse and edit tables",
    ),
    port: Port.describe('DynamoDB endpoint port inside the sandbox (http://localhost:<port>).'),
    adminPort: Port.describe(
      "dynamodb-admin web UI port (open http://localhost:<adminPort> in the sandbox's browser).",
    ),
    admin: z.boolean().describe('Run dynamodb-admin next to DynamoDB Local.'),
  }),
  sqlserver: z.strictObject({
    enabled: dbEnabled(
      'SQL Server. It cannot run inside Windows Sandbox; when a project needs it you get a note to use Postgres or SQLite for local work',
    ),
  }),
});
