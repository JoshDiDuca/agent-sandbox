// `sbx-db`: list, start and stop the sandbox's databases from a terminal inside it (`sandbox db` on the PC runs it too).
// Usage: sbx-db [list] | sbx-db start <name> | sbx-db stop <name>
import { errMsg } from '../../core/util/errors.js';
import { runSbxDb } from '../databases/sbx-db.js';

runSbxDb(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(errMsg(e));
    process.exitCode = 1;
  },
);
