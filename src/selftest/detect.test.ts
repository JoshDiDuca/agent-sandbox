// "What does this project need?": databases and toolchains detected from project files, and the plans built from them.
import { databasesFromServices, detectDatabases, type ProjectFile } from '../core/detect-databases.js';
import { DEFAULTS } from '../core/config.js';
import { databaseCatalog, planDatabases } from '../host/database-plan.js';
import { decideToolchains, resolveToolchains } from '../core/detect-toolchains.js';
import type { Suite } from './suite.js';

const found = (files: ProjectFile[], host: Parameters<typeof detectDatabases>[1] = []): string[] =>
  detectDatabases(files, host).map((d) => d.database);
const file = (path: string, text: string): ProjectFile => ({ path, text });

export const detectSuite: Suite = {
  name: 'detect',
  title: 'database and toolchain detection from project files',
  run: (t) => {
    t.section('databases from project files');
    const compose = file(
      'docker-compose.yml',
      'services:\n  db:\n    image: postgres:16-alpine\n  cache:\n    image: "redis:7"\n  dynamo:\n    image: amazon/dynamodb-local:latest\n',
    );
    t.equal(
      found([compose]),
      ['postgres', 'redis', 'dynamodb'],
      'compose services: postgres, redis and DynamoDB Local images',
    );
    t.equal(
      found([file('package.json', '{"dependencies":{"pg":"^8.11.0","ioredis":"5","@aws-sdk/client-dynamodb":"3"}}')]),
      ['postgres', 'redis', 'dynamodb'],
      'package.json: pg, ioredis, @aws-sdk/client-dynamodb',
    );
    t.equal(
      found([file('package.json', '{"dependencies":{"pgadmin-ui":"1","mysql-logger":"2","express":"4"}}')]),
      [],
      'package.json: names that only contain a driver name do not count',
    );
    t.equal(
      found([file('prisma/schema.prisma', 'datasource db {\n  provider = "mysql"\n  url = env("DATABASE_URL")\n}')]),
      ['mysql'],
      'Prisma: the datasource provider decides',
    );
    t.equal(
      found([file('requirements.txt', 'django==5.0\npsycopg2-binary==2.9\npymongo>=4\n')]),
      ['postgres', 'mongodb'],
      'Python requirements: psycopg2 and pymongo',
    );
    t.equal(
      found([
        file(
          'Api/Api.csproj',
          '<PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="8.0.0" />',
        ),
      ]),
      ['sqlserver'],
      '.NET: EF Core SQL Server provider',
    );
    t.equal(
      found([
        file(
          '.env.example',
          'DATABASE_URL=postgresql://user:pass@localhost:5432/app\nMONGO_URL=mongodb+srv://cluster/x\n',
        ),
      ]),
      ['postgres', 'mongodb'],
      '.env templates: connection-string schemes',
    );
    t.equal(
      found([file('template.yaml', 'Resources:\n  Table:\n    Type: AWS::DynamoDB::Table\n')]),
      ['dynamodb'],
      'SAM/CloudFormation: a DynamoDB table resource',
    );
    t.equal(
      found([
        file(
          'go.mod',
          'require (\n\tgithub.com/jackc/pgx/v5 v5.5.0\n\tgithub.com/aws/aws-sdk-go-v2/service/dynamodb v1.0.0\n)',
        ),
      ]),
      ['postgres', 'dynamodb'],
      'go.mod: pgx and the DynamoDB SDK',
    );
    const knex = [file('package.json', '{"dependencies":{"knex":"3"}}')];
    t.equal(found(knex), [], 'an ORM that names no database uses nothing when this PC has none');
    t.equal(found(knex, ['mysql']), ['mysql'], 'an ORM that names no database uses the one installed on this PC');
    t.equal(
      databasesFromServices(['postgresql-x64-16', 'MySQL80', 'MSSQL$SQLEXPRESS', 'Spooler', 'Redis']),
      ['postgres', 'mysql', 'sqlserver', 'redis'],
      'database services on this PC are recognised by name',
    );

    // Hostile workspace files (a cloned repository is untrusted): detection must stay linear.
    const hostile = [
      file('.env', 'Server=a;Database=a;'.repeat(12000)),
      file('compose.yaml', 'services:\n  x:\n    image: ' + 'postgres'.repeat(20000) + '!\n'),
      file('appsettings.json', 'Host=a;'.repeat(30000)),
    ];
    const started = Date.now();
    detectDatabases(hostile);
    const took = Date.now() - started;
    t.check(
      took < 2000,
      'database detection stays fast on hostile workspace files (no catastrophic backtracking)',
      'took ' + took + ' ms',
    );

    t.section('the database plan');
    const plan = planDatabases(
      {
        ...DEFAULTS.databases,
        mongodb: { ...DEFAULTS.databases.mongodb, enabled: true },
        redis: { ...DEFAULTS.databases.redis, enabled: false },
      },
      'unused',
      { files: [compose], host: [] },
    );
    t.equal(
      plan.map((p) => p.database + '@' + p.version + ':' + p.port),
      ['postgres@16:5432', 'mongodb@latest:27017', 'dynamodb@latest:8000'],
      'plan: "auto" from the project (compose pins Postgres 16), true always, false never',
    );
    t.equal(plan.find((p) => p.database === 'dynamodb')?.adminPort, 8001, 'plan: DynamoDB gets its admin UI port');
    const catalog = databaseCatalog({
      ...DEFAULTS.databases,
      postgres: { ...DEFAULTS.databases.postgres, enabled: false, port: 6543 },
    });
    t.equal(
      catalog.map((p) => p.database),
      ['postgres', 'mysql', 'mongodb', 'redis', 'dynamodb'],
      'sbx-db catalog: every database that can run (not SQL Server), even ones off at boot',
    );
    t.equal(catalog[0].port, 6543, 'sbx-db catalog: configured ports are used');

    t.section('toolchains from project files');
    const tc = DEFAULTS.toolchains;
    const goProject = decideToolchains(tc, ['README.md', 'go.mod', 'api/main.go'], ['python', 'rust']);
    t.equal(
      { go: goProject.go.on, reason: goProject.go.reason },
      { go: true, reason: 'go.mod' },
      'toolchains: a Go project gets Go (and says why)',
    );
    t.equal(
      { python: goProject.python.on, rust: goProject.rust.on, dotnet: goProject.dotnet.on, java: goProject.java.on },
      { python: false, rust: false, dotnet: false, java: false },
      'toolchains: a Go project gets nothing it does not use, whatever this PC has',
    );
    const fresh = decideToolchains(tc, ['notes.txt'], ['python', 'dotnet']);
    t.equal(
      { python: fresh.python.on, dotnet: fresh.dotnet.on, go: fresh.go.on },
      { python: true, dotnet: true, go: false },
      'toolchains: a folder that is no project yet gets the languages this PC has',
    );
    t.includes(fresh.python.reason, 'this PC', 'toolchains: the reason names this PC');
    const rusty = decideToolchains({ ...tc, python: { ...tc.python, enabled: true } }, ['Cargo.toml'], []);
    t.equal(
      { rust: rusty.rust.on, cpp: rusty.cpp.on },
      { rust: true, cpp: true },
      'toolchains: Rust brings its C/C++ linker',
    );
    t.equal(
      { python: rusty.python.on, reason: rusty.python.reason },
      { python: true, reason: 'enabled in config' },
      'toolchains: true in config always wins',
    );
    const resolved = resolveToolchains(tc, goProject);
    t.equal(
      { go: resolved.go.enabled, python: resolved.python.enabled },
      { go: true, python: false },
      'the sandbox gets plain decisions instead of "auto"',
    );
  },
};
