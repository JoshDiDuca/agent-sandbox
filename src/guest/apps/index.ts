// Installs the apps you chose (apps.install from the catalogue, apps.custom of your own) into C:\AgentData\tools\apps,
// once each: later sandboxes find them there. Programs get a desktop and Start menu shortcut; command-line tools go on
// PATH. Installers are never run: archives are unpacked, NSIS installers opened with 7-Zip and MSIs extracted
// (msiexec /a), so nothing is registered and nothing is lost when the sandbox closes. One app failing never stops the
// others.

export { appsNeedMesa } from '../../shared/apps/index.js';
export * from './installer.js';
export * from './find-exe.js';
