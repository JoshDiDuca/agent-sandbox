import fs from 'node:fs';
import { parse as parseJsoncText, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { fail } from './errors.js';

/**
 * Parses JSON with comments and trailing commas (JSONC, like VS Code's settings.json). Errors name the file, line
 * and column, and say what to fix.
 */
export function parseJsonc<T>(text: string, source: string): T {
  const errors: ParseError[] = [];
  const value = parseJsoncText(text.replace(/^\uFEFF/, ''), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length) {
    const { offset, error } = errors[0];
    const before = text.slice(0, offset).split(/\r?\n/);
    fail(
      source +
        ' is not valid JSON (line ' +
        before.length +
        ', column ' +
        (before[before.length - 1].length + 1) +
        ': ' +
        printParseErrorCode(error) +
        ').',
      'Fix that spot in the file. Comments (// and /* */) and trailing commas are fine.',
    );
  }
  return value as T;
}

export function readJsonc<T>(file: string): T {
  return parseJsonc<T>(fs.readFileSync(file, 'utf8'), file);
}
