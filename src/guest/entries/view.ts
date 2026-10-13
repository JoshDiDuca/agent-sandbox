// A terminal tab inside the sandbox that shows one agent session (same pseudo console the host can attach to).
// Usage: node view.js <sessionId>
import { viewSession } from '../sessions/viewer.js';

if (process.argv[1]?.endsWith('view.js') && process.argv[2]) {
  viewSession(process.argv[2]).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    },
  );
}
