// Command lines for the agent: Windows argument quoting, and the extra layer cmd.exe needs for npm agents (.cmd files).
import path from 'node:path';

const quoted = (arg: string): string => '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
export const quoteArg = (arg: string): string => (arg !== '' && !/[\s"]/.test(arg) ? arg : quoted(arg));

/**
 * Arguments on a `cmd /d /c <agent>.cmd ...` line (npm agents). cmd parses them twice: the /c line, then the .cmd's %*.
 * & | < > ^ are literal inside quotes, so arguments with them are quoted (https://x?a=1&b=2 survives). % expands even
 * inside quotes, so each one sits between quoted pieces ("50"%" off"): every %name% cmd could see then starts with a
 * quote, and no variable is called that. cmd's quote state runs across the whole line (an embedded \" toggles it too),
 * so a metacharacter it would see outside quotes gets ^^^ (one caret left after each parse). Arguments without any
 * of these are quoted as usual.
 */
export const cmdArgs = (args: string[]): string => {
  const pieces = args
    .map((arg) => (/[&|<>^%]/.test(arg) ? arg.split('%').map(quoted).join('%') : quoteArg(arg)))
    .join(' ');
  let inQuotes = false;
  return [...pieces]
    .map((c) => {
      if (c === '"') inQuotes = !inQuotes;
      return !inQuotes && /[&|<>^]/.test(c) ? '^^^' + c : c;
    })
    .join('');
};

/** The command line ptyhost starts; when the program is cmd.exe its arguments are quoted for cmd (cmdArgs). */
export const commandLine = (file: string, args: string[]): string =>
  path.win32.basename(file).toLowerCase() === 'cmd.exe'
    ? [quoteArg(file), cmdArgs(args)].filter(Boolean).join(' ')
    : [file, ...args].map(quoteArg).join(' ');
