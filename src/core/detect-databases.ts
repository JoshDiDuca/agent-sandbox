// Which databases a project needs, worked out from its files: compose files, dependency manifests of every ecosystem,
// ORM schemas, connection strings and .env templates. Pure (file contents in, verdicts out), so the host can run it at
// launch and the tests can feed it fixtures.

export const DATABASES = ['postgres', 'mysql', 'sqlserver', 'mongodb', 'redis', 'dynamodb'] as const;
export type Database = (typeof DATABASES)[number];

export interface ProjectFile { path: string; text: string }

/** Files worth reading, by name (lower case). Everything else is ignored, so a scan stays fast on big repos. */
export const INTERESTING_FILE = /^(package\.json|requirements[\w.-]{0,40}\.txt|pyproject\.toml|pipfile|setup\.py|setup\.cfg|gemfile|go\.mod|cargo\.toml|composer\.json|pom\.xml|build\.gradle(\.kts)?|[\w.-]+\.(cs|fs|vb)proj|directory\.packages\.props|packages\.config|schema\.prisma|(docker-)?compose[\w.-]{0,40}\.ya?ml|\.env(\.[\w.-]+)?|appsettings[\w.-]{0,40}\.json|database\.yml|application[\w.-]{0,40}\.(properties|ya?ml)|knexfile\.[jt]s|ormconfig\.(json|[jt]s)|drizzle\.config\.[jt]s|alembic\.ini|settings\.py|mix\.exs|deno\.json|serverless\.ya?ml|template\.ya?ml|samconfig\.toml|[\w.-]+\.tf|cdk\.json)$/i;

/** Evidence per database. Each rule: a file-name test, a content pattern, and the reason shown to the user. */
type Rule = [file: RegExp, pattern: RegExp, reason: string];
const manifests = /^(package\.json|deno\.json)$/i;
const python = /^(requirements[\w.-]{0,40}\.txt|pyproject\.toml|pipfile|setup\.py|setup\.cfg)$/i;
const dotnet = /\.(cs|fs|vb)proj$|^directory\.packages\.props$|^packages\.config$/i;
const jvm = /^(pom\.xml|build\.gradle(\.kts)?)$/i;
const compose = /^(docker-)?compose[\w.-]{0,40}\.ya?ml$/i;
const config = /^(\.env(\.[\w.-]+)?|appsettings[\w.-]{0,40}\.json|database\.yml|application[\w.-]{0,40}\.(properties|ya?ml)|knexfile\.[jt]s|ormconfig\.(json|[jt]s)|drizzle\.config\.[jt]s|alembic\.ini|settings\.py)$/i;
const infra = /^(serverless\.ya?ml|template\.ya?ml|[\w.-]+\.tf)$/i;
const dep = (names: string): RegExp => new RegExp('["\'\\s/=]?(' + names + ')["\'\\s@=<>~^:,\\]\\n]', 'i');

const RULES: Record<Database, Rule[]> = {
  postgres: [
    [compose, /image:\s*["']?[\w./-]{0,80}(postgres|postgis|timescaledb|supabase\/postgres|pgvector)[\w.-]{0,40}(:|\s|["']|$)/im, 'a compose service runs Postgres'],
    [manifests, dep('pg|postgres|pg-promise|@neondatabase/serverless|@vercel/postgres|slonik|postgres-js|@electric-sql/pglite'), 'a Postgres driver in package.json'],
    [python, dep('psycopg2?(-binary)?|psycopg\\[[\\w,]+\\]|asyncpg|pg8000|django\\.db\\.backends\\.postgresql'), 'a Postgres driver in the Python dependencies'],
    [/^gemfile$/i, /gem\s+["']pg["']/, 'the pg gem'],
    [/^go\.mod$/i, /github\.com\/(jackc\/pgx|lib\/pq)/, 'a Postgres driver in go.mod'],
    [/^cargo\.toml$/i, /tokio-postgres|postgres\s*=|sqlx[^\n]{0,200}postgres|diesel[^\n]{0,200}postgres|sea-orm[^\n]{0,200}postgres/i, 'a Postgres driver in Cargo.toml'],
    [dotnet, /Npgsql/i, 'Npgsql in a .NET project'],
    [jvm, /org\.postgresql|postgresql:postgresql|r2dbc-postgresql/i, 'the Postgres JDBC driver'],
    [/^composer\.json$/i, /ext-pgsql|ext-pdo_pgsql/i, 'the PHP Postgres extension'],
    [/^mix\.exs$/i, /:postgrex/, 'Postgrex'],
    [/^schema\.prisma$/i, /provider\s*=\s*"(postgresql|postgres|cockroachdb)"/, 'Prisma uses PostgreSQL'],
    [config, /postgres(ql)?(\+\w+)?:\/\/|DB_CONNECTION\s*=\s*pgsql|adapter:\s*postgres|\bHost=[^;\s]{1,200};\s*(Port=\d{1,5};\s*)?Database=|jdbc:postgresql:/i, 'a Postgres connection string'],
  ],
  mysql: [
    [compose, /image:\s*["']?[\w./-]{0,80}(mysql|mariadb|percona)[\w.-]{0,40}(:|\s|["']|$)/im, 'a compose service runs MySQL / MariaDB'],
    [manifests, dep('mysql2?|mariadb|@planetscale/database'), 'a MySQL driver in package.json'],
    [python, dep('pymysql|mysqlclient|mysql-connector-python|aiomysql|asyncmy|mariadb'), 'a MySQL driver in the Python dependencies'],
    [/^gemfile$/i, /gem\s+["'](mysql2|trilogy)["']/, 'a MySQL gem'],
    [/^go\.mod$/i, /github\.com\/go-sql-driver\/mysql/, 'the MySQL driver in go.mod'],
    [/^cargo\.toml$/i, /mysql_async|mysql\s*=|sqlx[^\n]{0,200}mysql|diesel[^\n]{0,200}mysql/i, 'a MySQL driver in Cargo.toml'],
    [dotnet, /MySqlConnector|MySql\.Data|Pomelo\.EntityFrameworkCore\.MySql/i, 'a MySQL driver in a .NET project'],
    [jvm, /mysql-connector|mariadb-java-client|com\.mysql/i, 'the MySQL JDBC driver'],
    [/^composer\.json$/i, /ext-mysqli|ext-pdo_mysql/i, 'the PHP MySQL extension'],
    [/^mix\.exs$/i, /:myxql/, 'MyXQL'],
    [/^schema\.prisma$/i, /provider\s*=\s*"mysql"/, 'Prisma uses MySQL'],
    [config, /(mysql|mariadb)(\+\w+)?:\/\/|DB_CONNECTION\s*=\s*(mysql|mariadb)|adapter:\s*(mysql2|trilogy)|jdbc:(mysql|mariadb):/i, 'a MySQL connection string'],
  ],
  sqlserver: [
    [compose, /image:\s*["']?(mcr\.microsoft\.com\/(mssql|azure-sql-edge)|[\w./-]{0,80}mssql)[\w./:-]{0,80}/im, 'a compose service runs SQL Server'],
    [manifests, dep('mssql|tedious|msnodesqlv8'), 'a SQL Server driver in package.json'],
    [python, dep('pyodbc|pymssql|aioodbc|mssql-django'), 'a SQL Server driver in the Python dependencies'],
    [/^go\.mod$/i, /(denisenkom|microsoft)\/go-mssqldb/, 'the SQL Server driver in go.mod'],
    [/^cargo\.toml$/i, /tiberius|sqlx[^\n]{0,200}mssql/i, 'a SQL Server driver in Cargo.toml'],
    [dotnet, /Microsoft\.Data\.SqlClient|System\.Data\.SqlClient|EntityFrameworkCore\.SqlServer|Dapper\.SqlBuilder|LocalDb/i, 'SQL Server in a .NET project'],
    [jvm, /mssql-jdbc|com\.microsoft\.sqlserver/i, 'the SQL Server JDBC driver'],
    [/^composer\.json$/i, /ext-sqlsrv|ext-pdo_sqlsrv/i, 'the PHP SQL Server extension'],
    [/^schema\.prisma$/i, /provider\s*=\s*"sqlserver"/, 'Prisma uses SQL Server'],
    [config, /\(localdb\)|mssql(\+\w+)?:\/\/|sqlserver:\/\/|DB_CONNECTION\s*=\s*sqlsrv|jdbc:sqlserver:|Initial Catalog=|Trusted_Connection=|TrustServerCertificate=|Integrated Security=/i, 'a SQL Server connection string'],
  ],
  mongodb: [
    [compose, /image:\s*["']?[\w./-]{0,80}mongo(db)?[\w.-]{0,40}(:|\s|["']|$)/im, 'a compose service runs MongoDB'],
    [manifests, dep('mongodb|mongoose|@typegoose/typegoose|mongodb-memory-server'), 'a MongoDB driver in package.json'],
    [python, dep('pymongo|motor|mongoengine|beanie|djongo'), 'a MongoDB driver in the Python dependencies'],
    [/^gemfile$/i, /gem\s+["'](mongoid|mongo)["']/, 'a MongoDB gem'],
    [/^go\.mod$/i, /go\.mongodb\.org\/mongo-driver/, 'the MongoDB driver in go.mod'],
    [/^cargo\.toml$/i, /^\s*mongodb\s*=/m, 'the MongoDB crate'],
    [dotnet, /MongoDB\.Driver|MongoDB\.EntityFrameworkCore/i, 'the MongoDB driver in a .NET project'],
    [jvm, /mongodb-driver|spring-boot-starter-data-mongodb/i, 'the MongoDB Java driver'],
    [/^schema\.prisma$/i, /provider\s*=\s*"mongodb"/, 'Prisma uses MongoDB'],
    [config, /mongodb(\+srv)?:\/\//i, 'a MongoDB connection string'],
  ],
  dynamodb: [
    [compose, /image:\s*["']?(amazon\/dynamodb-local|[\w./-]{0,80}dynamodb-local|instructure\/dynamo-local-admin)[\w.:-]{0,40}/im, 'a compose service runs DynamoDB Local'],
    [manifests, dep('@aws-sdk/client-dynamodb|@aws-sdk/lib-dynamodb|dynamoose|electrodb|dynamodb-toolbox|@typedorm/core|dynamodb-onetable'), 'a DynamoDB client in package.json'],
    [python, dep('pynamodb|boto3-stubs\\[[^\\]]{0,80}dynamodb[^\\]]{0,80}\\]|types-aiobotocore-dynamodb|mypy-boto3-dynamodb|dynamorm'), 'a DynamoDB client in the Python dependencies'],
    [/^gemfile$/i, /gem\s+["'](aws-sdk-dynamodb|dynamoid|aws-record)["']/, 'a DynamoDB gem'],
    [/^go\.mod$/i, /aws-sdk-go-v2\/service\/dynamodb|github\.com\/guregu\/dynamo/, 'a DynamoDB client in go.mod'],
    [/^cargo\.toml$/i, /^\s*(aws-sdk-dynamodb|serde_dynamo|modyne)\s*=/m, 'a DynamoDB crate'],
    [dotnet, /AWSSDK\.DynamoDBv2/i, 'AWSSDK.DynamoDBv2 in a .NET project'],
    [jvm, /software\.amazon\.awssdk[^\n]{0,200}dynamodb|aws-java-sdk-dynamodb|dynamodb-enhanced/i, 'the DynamoDB Java SDK'],
    [infra, /AWS::DynamoDB::(Global)?Table|aws_dynamodb_table/, 'a DynamoDB table in the infrastructure code'],
    [config, /AWS_ENDPOINT_URL_DYNAMODB|DYNAMO(DB)?_(ENDPOINT|URL|TABLE)|dynamodb\.[\w-]+\.amazonaws\.com|localhost:8000/i, 'DynamoDB settings in the config'],
  ],
  redis: [
    [compose, /image:\s*["']?[\w./-]{0,80}(redis|valkey|keydb|dragonfly)[\w.-]{0,40}(:|\s|["']|$)/im, 'a compose service runs Redis'],
    [manifests, dep('redis|ioredis|bullmq|bull|@upstash/redis|connect-redis|rate-limit-redis'), 'a Redis client in package.json'],
    [python, dep('redis|aioredis|rq|celery\\[redis\\]|django-redis|arq'), 'a Redis client in the Python dependencies'],
    [/^gemfile$/i, /gem\s+["'](redis|sidekiq|resque)["']/, 'a Redis gem'],
    [/^go\.mod$/i, /github\.com\/(redis\/go-redis|go-redis\/redis|gomodule\/redigo)/, 'a Redis client in go.mod'],
    [/^cargo\.toml$/i, /^\s*(redis|deadpool-redis|bb8-redis)\s*=/m, 'a Redis crate'],
    [dotnet, /StackExchange\.Redis|Microsoft\.Extensions\.Caching\.StackExchangeRedis/i, 'StackExchange.Redis in a .NET project'],
    [jvm, /jedis|lettuce-core|spring-boot-starter-data-redis|redisson/i, 'a Redis Java client'],
    [/^composer\.json$/i, /predis\/predis|ext-redis/i, 'a PHP Redis client'],
    [config, /rediss?:\/\/|REDIS_(URL|HOST)\s*=|CACHE_DRIVER\s*=\s*redis/i, 'a Redis connection string'],
  ],
};

/** Libraries that talk to "a SQL database" without saying which: then this PC's own database decides (see below). */
const GENERIC_SQL: Rule[] = [
  [manifests, dep('knex|sequelize|typeorm|drizzle-orm|kysely|@mikro-orm/core|objection|prisma'), 'an SQL ORM'],
  [python, dep('sqlalchemy|django|peewee|tortoise-orm|sqlmodel|alembic'), 'an SQL ORM'],
  [dotnet, /Microsoft\.EntityFrameworkCore(?!\.(Sqlite|InMemory))|Dapper/i, 'Entity Framework / Dapper'],
  [/^gemfile$/i, /gem\s+["'](rails|activerecord|sequel)["']/, 'ActiveRecord'],
  [jvm, /spring-boot-starter-data-jpa|hibernate-core|jooq/i, 'JPA / Hibernate'],
  [/^go\.mod$/i, /gorm\.io\/gorm|entgo\.io\/ent|github\.com\/jmoiron\/sqlx/, 'an SQL ORM'],
  [/^cargo\.toml$/i, /^\s*(sqlx|diesel|sea-orm)\s*=/m, 'an SQL ORM'],
  [/^composer\.json$/i, /laravel\/framework|doctrine\/orm/i, 'Laravel / Doctrine'],
];

const fileName = (p: string): string => p.split(/[\\/]/).pop() ?? p;
const SQL: Database[] = ['postgres', 'mysql', 'sqlserver'];

export interface Detection { database: Database; reasons: string[] }

/**
 * The databases a project needs, each with the evidence ("compose.yaml: a compose service runs Postgres"). `hostHas` is
 * what this PC has installed: when the project only shows a database-agnostic ORM, the SQL database you use here is
 * taken (Postgres first if several), so an ORM project still gets a database.
 */
/** Longest line and file looked at: bounded work per file whatever a (sandbox-written) file contains. */
const MAX_LINE = 1000;
const MAX_TEXT = 256 * 1024;
const bounded = (text: string): string => text.slice(0, MAX_TEXT).split('\n').filter((line) => line.length <= MAX_LINE).join('\n');

export const detectDatabases = (input: ProjectFile[], hostHas: Database[] | (() => Database[]) = []): Detection[] => {
  const files = input.map((f) => ({ path: f.path, text: bounded(f.text) }));
  const found = new Map<Database, string[]>();
  const add = (db: Database, reason: string): void => { const list = found.get(db) ?? []; if (!list.includes(reason)) list.push(reason); found.set(db, list); };
  for (const file of files) {
    const name = fileName(file.path);
    for (const db of DATABASES) for (const [test, pattern, reason] of RULES[db]) if (test.test(name) && pattern.test(file.text)) add(db, file.path + ': ' + reason);
  }
  if (!SQL.some((db) => found.has(db))) {
    const orm = files.flatMap((file) => GENERIC_SQL.filter(([test, pattern]) => test.test(fileName(file.path)) && pattern.test(file.text)).map(([, , reason]) => file.path + ': ' + reason));
    const host = orm.length ? (typeof hostHas === 'function' ? hostHas() : hostHas) : [];
    const mine = SQL.find((db) => host.includes(db));
    if (orm.length && mine) add(mine, orm[0] + ', and this PC has ' + mine + ' installed');
  }
  return DATABASES.filter((db) => found.has(db)).map((database) => ({ database, reasons: found.get(database)! }));
};

/** Windows service names of databases installed on this PC (from `sc query`), e.g. postgresql-x64-16, MySQL80. */
export const databasesFromServices = (serviceNames: string[]): Database[] => {
  const has = (r: RegExp): boolean => serviceNames.some((s) => r.test(s));
  return DATABASES.filter((db) => ({
    postgres: has(/^postgresql/i),
    mysql: has(/^(mysql|mariadb)/i),
    sqlserver: has(/^(MSSQLSERVER|MSSQL\$|SQLServer)/i),
    mongodb: has(/^mongodb/i),
    redis: has(/^(redis|memurai)/i),
    dynamodb: false,
  })[db]);
};
