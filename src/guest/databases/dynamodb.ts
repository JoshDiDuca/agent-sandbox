// DynamoDB Local + dynamodb-admin.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { DatabasePlan } from '../../core/types.js';
import { downloader, fetchText } from '../../shared/download/index.js';
import { execAsync } from '../runtime/process.js';
import { exists, mkdirp } from '../runtime/fs.js';
import { log } from '../runtime/log.js';
import { logsDir } from '../runtime/paths.js';
import { ensureJdk } from '../toolchains/languages/java.js';
import { tool, type ToolEnv } from '../toolchains/tool-env.js';
import { portOpen, waitForPort } from '../runtime/ports.js';
import { dataFor, startServer } from './server.js';

const DYNAMO_ZIP = 'https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/dynamodb_local_latest.zip';

/**
 * Amazon's DynamoDB Local (a Java program; the Java toolchain step runs first, else this installs the LTS JDK) and
 * dynamodb-admin, the web UI to browse and edit tables, installed with the runner's own npm. Every AWS SDK picks the
 * local endpoint up from AWS_ENDPOINT_URL_DYNAMODB, with dummy credentials (real ones never reach the sandbox).
 */
export const setupDynamo = async (env: ToolEnv, plan: DatabasePlan): Promise<void> => {
  const java = path.join(await ensureJdk(), 'bin', 'java.exe');
  const home = tool('dynamodb-local');
  if (!exists(path.join(home, 'DynamoDBLocal.jar'))) {
    log('Downloading DynamoDB Local (~60 MB once) ...');
    const sha256 = (await fetchText(DYNAMO_ZIP + '.sha256')).trim().split(/\s+/)[0];
    await downloader.archive(DYNAMO_ZIP, home, { sha256, locate: 'DynamoDBLocal.jar', fileName: 'dynamodb_local.zip' });
  }
  const data = mkdirp(dataFor('dynamodb'));
  // -sharedDb: one database whatever region/credentials a client uses, so the admin UI and the app see the same tables.
  await startServer(
    'dynamodb',
    java,
    [
      '-Djava.library.path=' + path.join(home, 'DynamoDBLocal_lib'),
      '-jar',
      path.join(home, 'DynamoDBLocal.jar'),
      '-sharedDb',
      '-dbPath',
      data,
      '-port',
      String(plan.port),
    ],
    plan.port,
  );
  const endpoint = 'http://localhost:' + plan.port;
  const aws = {
    AWS_ENDPOINT_URL_DYNAMODB: endpoint,
    DYNAMO_ENDPOINT: endpoint,
    AWS_ACCESS_KEY_ID: 'local',
    AWS_SECRET_ACCESS_KEY: 'local',
    AWS_REGION: 'us-east-1',
    AWS_DEFAULT_REGION: 'us-east-1',
  };
  Object.assign(env.vars, aws);
  env.summary.push(
    'dynamodb (DynamoDB Local): ' +
      endpoint +
      ' (AWS SDKs use it automatically via AWS_ENDPOINT_URL_DYNAMODB; dummy credentials)',
  );
  if (!plan.adminPort) return;
  const prefix = tool('dynamodb-admin');
  const script = path.join(prefix, 'node_modules', 'dynamodb-admin', 'dist', 'dynamodb-admin.js');
  if (!exists(script)) {
    log('Installing dynamodb-admin, the DynamoDB web UI (~20 MB once) ...');
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    await execAsync(
      process.execPath,
      [npmCli, 'install', '--global', '--prefix', prefix, 'dynamodb-admin', '--no-fund', '--no-audit'],
      { stdio: 'ignore' },
    );
  }
  // The database matters more than its UI: a taken port is reported, not fatal.
  if (await portOpen(plan.adminPort)) {
    env.summary.push(
      'dynamodb-admin: NOT started, port ' + plan.adminPort + ' is in use (change databases.dynamodb.adminPort)',
    );
    return;
  }
  const out = fs.openSync(path.join(logsDir, 'dynamodb-admin.log'), 'a');
  spawn(
    process.execPath,
    [script, '--port', String(plan.adminPort), '--dynamo-endpoint', endpoint, '--skip-default-credentials'],
    { detached: true, stdio: ['ignore', out, out], windowsHide: true, env: { ...process.env, ...aws } },
  ).unref();
  fs.closeSync(out);
  if (!(await waitForPort(plan.adminPort, 30)))
    throw new Error('dynamodb-admin did not start; see ' + path.join(logsDir, 'dynamodb-admin.log'));
  env.summary.push(
    'dynamodb-admin: http://localhost:' + plan.adminPort + " (browse and edit tables in the sandbox's browser)",
  );
};
