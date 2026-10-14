// `agent-sandbox setup`: the pure pieces of the machine checklist (parsing what Windows reports, judging each item).
import { buildChecks, canEnableFeature, editionSupport, nodeMajor } from '../cli/commands/setup/checks.js';
import {
  featureFromInstallState,
  parseDismState,
  parseProbe,
  parseRegQuery,
  type MachineFacts,
} from '../cli/commands/setup/facts.js';
import type { Suite } from './support/suite.js';

const GB = 1024 ** 3;

export const setupSuite: Suite = {
  name: 'setup',
  title: 'machine checklist for `sandbox setup`',
  run: (t) => {
    t.section('reading what Windows reports');
    const reg = parseRegQuery(
      '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\r\n    CurrentBuild    REG_SZ    22631\r\n    EditionID    REG_SZ    Professional\r\n    ProductName    REG_SZ    Windows 10 Pro\r\n    InstallDate    REG_DWORD    0x65a1b2c3\r\n',
    );
    t.equal(
      { EditionID: reg.EditionID, CurrentBuild: reg.CurrentBuild, ProductName: reg.ProductName },
      { EditionID: 'Professional', CurrentBuild: '22631', ProductName: 'Windows 10 Pro' },
      'reg query output parses into name/value pairs',
    );
    t.equal(
      ['Professional', 'EnterpriseS', 'EducationN', 'Core', 'CoreSingleLanguage', 'ServerStandard', 'Weird', null].map(
        editionSupport,
      ),
      ['supported', 'supported', 'supported', 'home', 'home', 'unsupported', 'unknown', 'unknown'],
      'editions: Pro/Enterprise/Education yes, Home and Server no',
    );
    const dism = (state: string): string =>
      'Deployment Image Servicing and Management tool\r\n\r\nFeature Name : Containers-DisposableClientVM\r\nDisplay Name : Windows Sandbox\r\nRestart Required : Possible\r\nState : ' +
      state +
      '\r\n';
    t.equal(
      [
        parseDismState(dism('Enabled')),
        parseDismState(dism('Enable Pending')),
        parseDismState(dism('Disabled')),
        parseDismState(dism('Disabled with Payload Removed')),
        parseDismState('Error: 740\r\nElevated permissions are required'),
      ],
      ['enabled', 'pending', 'disabled', 'disabled', 'unknown'],
      'DISM feature state: enabled, pending restart, disabled; errors are unknown',
    );
    t.equal(
      [featureFromInstallState(1), featureFromInstallState(2), featureFromInstallState(null)],
      ['enabled', 'disabled', 'unknown'],
      'Win32_OptionalFeature install state maps to the feature state',
    );
    t.equal(
      [
        parseProbe('WARNING: x\r\n{"virtualizationFirmware":false,"hypervisorPresent":true,"installState":1}\r\n')
          .hypervisorPresent,
        Object.keys(parseProbe('not json')).length,
        Object.keys(parseProbe('{"installState":"1"}')).length,
        nodeMajor('v22.11.0'),
        nodeMajor(''),
      ],
      [true, 0, 0, 22, 0],
      'PowerShell probe: the last line is read as JSON, other text or the wrong shape is ignored; Node major version',
    );

    t.section('judging each item');
    const good: MachineFacts = {
      edition: 'Professional',
      build: 22631,
      feature: 'enabled',
      sandboxExe: true,
      virtualizationFirmware: false,
      hypervisorPresent: true,
      totalRamBytes: 16 * GB,
      freeDiskBytes: 100 * GB,
      storageRoot: 'C:\\store',
      nodeVersion: 'v22.11.0',
    };
    const status = (facts: Partial<MachineFacts>): Record<string, string> =>
      Object.fromEntries(buildChecks({ ...good, ...facts }).map((c) => [c.name, c.status]));
    t.check(
      buildChecks(good).every((c) => c.status === 'ok'),
      'a ready PC is all OK (a running hypervisor counts as virtualization on)',
    );
    t.equal(
      [
        status({ edition: 'Core' })['Windows edition'],
        status({ build: 17763 })['Windows edition'],
        status({ edition: 'Weird' })['Windows edition'],
        status({ nodeVersion: 'v18.20.0' })['Node.js'],
      ],
      ['action', 'action', 'warn', 'action'],
      'Windows Home and an old build or Node.js need action; an unknown edition warns',
    );
    t.equal(
      [
        status({ hypervisorPresent: false })['CPU virtualization'],
        status({ hypervisorPresent: null, virtualizationFirmware: null })['CPU virtualization'],
        status({ hypervisorPresent: false, virtualizationFirmware: true })['CPU virtualization'],
      ],
      ['action', 'warn', 'ok'],
      'virtualization: off needs action, unknown warns, on in the firmware is fine',
    );
    t.check(
      status({ feature: 'disabled', sandboxExe: false })['Windows Sandbox feature'] === 'action' &&
        buildChecks({ ...good, feature: 'pending', sandboxExe: false })[2].detail.includes('restart') &&
        buildChecks({ ...good, feature: 'enabled', sandboxExe: false })[2].detail.includes('restart'),
      'feature: off needs action; pending or not usable yet says to restart',
    );
    t.equal(
      [
        status({ totalRamBytes: 6 * GB }).Memory,
        status({ totalRamBytes: 3 * GB }).Memory,
        status({ freeDiskBytes: 10 * GB })['Free disk'],
        status({ freeDiskBytes: 2 * GB })['Free disk'],
        status({ freeDiskBytes: null })['Free disk'],
      ],
      ['warn', 'action', 'warn', 'action', 'warn'],
      'low RAM or disk warns, very low needs action, unknown disk warns',
    );
    const off = { ...good, feature: 'disabled' as const, sandboxExe: false };
    t.check(
      canEnableFeature(off) &&
        !canEnableFeature({ ...off, edition: 'Core' }) &&
        !canEnableFeature({ ...off, feature: 'pending' }) &&
        !canEnableFeature(good),
      'offers to enable the feature only when it is off on an edition that has it (not Home, pending or already on)',
    );
  },
};
