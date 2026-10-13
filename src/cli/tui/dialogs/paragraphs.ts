import { Text } from '../text.js';

/** Plain lines are wrapped to the width; coloured ones are kept as they are (the frame cuts them). */
export function paragraphs(lines: string[], width: number): string[] {
  return lines.flatMap((l) => (Text.strip(l) === l ? Text.wrap(l, width - 4) : [l]).map((x) => '  ' + x));
}
