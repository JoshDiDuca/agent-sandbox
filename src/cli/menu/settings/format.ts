import _ from 'lodash';
import { Text, Theme } from '../../tui/index.js';

/** A value in one short line, for the right-hand column. */
export function formatValue(value: unknown, max = 60): string {
  if (value === undefined) return Theme.muted('not set');
  if (value === true) return Theme.ok('On');
  if (value === false) return Theme.muted('Off');
  if (value === null) return Theme.muted('none');
  if (typeof value === 'string') return value === '' ? Theme.muted('(empty)') : Text.truncate(value, max);
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value))
    return value.length === 0
      ? Theme.muted('none')
      : Text.truncate(
          value.length + ' · ' + value.map((v) => (typeof v === 'object' ? summary(v) : String(v))).join(', '),
          max,
        );
  const keys = Object.keys(value as object);
  return keys.length ? Text.truncate(keys.length + ' · ' + keys.join(', '), max) : Theme.muted('none');
}

/** A one-line name for an object in a list (a mapping's folders, an agent's package ...). */
export function summary(value: unknown): string {
  if (!_.isPlainObject(value)) return String(value);
  const o = value as Record<string, unknown>;
  const strings = Object.entries(o).filter(([, v]) => typeof v === 'string' && v) as [string, string][];
  if (typeof o.host === 'string' && typeof o.guest === 'string')
    return o.host + ' → ' + o.guest + (o.readOnly ? ' (read-only)' : '');
  return (
    strings
      .slice(0, 2)
      .map(([, v]) => v)
      .join(' · ') || '{ ' + Object.keys(o).join(', ') + ' }'
  );
}

export function choiceLabel(v: unknown): string {
  return v === true ? 'On' : v === false ? 'Off' : String(v);
}
