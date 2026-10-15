// `sbx-agent`: list agents and install a configured one inside the sandbox. Usage: sbx-agent list | install <agent>
import { dropInheritedModulePath } from '../../shared/system.js';
import { runSbxAgent } from '../agents/sbx-agent.js';

dropInheritedModulePath();
runSbxAgent(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  },
);
