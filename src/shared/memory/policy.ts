// What "heavy load" means, decided once for the host watchdog and the guest governor (pure, no I/O). Every
// protection is on by default; the gentle profile (vGPU on: a graphics driver hang can freeze the whole PC) triggers
// earlier and runs the sandbox with less CPU.

export type LoadProfile = 'normal' | 'gentle';

/** The guest governor: when memory inside the sandbox counts as under pressure, and when it has recovered. */
export interface GuestThresholds {
  /** Pressure starts when available RAM is below this share of the sandbox's RAM (percent)... */
  readonly enterAvailablePercent: number;
  /** ...or commit is above this share of its limit. */
  readonly enterCommitPercent: number;
  /** Pressure ends only when available RAM is above this and commit is below the next, for `calmSamples` in a row. */
  readonly exitAvailablePercent: number;
  readonly exitCommitPercent: number;
  readonly calmSamples: number;
}

export const GUEST_THRESHOLDS: Readonly<Record<LoadProfile, GuestThresholds>> = {
  normal: {
    enterAvailablePercent: 8,
    enterCommitPercent: 92,
    exitAvailablePercent: 12,
    exitCommitPercent: 88,
    calmSamples: 3,
  },
  gentle: {
    enterAvailablePercent: 15,
    enterCommitPercent: 85,
    exitAvailablePercent: 20,
    exitCommitPercent: 80,
    calmSamples: 3,
  },
};

/** The PC watchdog: when this PC itself is low. */
export interface HostThresholds {
  /** Low when available RAM is below max(this, availableShare of total RAM)... */
  readonly availableMinMb: number;
  readonly availablePercent: number;
  /** ...or available commit is below this share of the commit limit (percent)... */
  readonly commitAvailablePercent: number;
  /** ...or below half the reserveHostMb. Recovered above 1.25 times each limit for `calmSamples` samples. */
  readonly calmSamples: number;
  /** Total CPU above this (percent) for cpuSeconds. */
  readonly cpuPercent: number;
  readonly cpuSeconds: number;
  /** The disks' queue length (all together) at or above this for diskSeconds: builds writing through mapped folders. */
  readonly diskQueue: number;
  readonly diskSeconds: number;
}

export const HOST_THRESHOLDS: Readonly<Record<LoadProfile, HostThresholds>> = {
  normal: {
    availableMinMb: 4096,
    availablePercent: 12,
    commitAvailablePercent: 15,
    calmSamples: 3,
    cpuPercent: 95,
    cpuSeconds: 60,
    diskQueue: 32,
    diskSeconds: 40,
  },
  gentle: {
    availableMinMb: 6144,
    availablePercent: 15,
    commitAvailablePercent: 20,
    calmSamples: 3,
    cpuPercent: 90,
    cpuSeconds: 45,
    diskQueue: 16,
    diskSeconds: 30,
  },
};

/** The CPU cap (percent of the PC) the gentle profile uses: 15 points lower, never below 50. "none" = 100. */
export function gentleCpuLimit(cpuLimit: 'none' | number): number {
  return Math.max(50, (cpuLimit === 'none' ? 100 : cpuLimit) - 15);
}

/** The CPU cap the sandbox runs with (percent; null = none) for a profile. */
export function effectiveCpuLimit(cpuLimit: 'none' | number, profile: LoadProfile): number | null {
  if (profile === 'gentle') return Math.min(gentleCpuLimit(cpuLimit), cpuLimit === 'none' ? 100 : cpuLimit);
  return cpuLimit === 'none' ? null : cpuLimit;
}

/** Cargo jobs that fit the memory (about 4 GB per rustc) and the CPUs, fewer when several agent sessions build. */
export function cargoJobs(cpus: number, memoryGb: number, sessions: number): number {
  const byCpu = Math.max(2, Math.min(4, Math.floor(cpus / 4)));
  const byMemory = Math.max(1, Math.floor(memoryGb / 4));
  const jobs = Math.min(byCpu, byMemory);
  // All the agents' builds share the sandbox: about 8 jobs in total however many sessions there are.
  return Math.max(1, Math.min(jobs, Math.floor(8 / Math.max(1, sessions))));
}

/** The most heavy compilers (rustc, clippy-driver, link ...) that run at once in the agents' job: only with vGPU on. */
export function maxCompilers(cpus: number, profile: LoadProfile): number | null {
  return profile === 'gentle' ? Math.max(2, Math.floor(cpus / 4)) : null;
}
