// Which engine the settings ask for, and what every engine can do (for sandbox engine).
import type { Config } from '../../core/types.js';
import { fail } from '../../core/util/index.js';
import type { SandboxEngine } from './engine.js';
import { checkHcs, realHcsProbes, type HcsProbes } from './hcs/check.js';
import { HCS_CAPABILITIES, HcsEngine } from './hcs/engine.js';
import type { EngineCapabilities, EngineCheck, EngineId } from './types.js';
import { WindowsSandboxEngine } from './windows-sandbox/engine.js';

/** The engine for the settings when nothing is looked up first (Windows Sandbox); hcs is opened with openEngine. */
export function engineFor(config: Config): SandboxEngine {
  if (config.sandbox.engine === 'hcs')
    fail('The HCS engine has to be opened first (its check looks at this PC).', 'Run: sandbox engine check hcs');
  return new WindowsSandboxEngine(config.sandbox);
}

/** The engine to launch with. HCS is returned only when its check passes; otherwise this stops with the reasons. */
export async function openEngine(config: Config, hcsProbes?: HcsProbes): Promise<SandboxEngine> {
  if (config.sandbox.engine === 'hcs') return HcsEngine.open(config.storage.root, hcsProbes);
  return engineFor(config);
}

export interface EngineReport {
  readonly id: EngineId;
  readonly inUse: boolean;
  readonly capabilities: EngineCapabilities;
  readonly check: EngineCheck;
}

/** Every engine with its capabilities and whether it can be used on this PC. */
export async function engineReports(config: Config, hcsProbes: HcsProbes = realHcsProbes()): Promise<EngineReport[]> {
  const windows = new WindowsSandboxEngine(config.sandbox);
  const inUse = config.sandbox.engine;
  return [
    {
      id: 'windows-sandbox',
      inUse: inUse === 'windows-sandbox',
      capabilities: windows.capabilities(),
      check: await windows.check(),
    },
    { id: 'hcs', inUse: inUse === 'hcs', capabilities: HCS_CAPABILITIES, check: checkHcs(hcsProbes) },
  ];
}
