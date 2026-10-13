// Measuring and laying out terminal text that may hold colour codes: visible width, padding, cutting and wrapping.
// Pure (tested), so every screen lines up the same way.

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export class Text {
  /** Removes colour and cursor codes. */
  static strip(text: string): string {
    return text.replace(ANSI, '');
  }

  /** Columns one character takes: 2 for East Asian wide characters and most emoji, 0 for combining marks. */
  static charWidth(code: number): number {
    if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
    if ((code >= 0x300 && code <= 0x36f) || (code >= 0x200b && code <= 0x200f) || code === 0xfe0f) return 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd);
    return wide ? 2 : 1;
  }

  /** Columns `text` takes on screen. */
  static width(text: string): number {
    let width = 0;
    for (const ch of Text.strip(text)) width += Text.charWidth(ch.codePointAt(0)!);
    return width;
  }

  /**
   * The first `max` columns of `text`, keeping colour codes (and closing them), with an ellipsis when something was cut.
   */
  static truncate(text: string, max: number, ellipsis = '…'): string {
    if (max <= 0) return '';
    if (Text.width(text) <= max) return text;
    const room = max - Text.width(ellipsis);
    let out = '';
    let used = 0;
    let coloured = false;
    for (let i = 0; i < text.length;) {
      const code = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(text.slice(i));
      if (code) {
        out += code[0];
        coloured = code[0] !== '\x1b[0m';
        i += code[0].length;
        continue;
      }
      const ch = String.fromCodePoint(text.codePointAt(i)!);
      const w = Text.charWidth(ch.codePointAt(0)!);
      if (used + w > room) break;
      out += ch;
      used += w;
      i += ch.length;
    }
    return out + (coloured ? '\x1b[0m' : '') + ellipsis;
  }

  /** `text` cut or padded with spaces to exactly `width` columns. */
  static fit(text: string, width: number, align: 'left' | 'right' = 'left'): string {
    const cut = Text.truncate(text, width);
    const gap = ' '.repeat(Math.max(0, width - Text.width(cut)));
    return align === 'left' ? cut + gap : gap + cut;
  }

  /** Cuts the middle out of a long path so both ends stay readable (plain text). */
  static middle(text: string, max: number): string {
    if (max < 5 || text.length <= max) return text;
    const keep = max - 1;
    const head = Math.ceil(keep / 2);
    return text.slice(0, head) + '…' + text.slice(text.length - (keep - head));
  }

  /** Word-wraps plain text to `width` columns (long words are split); keeps the text's own line breaks. */
  static wrap(text: string, width: number): string[] {
    const lines: string[] = [];
    for (const paragraph of text.split(/\r?\n/)) {
      let line = '';
      for (const word of paragraph.split(/ +/)) {
        let rest = word;
        while (Text.width(rest) > width) {
          if (line) {
            lines.push(line);
            line = '';
          }
          lines.push(rest.slice(0, width));
          rest = rest.slice(width);
        }
        if (!line) line = rest;
        else if (Text.width(line) + 1 + Text.width(rest) <= width) line += ' ' + rest;
        else {
          lines.push(line);
          line = rest;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  /** "memoryMb" -> "Memory MB", "vGpu" -> "V GPU": a readable label from a setting's key. */
  static humanize(key: string): string {
    const words = key
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .split(' ')
      .filter(Boolean);
    const upper = new Set([
      'mb',
      'gb',
      'cpu',
      'gpu',
      'jdk',
      'sdk',
      'id',
      'url',
      'ui',
      'npm',
      'msvc',
      'uv',
      'api',
      'ssh',
      'vm',
      'io',
    ]);
    return words
      .map((w, i) =>
        upper.has(w.toLowerCase()) ? w.toUpperCase() : i === 0 ? w[0].toUpperCase() + w.slice(1) : w.toLowerCase(),
      )
      .join(' ');
  }
}
