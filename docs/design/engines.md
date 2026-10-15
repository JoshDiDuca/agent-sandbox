# Sandbox engines and storage providers (design)

Status: **planned for 1.9 (beta, opt-in)**. Research behind it: [hcs-backend.md](hcs-backend.md). Windows Sandbox stays
the default engine and keeps every feature it has; everything here is an extra you switch on, and one setting switches
it off again.

## Goals

- Hybrid: all of Windows Sandbox (desktop, Windows Terminal, GPU, clipboard, audio, printers, apps), plus extras: contained
  storage, and later a headless HCS engine for agents.
- Works with every Windows Sandbox version this tool supports today (with or without the `wsb` CLI); nothing new is
  required to keep using it.
- One way back: `sandbox.engine: "windows-sandbox"` and `storage.contained: "off"` are the defaults and give exactly
  today's behaviour, byte for byte (the `generate` golden tests prove the .wsb and launch folder are unchanged).
- Room to grow: a new engine or storage kind is one module behind an interface, chosen by a setting.

## Never

- Nothing on Windows is enabled, installed or changed without asking first (Windows features, services, groups, the
  firewall of the PC). An engine that needs one of those says so in `sandbox engine check` and doctor, with the exact
  command, and stops.
- Nothing irreversible: everything an engine or provider creates is listed in its state file and removed by
  `sandbox engine clean` / `sandbox storage contained off`; a failed start leaves the PC as it was.
- No guest data is executed or mounted by the host beyond what is described here; the hostile-guest rules in CLAUDE.md
  apply unchanged.

## Shape

```
launch (cli) ──> LaunchPlan (neutral, pure) ──> engine.plan() ──> engine.start()
                     ▲                              │
            storage provider.prepare()      windows-sandbox: .wsb + start (today's code)
            (mappings or disks)             hcs: compute-system documents + HcsHost.exe (beta)
```

- `src/host/engines/` (barrel `index.ts`):
  - `types.ts`: `EngineId` ('windows-sandbox' | 'hcs'), `EngineCapabilities` (desktop, gpu, clipboard, audio, video,
    printers, liveFolderAdd, attachedDisks, multipleInstances, hvsocket), `EngineCheck` ({ available, reasons[],
    fixes[] }), `LaunchPlan` (mappings: host/guest/readOnly; memoryMb; cpu; networking; devices; logon command; storage
    attachments), `EnginePlan` (engine-specific, opaque to callers), `RunningSandbox` (id, engine, started).
  - `engine.ts`: `interface SandboxEngine { id; capabilities(); check(): Promise<EngineCheck>; plan(LaunchPlan):
    EnginePlan; start(EnginePlan): Promise<RunningSandbox>; running(): Promise<boolean>; stop(): Promise<void> }`.
  - `windows-sandbox/`: today's code behind the interface (wsb-file, platform start/confirm/isRunning). No behaviour
    change; capabilities come from the probe (wsb CLI present → liveFolderAdd).
  - `hcs/` (beta): `documents.ts` (pure: HCS schema 2.x JSON for a Hyper-V isolated container / utility VM: SCSI
    attachments, VirtualSmb shares, HvSocket, no NIC by default), `helper.ts` (runs `HcsHost.exe` with JSON files in a
    private temp folder), `check.ts` (features, vmcompute, Hyper-V Administrators membership, base image present),
    `images.ts` (an `ImageStore` interface; the first store only uses an image already present, see below).
  - `registry.ts`: `engineFor(config)` picks the engine; refuses `hcs` unless its check passes, with the reasons.
- `src/host/storage/providers/` (barrel): `interface StorageProvider { id; check(); prepare(dataSet):
  Promise<PreparedStorage>; release(): Promise<void> }`; `PreparedStorage` is either folder mappings (Windows Sandbox)
  or disk attachments (HCS). Providers: `folder` (today), `vhdx-mounted` (Windows Sandbox contained storage),
  `vhdx-attached` (HCS).
- The data set splits in two when contained: `run\` (the host<->guest channel) always stays a host folder shared in,
  because the host must read it; `tools\`, `state\`, `logs\` go into the container image.
- `native/csharp/HcsHost/` (C# 5, built on first use like HostTools, file details set): verbs `check`, `enumerate`,
  `properties <id>`, `create <doc.json>`, `start <id>`, `terminate <id>`, `grant-vm-access <vhdx> <id>`,
  `create-vhdx <path> <maxGb>` (CreateVirtualDisk; never attaches to the host). JSON in and out through files; every
  handle closed in `finally`; failures as Win32Exception messages.
- Contained storage for Windows Sandbox: `native/scripts/mount-contained.ps1` (fixed, run elevated with one UAC prompt
  per launch; mounts only `<storage>\images\<set>.vhdx` at `<storage>\mounts\<set>` after checking both are inside your
  private storage, not links, owned by you; no drive letter; mount folder ACL you + SYSTEM) and `dismount-contained.ps1`;
  a refcount state file outside the image; stale mounts found and fixed by doctor/repair.

## Settings (core/schema, DEFAULTS, docs)

- `sandbox.engine`: `"windows-sandbox"` (default) | `"hcs"` (beta; refused with reasons when its check fails).
- `storage.contained`: `"off"` (default) | `"vhdx"`; `storage.containedMaxGb` (default 64).
- Neither can be set by a repo's `.sandbox-config.json`.

## Commands

- `sandbox engine` (status: the engine in use, each engine's capabilities and check), `sandbox engine check hcs`,
  `sandbox engine clean` (removes what an engine created, listed first).
- `sandbox storage contained on|off` (creates or retires the image; offers to move today's tools/state/logs in, with
  size and time, like `storage move`).

## Phases

1. Engine layer + Windows Sandbox engine (no behaviour change), settings, `sandbox engine` status. Storage provider
   interface with `folder`.
2. Contained storage for Windows Sandbox (`vhdx-mounted`), after `scripts/experiments/Test-ContainedStorage.ps1` passes
   on a PC.
3. HCS engine, beta: documents, HcsHost.exe, check; start is enabled only after the go/no-go test (Docker Desktop,
   Windows containers, Hyper-V isolation: ptyhost + Node + csc inside Server Core) passes. First image store: an image
   already imported on the PC (e.g. by Docker), never a download of ours; our own importer later.
