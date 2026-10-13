import fs from 'node:fs';
import path from 'node:path';
import { downloader, extractArchive, fetchJson, moveIntoPlace, stagingFolder } from '../../shared/download/index.js';
import { safeRemove } from '../../shared/io/index.js';
import { assertTestWritable } from '../test-guard.js';
import { z } from 'zod';
import { assertNoLinks, errMsg, fileExists } from '../../core/util/index.js';

// ---- conpty.dll ------------------------------------------------------------------------------------------------------

/** Where the sandbox finds conpty.dll + OpenConsole.exe (guest/ptyhost.ts points ptyhost at it). */
export const conptyDir = (dataPath: string): string => path.join(dataPath, 'tools', 'conpty');
const NUGET_CONPTY = 'https://api.nuget.org/v3-flatcontainer/microsoft.windows.console.conpty/';
const NugetVersions = z.object({ versions: z.array(z.string()) });
const NugetLeaf = z.object({ catalogEntry: z.string().url() });
const NugetCatalog = z.object({ packageHash: z.string(), packageHashAlgorithm: z.literal('SHA512') });

/**
 * Microsoft's newer pseudo console (the Microsoft.Windows.Console.ConPTY package: conpty.dll and OpenConsole.exe, the
 * same one Windows Terminal and VS Code use), downloaded once and verified against the SHA-512 NuGet publishes. Agent
 * sessions use it instead of the one built into Windows, which re-renders the screen and garbles it after resizes.
 */
export const ensureConpty = async (dataPath: string, refresh: boolean): Promise<string> => {
  const dir = conptyDir(dataPath);
  assertTestWritable(dir);
  assertNoLinks(dataPath, dir);
  if (fileExists(path.join(dir, 'conpty.dll')) && fileExists(path.join(dir, 'OpenConsole.exe')) && !refresh)
    return 'cached';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const work = stagingFolder(dir);
  try {
    const version = NugetVersions.parse(await fetchJson(NUGET_CONPTY + 'index.json'))
      .versions.filter((v) => !v.includes('-'))
      .pop();
    if (!version) throw new Error('no release found');
    const leaf = NugetLeaf.parse(
      await fetchJson(
        'https://api.nuget.org/v3/registration5-gz-semver2/microsoft.windows.console.conpty/' + version + '.json',
      ),
    );
    const sha512 = Buffer.from(NugetCatalog.parse(await fetchJson(leaf.catalogEntry)).packageHash, 'base64').toString(
      'hex',
    );
    const pkg = path.join(work, 'conpty.nupkg');
    await downloader.file(NUGET_CONPTY + version + '/microsoft.windows.console.conpty.' + version + '.nupkg', pkg, {
      sha512,
    });
    const files = {
      'conpty.dll': 'runtimes/win-' + arch + '/native/conpty.dll',
      'OpenConsole.exe': 'build/native/runtimes/' + arch + '/OpenConsole.exe',
    };
    await extractArchive(pkg, path.join(work, 'x'), Object.values(files));
    fs.mkdirSync(path.join(work, 'out'));
    for (const [name, member] of Object.entries(files))
      fs.copyFileSync(path.join(work, 'x', ...member.split('/')), path.join(work, 'out', name));
    fs.writeFileSync(path.join(work, 'out', 'VERSION'), version);
    moveIntoPlace(path.join(work, 'out'), dir);
    return 'downloaded ' + version;
  } catch (e) {
    return "not downloaded, sessions use Windows' own pseudo console (" + errMsg(e) + ')';
  } finally {
    safeRemove(work, path.dirname(work));
  }
};
