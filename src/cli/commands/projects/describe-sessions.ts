import path from 'node:path';
import type { SessionStatus } from '../../../core/types.js';
import { safeText } from '../../../core/util/index.js';

/** "2 sessions (claude in api, codex in web)". */
export function describeSessions(sessions: Pick<SessionStatus, 'harness' | 'cwd' | 'project'>[]): string {
  return sessions.length === 0
    ? 'no sessions'
    : sessions.length +
        ' session' +
        (sessions.length === 1 ? '' : 's') +
        ' (' +
        sessions
          .map((s) => safeText(s.harness) + ' in ' + safeText(s.project ?? path.win32.basename(s.cwd)))
          .join(', ') +
        ')';
}
