// A value in one short line for the menu's right-hand column: the kernel's valueText, painted with the theme.
import { valueText } from '../../../app/kernel/index.js';
import { Theme } from '../../tui/index.js';

export { choiceLabel, summary } from '../../../app/kernel/index.js';

/** A value in one short line, for the right-hand column. */
export function formatValue(value: unknown, max = 60): string {
  const shown = valueText(value, undefined, max);
  return shown.tone === 'ok' ? Theme.ok(shown.text) : shown.tone === 'muted' ? Theme.muted(shown.text) : shown.text;
}
