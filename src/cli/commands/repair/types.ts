// What a repair check is and returns.
import type { UserError } from '../../../core/util.js';
import type { Context } from '../context.js';

export type RepairStatus = 'ok' | 'fixed' | 'needs-you' | 'warn' | 'skipped';
export interface RepairResult { name: string; status: RepairStatus; detail: string }
export interface RepairEnv { ctx: Context; running: boolean; dataPath: string; storageRoot: string; toolsDir: string; configError: UserError | null }
export interface RepairCheck { name: string; run: (env: RepairEnv) => Omit<RepairResult, 'name'> }

export const ok = (detail: string): Omit<RepairResult, 'name'> => ({ status: 'ok', detail });
/** For fixes that must not touch folders a running sandbox may be using. */
export const whileRunning = { status: 'skipped' as const, detail: 'a sandbox is running and may be using it; run repair again once it is closed' };
