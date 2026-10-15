// A pretend PC for the HCS engine's check: every piece can be taken away. The probes only answer; calls are recorded so
// a test can see nothing but looking happened.
import type { HcsProbes, TokenGroups } from '../../host/engines/hcs/check.js';
import type { HcsImage } from '../../host/engines/hcs/documents.js';
import type { ImageStore } from '../../host/engines/hcs/images.js';

export const FAKE_IMAGE: HcsImage = {
  id: 'sha256:' + 'a'.repeat(64),
  layers: ['C:\\img\\base', 'C:\\img\\l2'],
  utilityVmFiles: 'C:\\img\\base\\UtilityVM\\Files',
};

export interface FakePc {
  windows: boolean;
  build: number | null;
  computecore: boolean;
  services: Record<string, boolean | null>;
  token: TokenGroups | null;
  image: HcsImage | null;
}

export const GOOD_PC: FakePc = {
  windows: true,
  build: 22621,
  computecore: true,
  services: { vmcompute: true, cexecsvc: true },
  token: { elevatedAdministrator: true, hyperVAdministrators: false },
  image: FAKE_IMAGE,
};

export function fakeProbes(pc: Partial<FakePc> = {}): HcsProbes & { readonly calls: string[] } {
  const p = { ...GOOD_PC, ...pc };
  const calls: string[] = [];
  const store: ImageStore = {
    name: 'fake store',
    find: () => {
      calls.push('imageStore.find');
      return { image: p.image, reason: p.image ? '' : 'The fake store has no image.' };
    },
  };
  return {
    calls,
    isWindows: () => p.windows,
    windowsBuild: () => p.build,
    serviceInstalled: (name) => {
      calls.push('serviceInstalled:' + name);
      return name in p.services ? p.services[name] : null;
    },
    fileExists: (file) => {
      calls.push('fileExists:' + file);
      return file.toLowerCase().endsWith('computecore.dll') ? p.computecore : false;
    },
    tokenGroups: () => p.token,
    imageStores: () => [store],
  };
}

/** A PC without the HCS pieces, for the tests that must not depend on the PC they run on. */
export const NO_HCS_PC: HcsProbes = fakeProbes({ computecore: false, services: { vmcompute: false, cexecsvc: false } });
