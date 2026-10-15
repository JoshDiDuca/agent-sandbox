// The web UI settings (sandbox web): not part of LocalOverrides, a repo never turns a way into your agents on.
import { z } from 'zod';

export const WEB_DEFAULT_PORT = 47800;

export const WebSchema = z.strictObject({
  enabled: z
    .boolean()
    .describe(
      '(Beta) Allow the web UI: your sandbox sessions in a browser on this PC. Off by default, and nothing starts it by itself yet: sandbox web start works either way and runs it until sandbox web stop (or a restart of the PC).',
    ),
  port: z
    .number()
    .int()
    .min(1024)
    .max(65535)
    .describe('Port of the web UI on 127.0.0.1 (this PC only). Pick another when it is taken.'),
});
