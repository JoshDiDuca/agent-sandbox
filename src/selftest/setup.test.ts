// `agent-sandbox setup`: the pure pieces of the machine checklist.
import { buildChecks, canEnableFeature, editionSupport, featureFromInstallState, nodeMajor, parseDismState, parseProbe, parseRegQuery, type MachineFacts } from '../cli/commands/setup.js';
import type { Harness } from './harness.js';

export const setupTests = (t: Harness): void => {
  const { check } = t;
  t.section('setup checklist');
  const reg = parseRegQuery('\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\r\n    CurrentBuild    REG_SZ    22631\r\n    EditionID    REG_SZ    Professional\r\n    ProductName    REG_SZ    Windows 10 Pro\r\n    InstallDate    REG_DWORD    0x65a1b2c3\r\n');
  check(reg.EditionID === 'Professional' && reg.CurrentBuild === '22631' && reg.ProductName === 'Windows 10 Pro', 'reg query output parses into name/value pairs');
  check(editionSupport('Professional') === 'supported' && editionSupport('EnterpriseS') === 'supported' && editionSupport('EducationN') === 'supported' && editionSupport('Core') === 'home' && editionSupport('CoreSingleLanguage') === 'home' && editionSupport('ServerStandard') === 'unsupported' && editionSupport('Weird') === 'unknown' && editionSupport(null) === 'unknown', 'editions: Pro/Enterprise/Education yes, Home and Server no');
  const dism = (state: string): string => 'Deployment Image Servicing and Management tool\r\n\r\nFeature Name : Containers-DisposableClientVM\r\nDisplay Name : Windows Sandbox\r\nRestart Required : Possible\r\nState : ' + state + '\r\n';
  check(parseDismState(dism('Enabled')) === 'enabled' && parseDismState(dism('Enable Pending')) === 'pending' && parseDismState(dism('Disabled')) === 'disabled' && parseDismState(dism('Disabled with Payload Removed')) === 'disabled' && parseDismState('Error: 740\r\nElevated permissions are required') === 'unknown', 'DISM feature state: enabled, pending restart, disabled; errors are unknown');
  check(featureFromInstallState(1) === 'enabled' && featureFromInstallState(2) === 'disabled' && featureFromInstallState(null) === 'unknown', 'Win32_OptionalFeature install state maps to the feature state');
  check(parseProbe('WARNING: x\r\n{"virtualizationFirmware":false,"hypervisorPresent":true,"installState":1}\r\n').hypervisorPresent === true && Object.keys(parseProbe('not json')).length === 0 && Object.keys(parseProbe('{"installState":"1"}')).length === 0, 'PowerShell probe: last line is validated JSON; anything else is ignored');
  check(nodeMajor('v22.11.0') === 22 && nodeMajor('18.0.0') === 18 && nodeMajor('') === 0, 'Node major version');

  const GB = 1024 ** 3;
  const good: MachineFacts = { edition: 'Professional', build: 22631, feature: 'enabled', sandboxExe: true, virtualizationFirmware: false, hypervisorPresent: true, totalRamBytes: 16 * GB, freeDiskBytes: 100 * GB, storageRoot: 'C:\\store', nodeVersion: 'v22.11.0' };
  const status = (f: Partial<MachineFacts>): Record<string, string> => Object.fromEntries(buildChecks({ ...good, ...f }).map((c) => [c.name, c.status]));
  check(buildChecks(good).every((c) => c.status === 'ok'), 'a ready PC is all OK (a running hypervisor counts as virtualization on)');
  check(status({ edition: 'Core' })['Windows edition'] === 'action' && status({ build: 17763 })['Windows edition'] === 'action' && status({ edition: 'Weird' })['Windows edition'] === 'warn', 'Home and old builds need action; unknown editions warn');
  check(status({ hypervisorPresent: false })['CPU virtualization'] === 'action' && status({ hypervisorPresent: null, virtualizationFirmware: null })['CPU virtualization'] === 'warn' && status({ hypervisorPresent: false, virtualizationFirmware: true })['CPU virtualization'] === 'ok', 'virtualization: off needs action, unknown warns');
  check(status({ feature: 'disabled', sandboxExe: false })['Windows Sandbox feature'] === 'action' && buildChecks({ ...good, feature: 'pending', sandboxExe: false })[2].detail.includes('restart') && buildChecks({ ...good, feature: 'enabled', sandboxExe: false })[2].detail.includes('restart'), 'feature: off or waiting for a restart needs action');
  check(status({ totalRamBytes: 6 * GB }).Memory === 'warn' && status({ totalRamBytes: 3 * GB }).Memory === 'action' && status({ freeDiskBytes: 10 * GB })['Free disk'] === 'warn' && status({ freeDiskBytes: 2 * GB })['Free disk'] === 'action' && status({ freeDiskBytes: null })['Free disk'] === 'warn' && status({ nodeVersion: 'v18.20.0' })['Node.js'] === 'action', 'RAM under 8 GB warns, disk and Node limits');
  check(canEnableFeature({ ...good, feature: 'disabled', sandboxExe: false }) && !canEnableFeature({ ...good, edition: 'Core', feature: 'disabled', sandboxExe: false }) && !canEnableFeature({ ...good, feature: 'pending', sandboxExe: false }) && !canEnableFeature(good), 'offers to enable the feature only when it is off on an edition that has it');
};
