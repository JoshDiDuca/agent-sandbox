// ANSI colours for terminal output (one place, so menus, errors and warnings agree).
const paint = (code: number) => (text: string): string => '\x1b[' + code + 'm' + text + '\x1b[0m';

export const c = { bold: paint(1), dim: paint(2), red: paint(31), green: paint(32), yellow: paint(33), cyan: paint(36) };
