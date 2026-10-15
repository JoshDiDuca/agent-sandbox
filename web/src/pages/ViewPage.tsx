// A page that is a view: its queries read over RPC (live ones kept fresh), its Page built in the browser by the view's
// own pure build() and drawn by PageView. A view with tabs (Settings: all projects / this project) gets them above it.
import { Alert, Loader, SegmentedControl } from '@mantine/core';
import { viewById } from '../../../src/app/features/defs';
import { viewInputs, type AnyView } from '../../../src/app/kernel/index';
import { PageView } from '../render/PageView';
import { useQueryData } from '../rpc/hooks';
import { navigate, viewPath } from '../router';

interface ViewPageProps {
  readonly view: string;
  readonly params: Readonly<Record<string, string>>;
}

/** The view's parameters: the tab chosen (or its first), from the address. */
function paramsOf(view: AnyView, given: Readonly<Record<string, string>>): Record<string, string> {
  const tabs = view.tabs;
  if (!tabs) return {};
  const chosen = given[tabs.param];
  return { [tabs.param]: tabs.choices.some((c) => c.value === chosen) ? chosen : tabs.choices[0].value };
}

function LoadedView({ view, params }: { readonly view: AnyView; readonly params: Record<string, string> }) {
  const inputs = viewInputs(view, params as never) as Record<string, unknown>;
  const names = Object.keys(view.queries);
  // The same queries on every render of one view (the page is keyed by the view and its parameters).
  const results = names.map((name) => [name, useQueryData(view.queries[name], inputs[name])] as const);
  const failed = results.find(([, r]) => r.error);
  if (failed) {
    const error = failed[1].error as Error & { fix?: string };
    return (
      <Alert color="red" title={error.message}>
        {error.fix ?? 'Try again in a moment.'}
      </Alert>
    );
  }
  if (results.some(([, r]) => r.pending)) return <Loader />;
  const page = view.build(Object.fromEntries(results.map(([name, r]) => [name, r.data])) as never, params as never);
  const tabs = view.tabs;
  const toolbar = tabs ? (
    <SegmentedControl
      size="xs"
      data={tabs.choices.map((c) => ({ value: c.value, label: c.label }))}
      value={params[tabs.param]}
      onChange={(value) => navigate(viewPath(view.id, { [tabs.param]: value }))}
    />
  ) : undefined;
  return <PageView page={page} toolbar={toolbar} />;
}

export function ViewPage({ view: id, params }: ViewPageProps) {
  const view = viewById(id);
  if (!view) return <Alert color="orange">There is no page called {id}.</Alert>;
  const p = paramsOf(view, params);
  return <LoadedView key={id + JSON.stringify(p)} view={view} params={p} />;
}
