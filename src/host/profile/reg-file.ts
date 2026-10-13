// The .reg file format (as regedit imports it) for values captured from HKCU.

export interface RegValue {
  readonly key: string;
  readonly name: string;
  readonly kind: string;
  readonly value: string | number | string[];
}

function toHex(bytes: Buffer): string {
  return [...bytes].map((b: number) => b.toString(16).padStart(2, '0')).join(',');
}
function regString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** Formats captured values as a .reg file (UTF-16 friendly text; written as UTF-16LE with BOM). */
export function toRegFile(values: RegValue[]): string {
  const byKey = new Map<string, RegValue[]>();
  for (const v of values) byKey.set(v.key, [...(byKey.get(v.key) ?? []), v]);
  const lines = ['Windows Registry Editor Version 5.00', ''];
  for (const [key, list] of byKey) {
    lines.push('[HKEY_CURRENT_USER\\' + key + ']');
    for (const v of list) {
      const name = regString(v.name);
      switch (v.kind) {
        case 'DWord':
          lines.push(name + '=dword:' + (Number(v.value) >>> 0).toString(16).padStart(8, '0'));
          break;
        case 'QWord':
          lines.push(
            name +
              '=hex(b):' +
              toHex(
                Buffer.from(
                  BigInt.asUintN(64, BigInt(v.value as number))
                    .toString(16)
                    .padStart(16, '0'),
                  'hex',
                ).reverse(),
              ),
          );
          break;
        case 'Binary':
          lines.push(name + '=hex:' + toHex(Buffer.from(String(v.value), 'base64')));
          break;
        case 'ExpandString':
          lines.push(name + '=hex(2):' + toHex(Buffer.from(String(v.value) + '\0', 'utf16le')));
          break;
        case 'MultiString':
          lines.push(name + '=hex(7):' + toHex(Buffer.from((v.value as string[]).join('\0') + '\0\0', 'utf16le')));
          break;
        default:
          lines.push(name + '=' + regString(String(v.value)));
      }
    }
    lines.push('');
  }
  return lines.join('\r\n');
}
