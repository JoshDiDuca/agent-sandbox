// `npm run install:global`: installs this checkout globally as a COPY (packed tarball), not a link.
// That is what makes it safe to develop agent-sandbox inside its own sandbox: the agent edits this repository, but the
// claude-sbx you run is a frozen copy, and the agent's changes only reach your PC when you run this script again.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const out = path.resolve('.pack');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
execSync('npm pack --silent --pack-destination "' + out + '"', { stdio: ['ignore', 'ignore', 'inherit'] });
const tarball = fs.readdirSync(out).find((f) => f.endsWith('.tgz'));
if (!tarball) throw new Error('npm pack did not produce a package in ' + out);
// The package used to be called agent-sandbox; both ship the same commands, so npm refuses to install over it.
const globals = JSON.parse(execSync('npm ls -g --depth=0 --json', { encoding: 'utf8' }) || '{}').dependencies ?? {};
if (globals['agent-sandbox']) {
  console.log('Removing the old agent-sandbox package (now windows-development-sandbox) ...');
  execSync('npm uninstall -g agent-sandbox', { stdio: 'inherit' });
}
execSync('npm install -g "' + path.join(out, tarball) + '" --no-fund --no-audit', { stdio: 'inherit' });
fs.rmSync(out, { recursive: true, force: true });
console.log('\nInstalled ' + tarball + ' globally as a copy. Review what changed before you run this again.');
