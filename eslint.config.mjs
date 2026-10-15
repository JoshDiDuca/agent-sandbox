import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const BOUNDARY = 'Crosses an architecture boundary (CLAUDE.md).';
const forbid = (...a) => ['error', { patterns: [{ regex: `(^|/)(${a.join('|')})/`, message: BOUNDARY }] }];
/** Host code may use the shared core's kernel (types, schemas), never its features or registry. */
const forbidWithKernel = (...a) => [
  'error',
  {
    patterns: [
      { regex: `(^|/)(${a.join('|')})/`, message: BOUNDARY },
      { regex: '(^|/)app/(?!kernel/)', message: 'Host code may import only the kernel of src/app (CLAUDE.md).' },
    ],
  },
];
/** The pure part of the shared core: what the web bundle imports. Only zod, the kernel and other *.def.ts files. */
const PURE = 'The kernel and *.def.ts are pure: zod, the kernel and *.def.ts only (docs/design/shared-core.md).';
const pureImports = (extra = []) => [
  'error',
  {
    patterns: [
      { regex: '^node:', message: PURE },
      { regex: '^(?!zod$)[^./]', message: PURE },
      { regex: '(^|/)(host|cli|sync|guest|selftest|shared)/', message: PURE },
      { regex: String.raw`(^|/)core/(?!util/errors(\.js)?$)`, message: PURE },
      { regex: String.raw`(^|/)(registry|context)(\.js)?$|\.run(\.js)?$`, message: PURE },
      ...extra,
    ],
  },
];
/** The Node globals the build and release scripts use (TypeScript files get theirs from @types/node). */
const NODE_GLOBALS = Object.fromEntries(
  ['console', 'process', 'Buffer', 'URL', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'fetch'].map(
    (name) => [name, 'readonly'],
  ),
);

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'schemas/**', 'hooks/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['scripts/**/*.mjs', '*.mjs'], languageOptions: { globals: NODE_GLOBALS } },
  {
    files: ['src/**/*.ts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      eqeqeq: 'error',
      'no-control-regex': 'off',
      'max-len': [
        'error',
        {
          code: 120,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
          ignoreRegExpLiterals: true,
          ignoreUrls: true,
        },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: 'TSEnumDeclaration', message: 'Use a string union.' },
        { selector: 'TSModuleDeclaration', message: 'No namespaces.' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // The browser app: its own tsconfig (DOM types), and it may import only the shared protocol types from src/.
    files: ['web/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { projectService: false, project: './web/tsconfig.json', tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      eqeqeq: 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '(^|/)src/(?!shared/web/|app/kernel/|app/features/defs$)',
              message: 'The app may import only src/shared/web, src/app/kernel and src/app/features/defs (CLAUDE.md).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/guest/**/*.ts'],
    rules: { 'no-restricted-imports': forbid('host', 'cli', 'sync', 'selftest', 'app') },
  },
  {
    files: ['src/shared/**/*.ts', 'src/core/**/*.ts'],
    rules: { 'no-restricted-imports': forbid('host', 'cli', 'sync', 'guest', 'selftest', 'app') },
  },
  {
    files: ['src/host/**/*.ts', 'src/sync/**/*.ts'],
    rules: { 'no-restricted-imports': forbidWithKernel('cli', 'guest', 'selftest') },
  },
  // The shared core. Its kernel and *.def.ts files are pure (the web bundle imports them); a def imports only other
  // *.def.ts files of its folder; the Node side (*.run.ts, the registry) never draws: no terminal UI, no React.
  { files: ['src/app/kernel/**/*.ts'], rules: { 'no-restricted-imports': pureImports() } },
  {
    files: ['src/app/features/**/*.def.ts', 'src/app/features/defs.ts'],
    rules: {
      'no-restricted-imports': pureImports([
        {
          regex: String.raw`^(?!.*(/kernel/|/core/util/errors))\.\.?/(.*/)?(?![^/]*\.def(\.js)?$)[^/]+$`,
          message: 'A *.def.ts imports only the kernel and *.def.ts files.',
        },
      ]),
    },
  },
  {
    files: ['src/app/**/*.ts'],
    ignores: ['src/app/kernel/**', 'src/app/features/**/*.def.ts', 'src/app/features/defs.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '(^|/)cli/(tui|menu|output)/', message: 'Features talk through io and never draw (CLAUDE.md).' },
            { regex: '^(react|@mantine|@inquirer)', message: 'Features talk through io and never draw (CLAUDE.md).' },
            { regex: '(^|/)(guest|selftest)/', message: BOUNDARY },
          ],
        },
      ],
    },
  },
  { files: ['src/cli/**/*.ts', 'src/api.ts', 'src/bin/**/*.ts'], rules: { 'no-restricted-imports': forbid('guest') } },
);
