// Reading Windows process-creation events (Security log, 4688, as wevtutil prints them) into audit lines. Pure, so
// the self-test can check it on the PC side.
import path from 'node:path';

/** Background programs of Windows itself: never what an agent ran. */
export const NOISE = new Set(['conhost.exe', 'svchost.exe', 'backgroundtaskhost.exe', 'runtimebroker.exe', 'wmiprvse.exe', 'dllhost.exe', 'searchprotocolhost.exe', 'searchfilterhost.exe', 'taskhostw.exe', 'sppsvc.exe', 'wermgr.exe', 'consent.exe', 'smartscreen.exe', 'mpcmdrun.exe', 'compattelrunner.exe', 'wevtutil.exe', 'audiodg.exe', 'ctfmon.exe', 'sihost.exe', 'werfault.exe', 'msmpeng.exe', 'nissrv.exe', 'usoclient.exe', 'musnotification.exe']);

const decode = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const field = (event: string, name: string): string => decode(new RegExp("<Data Name='" + name + "'>([^<]*)</Data>").exec(event)?.[1] ?? '');

/** The events in wevtutil's XML output as audit lines, with the newest record id seen. */
export const parseProcessEvents = (xml: string): { lines: string[]; last: number } => {
  const lines: string[] = [];
  let last = 0;
  for (const event of xml.split('</Event>')) {
    const id = Number(/<EventRecordID>(\d+)<\/EventRecordID>/.exec(event)?.[1] ?? 0);
    if (!id) continue;
    last = Math.max(last, id);
    const program = field(event, 'NewProcessName');
    if (!program || NOISE.has(path.win32.basename(program).toLowerCase())) continue;
    const t = /SystemTime='([^']+)'/.exec(event)?.[1] ?? new Date().toISOString();
    lines.push(JSON.stringify({ t, k: 'proc', p: program.slice(0, 1024), c: field(event, 'CommandLine').slice(0, 2000), pp: field(event, 'ParentProcessName').slice(0, 1024) }));
  }
  return { lines, last };
};
