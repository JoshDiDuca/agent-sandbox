// Settings: every setting of your own file (all projects) or of this folder's .sandbox-config.json (this project), read
// from the config schema through Fields, with get, set and reset. Pure: schemas and the view; the rows are made on the
// Node side (settings-rows.ts) because the config schema is, and secrets never leave it unmasked.
import { z } from 'zod';
import {
  action,
  defineOperation,
  defineQuery,
  defineView,
  FieldSchema,
  link,
  valueText,
  type Item,
  type Page,
  type Section,
} from '../../kernel/index.js';

export const ScopeSchema = z
  .enum(['user', 'project'])
  .describe("Your own settings (all projects) or this folder's .sandbox-config.json (this project)");
export type Scope = z.output<typeof ScopeSchema>;

const KeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/)
  .max(200)
  .describe('The setting, e.g. sandbox.memoryMb');

/** One setting as every surface shows it. Values are what the file or the merged settings say, secrets as ***. */
export const SettingRowSchema = z.object({
  id: z.string().describe('The setting, e.g. sandbox.memoryMb'),
  key: z.array(z.string()),
  label: z.string(),
  category: z.string(),
  /** A heading inside the category (Toolchains › Node.js). */
  section: z.string().optional(),
  field: FieldSchema,
  /** In effect in this scope (this project: only what its file says). */
  value: z.unknown(),
  /** Written in this scope's file. */
  set: z.boolean(),
  /** Your own setting in effect (all projects), and whether your file sets it. */
  yours: z.unknown(),
  yoursSet: z.boolean(),
  /** What this project's file says (undefined: not set there, or a project cannot set it). */
  inProject: z.unknown().optional(),
  /** The built-in default (your own settings only). */
  default: z.unknown().optional(),
  /** A project can only make this stricter than your own setting. */
  locked: z.boolean(),
});
export type SettingRow = z.output<typeof SettingRowSchema>;

export const SettingsListSchema = z.object({
  scope: ScopeSchema,
  file: z.string().describe('The file this scope edits'),
  exists: z.boolean(),
  /** Your own settings: where the data folder is (it has its own flow; its setting is not listed). */
  dataFolder: z.string().optional(),
  categories: z.array(z.object({ id: z.string(), label: z.string(), description: z.string() })),
  rows: z.array(SettingRowSchema),
});
export type SettingsList = z.output<typeof SettingsListSchema>;

export const listSettings = defineQuery({
  id: 'settings.list',
  title: 'Settings',
  summary: 'every setting with its value, by category',
  input: z.object({ scope: ScopeSchema.default('user') }),
  output: SettingsListSchema,
  cli: { name: 'config', action: 'list', json: true },
});

export const getSetting = defineQuery({
  id: 'settings.get',
  title: 'Get a setting',
  summary: 'show one setting (secrets as ***)',
  input: z.object({ key: KeySchema }),
  output: z.object({ key: z.string(), value: z.unknown() }),
  text: (o) => (typeof o.value === 'string' ? o.value : JSON.stringify(o.value, null, 2)),
  surfaces: { except: { menu: 'Settings shows every value', web: 'the Settings page shows every value' } },
  cli: { name: 'config', action: 'get', positional: ['key'] },
});

export const setSetting = defineOperation({
  id: 'settings.set',
  title: 'Change a setting',
  summary: 'change one setting (text is read like the command line: true/on, numbers, JSON)',
  input: z.object({
    scope: ScopeSchema.default('user'),
    key: KeySchema,
    value: z.unknown().describe('The new value'),
  }),
  output: z.object({ key: z.string(), changed: z.boolean(), message: z.string() }),
  text: (o) => o.message,
  cli: { name: 'config', action: 'set', positional: ['key', 'value'] },
});

export const resetSetting = defineOperation({
  id: 'settings.reset',
  title: 'Reset a setting',
  summary: 'put one setting back to its default (in a project file: remove it)',
  input: z.object({ scope: ScopeSchema.default('user'), key: KeySchema }),
  output: z.object({ key: z.string(), changed: z.boolean(), message: z.string() }),
  text: (o) => o.message,
  cli: { name: 'config', action: 'reset', positional: ['key'] },
});

/** The facts under a setting: its key, your value, the project's, the default, and the lock. */
function details(row: SettingRow, scope: Scope): string[] {
  const text = (v: unknown): string => valueText(v, row.field, 40).text;
  return [
    'Setting       ' + row.id,
    'All projects  ' + text(row.yours) + (row.yoursSet ? '  (your file)' : '  (built-in default)'),
    'This project  ' + (row.inProject === undefined ? 'not set' : text(row.inProject)),
    ...(scope === 'user' ? ['Default       ' + text(row.default)] : []),
    ...(scope === 'project' && row.locked ? ['A project can only make this stricter than your own setting.'] : []),
  ];
}

function settingItem(row: SettingRow, scope: Scope): Item {
  const shown =
    scope === 'project' && !row.set
      ? 'all projects: ' + valueText(row.yours, row.field, 40).text
      : valueText(row.value, row.field).text;
  const editable = row.field.kind === 'secret' ? '' : row.value;
  return {
    id: row.id,
    label: row.label,
    hint: shown,
    ...(row.set ? { tone: scope === 'project' ? 'accent' : 'ok', badges: [{ text: 'set', tone: 'accent' }] } : {}),
    description: row.field.help,
    group: row.section,
    details: details(row, scope),
    keywords: row.id,
    cells: { setting: row.id, value: shown },
    primary: action(
      setSetting,
      { scope, key: row.id },
      {
        label: 'Change',
        verb: 'edit',
        fields: [{ ...row.field, name: 'value', label: row.label }],
        initial: { value: editable },
      },
    ),
    actions: row.set
      ? [
          action(
            resetSetting,
            { scope, key: row.id },
            { label: scope === 'project' ? 'Remove' : 'Reset to default', verb: 'reset', key: 'r' },
          ),
        ]
      : [],
  };
}

/** The Data folder row: where the saved data is; moving it has a flow of its own (menu; sandbox storage move). */
function dataFolderItem(folder: string): Item {
  return {
    id: '@data-folder',
    label: 'Data folder',
    hint: folder,
    cells: { setting: 'storage.root', value: folder },
    description:
      'Where your tools, logins, history and logs are kept between sandboxes. Move it with the menu (Settings > Data folder) or sandbox storage move <folder>.',
    primary: link({ kind: 'command', argv: ['storage'] }, 'Data folder', { verb: 'change' }),
  };
}

/** The settings page of one scope: a section per category, each setting with its value and an edit action. */
export function settingsPage(o: SettingsList): Page {
  const sections: Section[] = o.categories.map((c) => ({
    id: c.id,
    title: c.label,
    description: c.description,
    columns: [
      { key: 'setting', label: 'SETTING' },
      { key: 'value', label: 'VALUE' },
    ],
    columnsOn: 'cli',
    items: [
      ...o.rows.filter((r) => r.category === c.id).map((r) => settingItem(r, o.scope)),
      ...(c.id === 'general' && o.dataFolder ? [dataFolderItem(o.dataFolder)] : []),
    ],
  }));
  return {
    title: 'Settings',
    notice: {
      text:
        'Editing ' +
        o.file +
        (o.exists ? '' : ' (created when you save)') +
        (o.scope === 'project' ? ': only what a project may set; needs your approval at the next launch' : ''),
      tone: o.scope === 'project' ? 'accent' : 'muted',
    },
    sections,
  };
}

export const settingsView = defineView({
  id: 'settings',
  title: 'Settings',
  summary: 'Every setting, for all projects or just this project, with its value, default and description.',
  queries: { settings: listSettings },
  operations: [setSetting, resetSetting],
  tabs: {
    param: 'scope',
    choices: [
      { value: 'user', label: 'All projects' },
      { value: 'project', label: 'This project' },
    ],
  },
  inputs: (params: { scope: Scope }) => ({ settings: { scope: params.scope } }),
  build: ({ settings }) => settingsPage(settings),
});
