// Bundles each sandbox entry point into one self-contained file (dist/runtime/*.js) with its dependencies (zod, ...),
// so the launch folder needs no node_modules. Run after tsc (npm run build does both).
import { build } from 'esbuild';

await build({
  entryPoints: ['main', 'daemon', 'view', 'gitguard', 'db', 'netproxy'].map(
    (name) => 'src/guest/entries/' + name + '.ts',
  ),
  outdir: 'dist/runtime',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // ES module builds first: jsonc-parser's default (UMD) build loads its parts with require() calls esbuild cannot follow.
  mainFields: ['module', 'main'],
  // CommonJS dependencies bundled into ESM may call require() for Node built-ins.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  legalComments: 'none',
  logLevel: 'warning',
});
