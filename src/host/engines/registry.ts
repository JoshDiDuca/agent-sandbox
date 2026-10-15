// Which engine the settings ask for, and what every engine can do (for sandbox engine).
import type { Config } from '../../core/types.js';
import { fail } from '../../core/util/index.js';
import type { SandboxEngine } from './engine.js';
import type { EngineCapabilities, EngineCheck, EngineId } from './types.js';
import { WindowsSandboxEngine } from './windows-sandbox/engine.js';

/** What the HCS engine is meant to offer (docs/design/engines.md); it is not built yet. */
const HCS_PLANNED: EngineCapabilities = {
  desktop: false,
  gpu: false,
  clipboard: false,
  audio: false,
  video: false,
  printers: false,
  liveFolderAdd: false,
  attachedDisks: true,
  multipleInstances: true,
  hvsocket: true,
};

const HCS_NOT_BUILT: EngineCheck = {
  available: false,
  reasons: ['The HCS engine is not built yet (beta, coming in 1.9).'],
  fixes: ['Use "windows-sandbox" (the default) for sandbox.engine.'],
};

/** The engine to launch with. A setting that cannot work yet stops here, before anything is written. */
export function engineFor(config: Config): SandboxEngine {
  if (config.sandbox.engine === 'hcs')
    fail(
      'The HCS engine is not available yet (beta, coming in 1.9).',
      'Set sandbox.engine to "windows-sandbox" (the default) in your settings.',
    );
  return new WindowsSandboxEngine(config.sandbox);
}

export interface EngineReport {
  readonly id: EngineId;
  readonly inUse: boolean;
  readonly capabilities: EngineCapabilities;
  readonly check: EngineCheck;
}

/** Every engine with its capabilities and whether it can be used on this PC. */
export async function engineReports(config: Config): Promise<EngineReport[]> {
  const windows = new WindowsSandboxEngine(config.sandbox);
  const inUse = config.sandbox.engine;
  return [
    {
      id: 'windows-sandbox',
      inUse: inUse === 'windows-sandbox',
      capabilities: windows.capabilities(),
      check: await windows.check(),
    },
    { id: 'hcs', inUse: inUse === 'hcs', capabilities: HCS_PLANNED, check: HCS_NOT_BUILT },
  ];
}
