import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { SYSTEM } from '../../shared/system.js';
import { isWin } from '../../core/util/index.js';
import { refuseInSelfTest } from '../test-guard.js';
import { Iso } from './life-record.js';

// ---- Windows' System log ----------------------------------------------------------------------------------------

export interface StopEvent {
  at: string;
  id: number;
  provider: string;
  process: string;
}
const StopEvents = z
  .array(
    z.object({
      at: Iso,
      id: z.number().int(),
      provider: z.string().max(200),
      process: z
        .string()
        .max(400)
        .nullable()
        .transform((p) => p ?? ''),
    }),
  )
  .max(100);

export type StopKind = 'updates' | 'restart' | 'crash' | 'sleep' | 'memory' | 'sandboxCrash';
export interface StopCause {
  kind: StopKind;
  at: string;
  text: string;
}

const UPDATERS =
  /^(trustedinstaller|mousocoreworker|musnotification(ux)?|usoclient|wuauclt|tiworker|updateorchestrator)\.exe$/i;

/**
 * The first event that ends a running sandbox (pure): Windows inside the sandbox crashing (Hyper-V 18590; `process`
 * holds its message with the stop code), a restart or shutdown, a crash or power loss, sleep, low memory. Switching
 * user does not end it (seen on 13 Oct 2026: the sandbox ran on after a switch).
 */
export const explainStop = (events: StopEvent[]): StopCause | null => {
  const causes = events.flatMap((e): StopCause[] => {
    const p = e.provider.toLowerCase();
    if (e.id === 1074 && p.includes('user32')) {
      const exe =
        e.process
          .split(/[\\/]/)
          .pop()
          ?.replace(/\s*\(.*$/, '') ?? '';
      return UPDATERS.test(exe)
        ? [{ kind: 'updates', at: e.at, text: 'Windows restarted this PC to install updates' }]
        : [
            {
              kind: 'restart',
              at: e.at,
              text: 'this PC was restarted or shut down' + (exe ? ' (by ' + exe + ')' : ''),
            },
          ];
    }
    if ((e.id === 41 && p.includes('kernel-power')) || (e.id === 6008 && p.includes('eventlog')))
      return [
        {
          kind: 'crash',
          at: e.at,
          text: 'Windows stopped unexpectedly (a crash, a power cut, or the power button held down)',
        },
      ];
    if (e.id === 42 && p.includes('kernel-power'))
      return [{ kind: 'sleep', at: e.at, text: 'this PC went to sleep or hibernated' }];
    if (e.id === 2004 && p.includes('resource-exhaustion'))
      return [{ kind: 'memory', at: e.at, text: 'this PC ran out of memory' }];
    if (e.id === 18590 && p.includes('hyper-v-worker')) {
      const code = /ErrorCode0:\s*(0x[0-9a-f]{1,8})/i.exec(e.process)?.[1];
      const sub = /ErrorCode1:\s*(0x[0-9a-f]{1,16})/i.exec(e.process)?.[1];
      return [
        {
          kind: 'sandboxCrash',
          at: e.at,
          text:
            'Windows inside the sandbox crashed' + (code ? ' (stop code ' + code + (sub ? ', ' + sub : '') + ')' : ''),
        },
      ];
    }
    return [];
  });
  return causes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0] ?? null;
};

/** System log and Hyper-V events since `since` that can end a sandbox (Windows only; empty when the logs cannot be read). */
export const readStopEvents = (since: Date): StopEvent[] => {
  if (!isWin) return [];
  refuseInSelfTest('read the Windows event log');
  const script =
    "$ErrorActionPreference='SilentlyContinue'; $t=[datetime]::Parse('" +
    since.toISOString() +
    "').ToLocalTime(); $e = Get-WinEvent -FilterHashtable @(@{LogName='System'; Id=1074,6008,41,42,2004; StartTime=$t}, @{LogName='Microsoft-Windows-Hyper-V-Worker-Admin'; Id=18590; StartTime=$t}) -MaxEvents 100 | ForEach-Object { [pscustomobject]@{ at=$_.TimeCreated.ToUniversalTime().ToString('o'); id=$_.Id; provider=$_.ProviderName; process=$(if ($_.Id -eq 1074) { [string]$_.Properties[0].Value } elseif ($_.Id -eq 18590) { ([string]$_.Message).Substring(0, [math]::Min(390, ([string]$_.Message).Length)) } else { '' }) } }; ConvertTo-Json -Compress -InputObject @($e)";
  const result = spawnSync(
    SYSTEM.powershell(),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 },
  );
  try {
    return StopEvents.parse(JSON.parse(result.stdout || '[]'));
  } catch {
    return [];
  }
};

/** Looking back from the last time the sandbox was seen running (a minute between checks, plus margin). */
export const causeSince = (lastSeen: string): StopCause | null =>
  explainStop(readStopEvents(new Date(Date.parse(lastSeen) - 2 * 60 * 1000)));
