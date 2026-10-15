// Every check, grouped as the output shows them (the engine sorts by group; inside a group this order is kept).
import type { Check } from '../types.js';
import { AGENT_CHECKS } from './agents.js';
import { DATA_CHECKS } from './data.js';
import { INSTALL_CHECKS } from './install.js';
import { MACHINE_CHECKS } from './machine.js';
import { NETWORK_CHECKS } from './network.js';
import { PC_CHECKS } from './pc.js';
import { SANDBOX_CHECKS } from './sandbox.js';
import { SETTINGS_CHECKS } from './settings.js';

export const ALL_CHECKS: readonly Check[] = [
  ...PC_CHECKS,
  ...INSTALL_CHECKS,
  ...MACHINE_CHECKS,
  ...DATA_CHECKS,
  ...SETTINGS_CHECKS,
  ...SANDBOX_CHECKS,
  ...AGENT_CHECKS,
  ...NETWORK_CHECKS,
];
