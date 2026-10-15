// The app's frame: a header, and the navigation down the left with the menu's sections in the menu's order (a section
// that is not in the web UI yet says where it is). On a phone the navigation folds behind the burger.
import { AppShell, Burger, Group, NavLink, Text, Tooltip } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconApps,
  IconBox,
  IconRobot,
  IconSettings,
  IconTerminal2,
  IconTool,
  IconUsers,
  type Icon,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { NAV } from '../../../src/app/features/defs';
import { navigate, viewPath } from '../router';

const ICONS: Readonly<Record<string, Icon>> = {
  Agents: IconRobot,
  Sessions: IconTerminal2,
  Sandbox: IconBox,
  Apps: IconApps,
  Settings: IconSettings,
  Accounts: IconUsers,
  Maintenance: IconTool,
};

interface ShellProps {
  /** The view shown (its section is highlighted). */
  readonly active?: string;
  /** The page fills the whole area (the terminal). */
  readonly bare?: boolean;
  readonly children: ReactNode;
}

export function Shell({ active, bare = false, children }: ShellProps) {
  const [opened, { toggle, close }] = useDisclosure(false);
  return (
    <AppShell
      header={{ height: 48 }}
      navbar={{ width: 220, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding={bare ? 0 : 'md'}
    >
      <AppShell.Header>
        <Group h="100%" px="md" gap="sm">
          <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Navigation" />
          <Text fw={700}>Sandbox</Text>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs" aria-label="Main">
        {NAV.map((section) => {
          const SectionIcon = ICONS[section.label] ?? IconBox;
          const link = (
            <NavLink
              key={section.label}
              label={section.label}
              leftSection={<SectionIcon size={18} stroke={1.6} />}
              active={section.view !== undefined && section.view === active}
              disabled={!section.view}
              href={section.view ? viewPath(section.view) : undefined}
              onClick={(e) => {
                e.preventDefault();
                if (!section.view) return;
                close();
                navigate(viewPath(section.view));
              }}
            />
          );
          return section.view ? (
            link
          ) : (
            <Tooltip key={section.label} label={section.elsewhere} position="right" multiline w={240}>
              <div>{link}</div>
            </Tooltip>
          );
        })}
      </AppShell.Navbar>
      <AppShell.Main style={bare ? { display: 'flex', height: '100dvh' } : undefined}>{children}</AppShell.Main>
    </AppShell>
  );
}
