import type { ServerMessage } from '../../../src/shared/web/index';

/** A status message from the server, or null for anything that is not one. */
export function parseServerMessage(text: string): ServerMessage | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    switch (value.t) {
      case 'ready':
      case 'restarting':
        return { t: value.t };
      case 'exit':
        return typeof value.code === 'number' ? { t: 'exit', code: value.code } : null;
      case 'error':
        return typeof value.message === 'string' ? { t: 'error', message: value.message.slice(0, 500) } : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}
