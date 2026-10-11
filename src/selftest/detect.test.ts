// "Which databases does this project need?": detection from real-world file shapes, and the plan the host builds.
import { databasesFromServices, detectDatabases, type ProjectFile } from '../core/detect-databases.js';
import { DEFAULTS } from '../core/config.js';
import { databaseCatalog, planDatabases } from '../host/project-scan.js';
import { voltaNode } from '../core/workspace.js';
import { decideToolchains, resolveToolchains } from '../core/detect-toolchains.js';
import { parseReleasePage } from '../shared/download.js';
import type { Harness } from './harness.js';

const found = (files: ProjectFile[], host: Parameters<typeof detectDatabases>[1] = []): string => detectDatabases(files, host).map((d) => d.database).join(',');

export const detectTests = (t: Harness): void => {
  const { check } = t;
  t.section('database detection');
  const compose = { path: 'docker-compose.yml', text: 'services:\n  db:\n    image: postgres:16-alpine\n  cache:\n    image: "redis:7"\n  dynamo:\n    image: amazon/dynamodb-local:latest\n' };
  check(found([compose]) === 'postgres,redis,dynamodb', 'compose services: postgres, redis and DynamoDB Local images');
  check(found([{ path: 'package.json', text: '{"dependencies":{"pg":"^8.11.0","ioredis":"5","@aws-sdk/client-dynamodb":"3"}}' }]) === 'postgres,redis,dynamodb', 'package.json: pg, ioredis, @aws-sdk/client-dynamodb');
  check(found([{ path: 'package.json', text: '{"dependencies":{"pgadmin-ui":"1","mysql-logger":"2","express":"4"}}' }]) === '', 'package.json: names that only contain a driver name do not count');
  check(found([{ path: 'prisma/schema.prisma', text: 'datasource db {\n  provider = "mysql"\n  url = env("DATABASE_URL")\n}' }]) === 'mysql', 'Prisma: the datasource provider decides');
  check(found([{ path: 'requirements.txt', text: 'django==5.0\npsycopg2-binary==2.9\npymongo>=4\n' }]) === 'postgres,mongodb', 'Python requirements: psycopg2 and pymongo');
  check(found([{ path: 'Api/Api.csproj', text: '<PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="8.0.0" />' }]) === 'sqlserver', '.NET: EF Core SQL Server provider');
  check(found([{ path: '.env.example', text: 'DATABASE_URL=postgresql://user:pass@localhost:5432/app\nMONGO_URL=mongodb+srv://cluster/x\n' }]) === 'postgres,mongodb', '.env templates: connection-string schemes');
  check(found([{ path: 'template.yaml', text: 'Resources:\n  Table:\n    Type: AWS::DynamoDB::Table\n' }]) === 'dynamodb', 'SAM/CloudFormation: a DynamoDB table resource');
  check(found([{ path: 'go.mod', text: 'require (\n\tgithub.com/jackc/pgx/v5 v5.5.0\n\tgithub.com/aws/aws-sdk-go-v2/service/dynamodb v1.0.0\n)' }]) === 'postgres,dynamodb', 'go.mod: pgx and the DynamoDB SDK');
  check(found([{ path: 'package.json', text: '{"dependencies":{"knex":"3"}}' }]) === '' && found([{ path: 'package.json', text: '{"dependencies":{"knex":"3"}}' }], ['mysql']) === 'mysql', 'an ORM that names no database uses the one installed on this PC (and nothing without one)');
  check(databasesFromServices(['postgresql-x64-16', 'MySQL80', 'MSSQL$SQLEXPRESS', 'Spooler', 'Redis']).join() === 'postgres,mysql,sqlserver,redis', 'database services on this PC are recognised by name');
  const plan = planDatabases({ ...DEFAULTS.databases, mongodb: { ...DEFAULTS.databases.mongodb, enabled: true }, redis: { ...DEFAULTS.databases.redis, enabled: false } }, 'unused', { files: [compose], host: [] });
  check(plan.map((p) => p.database + '@' + p.version + ':' + p.port).join() === 'postgres@16:5432,mongodb@latest:27017,dynamodb@latest:8000' && plan.find((p) => p.database === 'dynamodb')?.adminPort === 8001,
    'plan: "auto" from the project (compose pins Postgres 16), true always, false never; DynamoDB gets its admin UI');
  const catalog = databaseCatalog({ ...DEFAULTS.databases, postgres: { ...DEFAULTS.databases.postgres, enabled: false, port: 6543 } });
  check(catalog.map((p) => p.database).join() === 'postgres,mysql,mongodb,redis,dynamodb' && catalog[0].port === 6543, 'sbx-db catalog: every database that can run (not SQL Server), even ones off at boot, with their configured ports');
  const volta = t.write(t.temp + '\\volta-ws\\package.json', '{"name":"x","volta":{"node":"20.11.1","pnpm":"9.1.0"}}');
  t.write(t.temp + '\\no-volta-ws\\package.json', '{"name":"y","volta":{"node":"latest; rm -rf"}}');
  check(voltaNode(volta.replace(/\\package\.json$/, '')) === '20.11.1' && voltaNode(t.temp + '\\no-volta-ws') === null && voltaNode(t.temp + '\\missing') === null, 'Volta: package.json "volta.node" picks the Node version (only a plain version is accepted)');
  const tc = DEFAULTS.toolchains;
  const goApi = decideToolchains(tc, ['README.md', 'go.mod', 'api/main.go'], ['python', 'rust']);
  check(goApi.go.on && goApi.go.reason === 'go.mod' && !goApi.python.on && !goApi.rust.on && !goApi.dotnet.on && !goApi.java.on, 'toolchains: a Go project gets Go and nothing it does not use, whatever this PC has');
  const fresh = decideToolchains(tc, ['notes.txt'], ['python', 'dotnet']);
  check(fresh.python.on && fresh.dotnet.on && !fresh.go.on && fresh.python.reason.includes('this PC'), 'toolchains: a folder that is no project yet gets the languages this PC has');
  const rusty = decideToolchains({ ...tc, python: { ...tc.python, enabled: true } }, ['Cargo.toml'], []);
  check(rusty.rust.on && rusty.cpp.on && rusty.python.on && rusty.python.reason === 'enabled in config', 'toolchains: Rust brings its C/C++ linker; true in config always wins');
  check(resolveToolchains(tc, goApi).go.enabled === true && resolveToolchains(tc, goApi).python.enabled === false, 'the sandbox gets plain decisions instead of "auto"');
  const page = '<a href="/o/r/releases/download/v1/tool-win-x64.zip">x</a><span>sha256:' + 'a'.repeat(64) + '</span><a href="/o/r/releases/download/v1/tool-linux.tar.gz">y</a>';
  const assets = parseReleasePage(page);
  check(assets.length === 2 && assets[0].url === 'https://github.com/o/r/releases/download/v1/tool-win-x64.zip' && assets[0].sha256 === 'a'.repeat(64) && assets[1].sha256 === null, 'GitHub release page fallback (API rate limit): assets with their own sha256 only');
};
