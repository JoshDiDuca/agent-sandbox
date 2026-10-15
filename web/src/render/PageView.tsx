// A view's Page with Mantine: the notice as an alert, each section as a card (facts as label/value pairs, items as rows
// or as a table when the section has columns, its notes and actions), the empty state with its next step, and a
// search box on long pages. The same Page the menu and the CLI show.
import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Group,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useMemo, useState, type ReactNode } from 'react';
import { pageHasContent, type Fact, type Item, type Page, type Section } from '../../../src/app/kernel/index';
import { ActionButton, offered, useAct } from './actions';
import { toneColor } from './tones';

/** Pages with more items than this get a search box. */
const SEARCH_FROM = 20;

function Facts({ facts }: { readonly facts: readonly Fact[] }) {
  return (
    <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs" verticalSpacing={4}>
      {facts.map((f) => (
        <Group key={f.id} gap="xs" wrap="nowrap" title={f.description}>
          <Text size="sm" c="dimmed" w={130} style={{ flex: 'none' }}>
            {f.label}
          </Text>
          <Text size="sm" c={toneColor(f.tone)} style={{ wordBreak: 'break-word' }}>
            {f.value}
          </Text>
        </Group>
      ))}
    </SimpleGrid>
  );
}

function ItemRow({ item }: { readonly item: Item }) {
  const act = useAct();
  const primary = offered(item.primary) && !item.disabled ? item.primary : undefined;
  return (
    <Box py={6} style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
      <Group justify="space-between" wrap="nowrap" align="flex-start" gap="sm">
        <Box style={{ minWidth: 0 }}>
          <Group gap={6}>
            <Text fw={500} size="sm" c={toneColor(item.tone)}>
              {item.marked ? '* ' : ''}
              {item.label}
            </Text>
            {item.badges?.map((b) => (
              <Badge key={b.text} size="xs" variant="light" color={toneColor(b.tone) ?? 'gray'}>
                {b.text}
              </Badge>
            ))}
          </Group>
          {item.hint && (
            <Text size="sm" c="dimmed" style={{ wordBreak: 'break-word' }}>
              {item.hint}
            </Text>
          )}
          {item.description && <Text size="xs">{item.description}</Text>}
          {item.details?.map((d, i) => (
            <Text key={i} size="xs" c="dimmed" ff="monospace" style={{ wordBreak: 'break-word' }}>
              {d}
            </Text>
          ))}
          {item.disabled && (
            <Text size="xs" c="dimmed" fs="italic">
              {item.disabled}
            </Text>
          )}
        </Box>
        <Group gap={6} wrap="nowrap" style={{ flex: 'none' }}>
          {primary && (
            <Button size="xs" onClick={() => void act(primary)}>
              {primary.label}
            </Button>
          )}
          {item.actions?.map((a, i) => (
            <ActionButton key={i} action={a} />
          ))}
        </Group>
      </Group>
    </Box>
  );
}

function ItemsTable({ section }: { readonly section: Section }) {
  const act = useAct();
  const columns = section.columns ?? [];
  return (
    <Table.ScrollContainer minWidth={560}>
      <Table highlightOnHover verticalSpacing={4} fz="sm">
        <Table.Thead>
          <Table.Tr>
            {columns.map((c) => (
              <Table.Th key={c.key}>{c.label}</Table.Th>
            ))}
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(section.items ?? []).map((item) => {
            const primary = offered(item.primary) && !item.disabled ? item.primary : undefined;
            return (
              <Table.Tr key={item.id} c={item.disabled ? 'dimmed' : undefined}>
                {columns.map((c) => (
                  <Table.Td key={c.key}>{item.cells?.[c.key] ?? ''}</Table.Td>
                ))}
                <Table.Td>
                  {primary && (
                    <Button size="compact-xs" onClick={() => void act(primary)}>
                      {primary.label}
                    </Button>
                  )}
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

/** Items under their group headings ("This folder's project"). */
function ItemList({ items }: { readonly items: readonly Item[] }) {
  const out: ReactNode[] = [];
  let group: string | undefined;
  for (const item of items) {
    if (item.group && item.group !== group)
      out.push(
        <Text key={'g:' + item.group} size="xs" fw={700} tt="uppercase" c="dimmed" mt="xs">
          {item.group}
        </Text>,
      );
    group = item.group;
    out.push(<ItemRow key={item.id} item={item} />);
  }
  return <Box>{out}</Box>;
}

function SectionCard({ section }: { readonly section: Section }) {
  const notes = (section.notes ?? []).filter((n) => n.only === undefined || n.only === 'web');
  const actions = (section.actions ?? []).filter(offered);
  const items = section.items ?? [];
  if (!section.facts?.length && !items.length && !actions.length && !section.summary) return null;
  return (
    <Card withBorder padding="md" radius="md">
      <Stack gap="xs">
        {(section.title || section.summary) && (
          <Group gap="xs" align="baseline">
            {section.title && <Title order={4}>{section.title}</Title>}
            {section.summary && (
              <Text size="sm" c="dimmed">
                {section.summary}
              </Text>
            )}
          </Group>
        )}
        {section.description && (
          <Text size="sm" c="dimmed">
            {section.description}
          </Text>
        )}
        {section.facts?.length ? <Facts facts={section.facts} /> : null}
        {items.length ? (
          section.columns && section.columnsOn !== 'cli' ? (
            <ItemsTable section={section} />
          ) : (
            <ItemList items={items} />
          )
        ) : null}
        {notes.map((n, i) => (
          <Text key={i} size="xs" c={toneColor(n.tone) ?? 'dimmed'}>
            {n.text}
          </Text>
        ))}
        {actions.length > 0 && (
          <Group gap="xs">
            {actions.map((a, i) => (
              <ActionButton key={i} action={a} />
            ))}
          </Group>
        )}
      </Stack>
    </Card>
  );
}

/** The page with only the items whose words contain `text` (sections without a match are left out). */
function filtered(page: Page, text: string): Page {
  const words = text.trim().toLowerCase();
  if (!words) return page;
  const hit = (i: Item): boolean =>
    [i.label, i.hint, i.description, i.keywords, i.group].some((w) => w?.toLowerCase().includes(words));
  return {
    ...page,
    sections: page.sections
      .map((s) => ({ ...s, facts: [], actions: [], items: (s.items ?? []).filter(hit) }))
      .filter((s) => s.items.length > 0),
  };
}

export function PageView({ page, toolbar }: { readonly page: Page; readonly toolbar?: ReactNode }) {
  const act = useAct();
  const [search, setSearch] = useState('');
  const count = useMemo(() => page.sections.reduce((n, s) => n + (s.items?.length ?? 0), 0), [page]);
  const shown = useMemo(() => filtered(page, search), [page, search]);
  const actions = (page.actions ?? []).filter(offered);
  const empty = page.empty;
  const emptyAction = offered(empty?.action) ? empty?.action : undefined;
  return (
    <Stack gap="md">
      <Group justify="space-between" gap="xs">
        <Title order={2}>{page.title}</Title>
        <Group gap="xs">
          {toolbar}
          {actions.map((a, i) => (
            <ActionButton key={i} action={a} />
          ))}
        </Group>
      </Group>
      {page.notice && (
        <Alert color={toneColor(page.notice.tone) ?? 'blue'} variant="light" p="xs">
          {page.notice.text}
        </Alert>
      )}
      {count > SEARCH_FROM && (
        <TextInput
          placeholder="Search"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          aria-label="Search this page"
        />
      )}
      {!pageHasContent(page) && empty ? (
        <Card withBorder padding="lg" radius="md">
          <Stack gap="sm" align="flex-start">
            {empty.title && <Title order={4}>{empty.title}</Title>}
            <Text size="sm">{empty.text}</Text>
            {emptyAction && <Button onClick={() => void act(emptyAction)}>{emptyAction.label}</Button>}
          </Stack>
        </Card>
      ) : (
        shown.sections.map((s) => <SectionCard key={s.id} section={s} />)
      )}
    </Stack>
  );
}
