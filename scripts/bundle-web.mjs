// Bundles the web UI (web/) into dist/web: one hashed script, one hashed stylesheet and an index.html that names them.
// No inline scripts, no CDN: the server's CSP allows only files from itself. Run after tsc (npm run build does it).
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const OUT = 'dist/web';
fs.rmSync(OUT, { recursive: true, force: true });

const result = await build({
  entryPoints: ['web/src/main.tsx'],
  outdir: OUT,
  entryNames: '[name]-[hash]',
  assetNames: '[name]-[hash]',
  bundle: true,
  minify: true,
  platform: 'browser',
  format: 'esm',
  target: ['es2020', 'chrome100', 'firefox100', 'safari15'],
  jsx: 'automatic',
  loader: { '.woff': 'file', '.woff2': 'file', '.svg': 'file' },
  define: { 'process.env.NODE_ENV': '"production"' },
  metafile: true,
  legalComments: 'none',
  logLevel: 'warning',
});

const outputs = Object.keys(result.metafile.outputs).map((file) => path.basename(file));
const script = outputs.find((name) => name.endsWith('.js'));
const style = outputs.find((name) => name.endsWith('.css'));
if (!script || !style) throw new Error('The web bundle has no script or stylesheet.');
const assets =
  '<link rel="stylesheet" href="/' + style + '" />\n    <script type="module" src="/' + script + '"></script>';
const html = fs.readFileSync('web/index.html', 'utf8').replace('<!--assets-->', assets);
fs.writeFileSync(path.join(OUT, 'index.html'), html);
