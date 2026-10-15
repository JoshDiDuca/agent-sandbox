// Working with a running sandbox: attach and exec. Each knows which project you run it from (projects/here.ts): attach
// puts that project's sessions first, exec and db run in it. Status, sessions, restart, stop and show/hide are the
// shared core's (src/app/features/sandbox and sessions).
export * from './attach.js';
export * from './exec.js';
