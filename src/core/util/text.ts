export const xmlEscape = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/**
 * Text that came from the sandbox, made safe to print: control characters and escape sequences are removed except
 * plain colours (SGR), so nothing written by the sandbox can drive your terminal (titles, clipboard, cursor tricks).
 */
export const safeText = (text: string): string =>
  text.replace(
    /\x1b\[[0-9;]*m|\x1b(\[[0-9;?]*[ -\/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[@-Z\\-_])|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
    (m) => (/^\x1b\[[0-9;]*m$/.test(m) ? m : ''),
  );

/** safeText without colours either: for text you are asked to approve, which must not be able to hide parts of itself. */
export const plainText = (text: string): string => safeText(text).replace(/\x1b\[[0-9;]*m/g, '');
