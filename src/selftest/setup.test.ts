// `agent-sandbox setup`: the pure pieces of the machine checklist (parsing what Windows reports, judging each item).
import { buildChecks, canEnableFeature, editionSupport, nodeMajor } from '../cli/commands/setup/checks.js';
import { featureFromInstallState, parseDismState, parseProbe, parseRegQuery, type MachineFacts } from '../cli/commands/setup/facts.js';
import type { Suite } from './suite.js';

const GB = 1024 ** 3;

export const setupSuite: Suite = {
  name: 'setup',
  title: 'machine checklist for `sandbox setup`',
  run: (t) => {
    t.section('reading what Windows reports');
    const reg = parseRegQuery('\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\r\n    CurrentBuild    REG_SZ    22631\r\n    EditionID    REG_SZ    Professional\r\n    ProductName    REG_SZ    Windows 10 Pro\r\n    InstallDate    REG_DWORD    0x65a1b2c3\r\n');
    t.equal({ EditionID: reg.EditionID, CurrentBuild: reg.CurrentBuild, ProductName: reg.ProductName }, { EditionID: 'Professional', CurrentBuild: '22631', ProductName: 'Windows 10 Pro' }, 'reg query output parses into name/value pairs');
    t.equal(
      ['Professional', 'EnterpriseS', 'EducationN', 'Core', 'CoreSingleLanguage', 'ServerStandard', 'Weird', null].map(editionSupport),
      ['supported', 'supported', 'supported', 'home', 'home', 'unsupported', 'unknown', 'unknown'],
      'editions: Pro/Enterprise/Education yes, Home and Server no',
    );
    const dism = (state: string): string => 'Deployment Image Servicing and Management tool\r\n\r\nFeature Name : Containers-DisposableClientVM\r\nDisplay Name : Windows Sandbox\r\nRestart Required : Possible\r\nState : ' + state + '\r\n';
    t.equal(
      [parseDismState(dism('Enabled')), parseDismState(dism('Enable Pending')), parseDismState(dism('Disabled')), parseDismState(dism('Disabled with Payload Removed')), parseDismState('Error: 740\r\nElevated permissions are required')],
      ['enabled', 'pending', 'disabled', 'disabled', 'unknown'],
      'DISM feature state: enabled, pending restart, disabled; errors are unknown',
    );
    t.equal([featureFromInstallState(1), featureFromInstallState(2), featureFromInstallState(null)], ['enabled', 'disabled', 'unknown'], 'Win32_OptionalFeature install state maps to the feature state');
    t.equal(parseProbe('WARNING: x\r\n{"virtualizationFirmware":false,"hypervisorPresent":true,"installState":1}\r\n').hypervisorPresent, true, 'PowerShell probe: the last line is read as JSON');
    t.equal(Object.keys(parseProbe('not json')).length, 0, 'PowerShell probe: text that is not JSON is ignored');
    t.equal(Object.keys(parseProbe('{"installState":"1"}')).length, 0, 'PowerShell probe: JSON of the wrong shape is ignored');
    t.equal([nodeMajor('v22.11.0'), nodeMajor('18.0.0'), nodeMajor('')], [22, 18, 0], 'Node major version');

    t.section('judging each item');
    const good: MachineFacts = { edition: 'Professional', build: 22631, feature: 'enabled', sandboxExe: true, virtualizationFirmware: false, hypervisorPresent: true, totalRamBytes: 16 * GB, freeDiskBytes: 100 * GB, storageRoot: 'C:\\store', nodeVersion: 'v22.11.0' };
    const status = (facts: Partial<MachineFacts>): Record<string, string> => Object.fromEntries(buildChecks({ ...good, ...facts }).map((c) => [c.name, c.status]));
    t.check(buildChecks(good).every((c) => c.status === 'ok'), 'a ready PC is all OK (a running hypervisor counts as virtualization on)');
    t.equal(status({ edition: 'Core' })['Windows edition'], 'action', 'Windows Home needs action');
    t.equal(status({ build: 17763 })['Windows edition'], 'action', 'an old Windows build needs action');
    t.equal(status({ edition: 'Weird' })['Windows edition'], 'warn', 'an unknown edition warns');
    t.equal(status({ hypervisorPresent: false })['CPU virtualization'], 'action', 'virtualization: off needs action');
    t.equal(status({ hypervisorPresent: null, virtualizationFirmware: null })['CPU virtualization'], 'warn', 'virtualization: unknown warns');
    t.equal(status({ hypervisorPresent: false, virtualizationFirmware: true })['CPU virtualization'], 'ok', 'virtualization: on in the firmware is fine');
    t.equal(status({ feature: 'disabled', sandboxExe: false })['Windows Sandbox feature'], 'action', 'feature: off needs action');
    const waiting = buildChecks({ ...good, feature: 'pending', sandboxExe: false })[2];
    t.includes(waiting.detail, 'restart', 'feature: waiting for a restart says so');
    t.includes(buildChecks({ ...good, feature: 'enabled', sandboxExe: false })[2].detail, 'restart', 'feature: enabled but not usable yet says to restart');
    t.equal(status({ totalRamBytes: 6 * GB }).Memory, 'warn', 'RAM under 8 GB warns');
    t.equal(status({ totalRamBytes: 3 * GB }).Memory, 'action', 'RAM under 4 GB needs action');
    t.equal(status({ freeDiskBytes: 10 * GB })['Free disk'], 'warn', 'low free disk warns');
    t.equal(status({ freeDiskBytes: 2 * GB })['Free disk'], 'action', 'very low free disk needs action');
    t.equal(status({ freeDiskBytes: null })['Free disk'], 'warn', 'unknown free disk warns');
    t.equal(status({ nodeVersion: 'v18.20.0' })['Node.js'], 'action', 'an old Node.js needs action');
    const off = { ...good, feature: 'disabled' as const, sandboxExe: false };
    t.check(canEnableFeature(off), 'offers to enable the feature when it is off on an edition that has it');
    t.check(!canEnableFeature({ ...off, edition: 'Core' }), 'does not offer it on Windows Home');
    t.check(!canEnableFeature({ ...off, feature: 'pending' }), 'does not offer it while a restart is pending');
    t.check(!canEnableFeature(good), 'does not offer it when it is already on');
  },
};
