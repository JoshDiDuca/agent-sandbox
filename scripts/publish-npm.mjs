// `npm run publish:npm`: publishes this version to npmjs.com from your PC. Needed once, for the first version (npm
// only lets CI publish a package that exists); after that CI publishes every release. Packs exactly like CI does.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const npm = (args, inherit = false) => spawnSync('npm', args, { shell: true, encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe' });
const stop = (message) => { console.error('\x1b[31m' + message + '\x1b[0m'); process.exit(1); };

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const user = npm(['whoami', '--registry', 'https://registry.npmjs.org']);
if (user.status !== 0) stop('Not signed in to npm. Run `npm login` first, then `npm run publish:npm` again.');
console.log('Publishing ' + pkg.name + '@' + pkg.version + ' as ' + user.stdout.trim() + ' ...');
if (npm(['view', pkg.name + '@' + pkg.version, 'version']).stdout.trim() === pkg.version) stop(pkg.version + ' is already on npm. Bump the version first (npm version patch).');

// The packed package is already built: without `prepare`, installing it runs no package script.
const original = fs.readFileSync('package.json');
let file = '';
try {
  npm(['pkg', 'delete', 'scripts.prepare']);
  const packed = npm(['pack', '--silent']);
  file = packed.stdout.trim().split(/\r?\n/).pop() ?? '';
  if (packed.status !== 0 || !fs.existsSync(file)) stop('npm pack failed:\n' + packed.stderr);
} finally {
  fs.writeFileSync('package.json', original);
}

// npm asks for a one-time password here if your account uses 2FA.
const published = npm(['publish', file, '--access', 'public', '--registry', 'https://registry.npmjs.org'], true);
fs.rmSync(file, { force: true });
if (published.status !== 0) stop('npm publish failed (see above).');
console.log('\nPublished: https://www.npmjs.com/package/' + pkg.name);
const repo = String(pkg.repository?.url ?? '').replace(/^git\+https:\/\/github\.com\//, '').replace(/\.git$/, '');
console.log('Next: let CI publish the next versions. Add an npm automation token as the NPM_TOKEN secret of ' + repo + '.');
