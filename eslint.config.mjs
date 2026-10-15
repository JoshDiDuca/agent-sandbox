import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const forbid = (...a) => [
  'error',
  { patterns: [{ regex: `(^|/)(${a.join('|')})/`, message: 'Crosses an architecture boundary (CLAUDE.md).' }] },
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
              regex: '(^|/)src/(?!shared/web/)',
              message: 'The app may import only src/shared/web (CLAUDE.md).',
            },
          ],
        },
      ],
    },
  },
  { files: ['src/guest/**/*.ts'], rules: { 'no-restricted-imports': forbid('host', 'cli', 'sync', 'selftest') } },
  {
    files: ['src/shared/**/*.ts', 'src/core/**/*.ts'],
    rules: { 'no-restricted-imports': forbid('host', 'cli', 'sync', 'guest', 'selftest') },
  },
  {
    files: ['src/host/**/*.ts', 'src/sync/**/*.ts'],
    rules: { 'no-restricted-imports': forbid('cli', 'guest', 'selftest') },
  },
  { files: ['src/cli/**/*.ts', 'src/api.ts', 'src/bin/**/*.ts'], rules: { 'no-restricted-imports': forbid('guest') } },
);
