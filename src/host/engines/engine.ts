// The interface an engine (Windows Sandbox, later HCS) implements.
import type { EngineCapabilities, EngineCheck, EngineId, EnginePlan, LaunchPlan, RunningSandbox } from './types.js';

export interface SandboxEngine {
  readonly id: EngineId;
  capabilities(): EngineCapabilities;
  check(): Promise<EngineCheck>;
  /** Pure: the engine's own files for this launch. */
  plan(launch: LaunchPlan): EnginePlan;
  /** Starts the sandbox from a plan whose files are written, and waits until it is up. */
  start(plan: EnginePlan): Promise<RunningSandbox>;
  running(): Promise<boolean>;
  stop(): Promise<void>;
}
