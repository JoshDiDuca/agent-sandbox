// Section 4: the apps catalogue. Groups on the left, space ticks, and the ticks are staged until Ctrl+S saves them. Two
// scopes like Settings: apps for every project, or for this project only.
import { errMsg } from '../../../core/util/index.js';
import { Theme, type App, type ListOptions, type ListResult } from '../../tui/index.js';
import { openIssuePage } from '../../../host/web/index.js';
import { AppsModel, requestAppUrl } from '../apps.js';
import type { ConfigFile } from '../settings/config-file.js';
import type { Draft } from '../settings/draft.js';
import { ValueEditor } from '../settings/value-editor.js';
import { SCOPES, scopeStatus, type Scope } from './scopes.js';
import { ListPage, type Outcome } from './list-page.js';
import type { ShellExit } from '../shell.js';
import type { Step } from '../../tui/index.js';

/** The list for the apps tab. Pure. */
export function appsOptions(model: AppsModel, file: ConfigFile, draft: Draft, scope: Scope): ListOptions<string> {
  return {
    path: [],
    status: scopeStatus(file),
    intro: 'Tick the apps every sandbox should have (space). Each downloads once and is kept. Ctrl+S saves.',
    tabs: { items: SCOPES.map((s) => s.tab), active: SCOPES.findIndex((s) => s.scope === scope) },
    multi: true,
    enterTicks: true,
    categories: model.categories(),
    items: model.items(draft),
    actions: [
      ...(file.isProject ? [] : [{ key: 'c', label: 'your own programs' }]),
      { key: 'r', label: 'request an app' },
    ],
  };
}

export class AppsPage extends ListPage<string> {
  readonly label = 'Apps';
  override readonly stages = true;
  private scope: Scope = 'user';

  constructor(
    app: App,
    private readonly files: Record<Scope, ConfigFile>,
    private readonly draft: Draft,
    private readonly dataPath: string,
  ) {
    super(app);
  }

  private get file(): ConfigFile {
    return this.files[this.scope];
  }
  private get model(): AppsModel {
    return new AppsModel(this.file, this.dataPath);
  }

  protected load(): Promise<void> {
    return Promise.resolve();
  }

  protected options(): ListOptions<string> {
    return appsOptions(this.model, this.file, this.draft, this.scope);
  }

  /** Every tick is staged as it happens, so leaving or saving always sees it. */
  protected override afterKey(): Step<ShellExit> {
    this.model.stageTicks(this.draft, this.ticked());
    return;
  }

  /** Opens the GitHub request form in the browser and says where it is. */
  private request(): string {
    const url = requestAppUrl();
    try {
      openIssuePage(url);
      return Theme.ok(Theme.glyph.ok + ' Opened the request form in your browser: ') + Theme.muted(url);
    } catch (e) {
      return Theme.error(Theme.glyph.cross + ' ' + errMsg(e)) + Theme.muted('  Open it yourself: ' + url);
    }
  }

  protected async act(result: ListResult<string>): Promise<Outcome<string>> {
    this.model.stageTicks(this.draft, this.ticked());
    if (result.kind === 'tab') {
      this.scope = SCOPES[result.index].scope;
      return {};
    }
    if (result.kind === 'action' && result.key === 'r') return { notice: this.request() };
    if (result.kind !== 'action' || result.key !== 'c') return {};
    const node = this.file.schema.child('apps')?.child('custom');
    if (!node) return {};
    try {
      const edited = await new ValueEditor(this.app).edit(
        ['Apps', 'Your own programs'],
        ['apps', 'custom'],
        node,
        this.model.custom(this.draft),
      );
      if (edited) this.draft.stage(this.file, ['apps', 'custom'], edited.value);
    } catch (e) {
      return { notice: Theme.error(Theme.glyph.cross + ' ' + errMsg(e)) };
    }
    return {};
  }
}
