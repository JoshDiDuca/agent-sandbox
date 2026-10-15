// The command line of the shared core: commands from definitions, their input, their terminal IO and their output.
export { definitionHandler, operationHandler } from './handler.js';
export { cliInput, definitionFor } from './input.js';
export { cliIO } from './io-cli.js';
export {
  actionDefinitions,
  commandDefinitions,
  commandSpecOf,
  inputField,
  withActions,
  withOperationCommands,
} from './spec.js';
