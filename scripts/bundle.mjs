// Bundles each sandbox entry point into one self-contained file (dist/runtime/*.js) with its dependencies (zod, ...),
// so the launch folder needs no node_modules. Run after tsc (npm run build does both).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/guest/main.ts', 'src/guest/daemon.ts', 'src/guest/view.ts', 'src/guest/gitguard.ts'],
  outdir: 'dist/runtime',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // CommonJS dependencies bundled into ESM may call require() for Node built-ins.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});
