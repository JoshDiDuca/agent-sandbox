// The kernel's one palette as Mantine colours (the TUI theme maps the same tones).
import type { MantineColor } from '@mantine/core';
import type { Tone } from '../../../src/app/kernel/index';

export const TONE_COLOR: Readonly<Record<Tone, MantineColor>> = {
  ok: 'green',
  warn: 'orange',
  danger: 'red',
  muted: 'gray',
  accent: 'blue',
};

/** The colour for a tone (undefined: the default text colour). */
export function toneColor(tone: Tone | undefined): MantineColor | undefined {
  return tone ? TONE_COLOR[tone] : undefined;
}
