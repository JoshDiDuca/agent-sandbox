# HCS backend: design and P0 probe

Status: research only. Written inside a Windows Sandbox with no nested virtualization, so nothing here was run against
HCS. Tags: **[V]** = checked against a Microsoft page (linked at the end), **[U]** = from memory or third-party
reports, must be confirmed by the P0 probe (`scripts/experiments/hcs/Test-Hcs.ps1`) or a prototype.

Goal: agent tools, state and logs live in a VHDX attached straight to the isolated VM (the host never mounts it); the
user's code is a normal host folder shared in; isolation is at least Windows Sandbox's.

## 1. HCS options

The Host Compute Service (`vmcompute`, API in `computecore.dll`, JSON documents) starts and controls VMs and
containers. Compute systems are ephemeral: when one stops it is gone, and the client must prepare the VHD, networking
and hvsockets first [V]. Minimum client is Windows 10 1809 [V].

| Option | What it is | Needs | Verdict |
| --- | --- | --- | --- |
| A. Hyper-V isolated Windows container | A utility VM (UVM) with the Windows kernel from the image, plus a container inside it (`HcsCreateComputeSystem` for the UVM, then one with `HostingSystemId`). What Docker/containerd/hcsshim do with `--isolation=hyperv`. | Containers feature [U] + Hyper-V hypervisor (the full Hyper-V role is probably not needed, VirtualMachinePlatform may do) [U]. | **Main path.** Own kernel per sandbox, same boundary class as Windows Sandbox. |
| B. Process-isolated container | Shares the host kernel. | Containers feature. | Rejected: weaker than Windows Sandbox. |
| C. Plain HCS VM | A full VM from a VHDX with an installed Windows. | Hyper-V platform. | Rejected for now: needs a full licensed Windows image, install and servicing. Fine later for a Linux guest. |
| D. Reuse Windows Sandbox's own definition | Windows Sandbox runs through `CmService` (Container Manager) and `vmcompute` [V, third-party]: a container-type VM over a dynamic base image (host files plus ~500 MB of pristine mutable files [V]), vSMB over VMBus and VHDx layering [V, Check Point]. | Only the Windows Sandbox feature. | No public API. Observe it (`HcsEnumerateComputeSystems`, `hcsdiag list`) for ideas, never depend on it. The base image folder `C:\ProgramData\Microsoft\Windows\Containers\BaseImages` is undocumented [U]. |

Features, by option: A needs Containers (adds `hcsdiag`, wclayer-style layer APIs, HNS container networking) [U]; the
only thing Windows Sandbox alone is guaranteed to give is `vmcompute` and the hypervisor, and it ships the
`Containers-DisposableClientVM` feature [U]. P0 reports which of `Containers`, `Microsoft-Hyper-V-*`,
`VirtualMachinePlatform` and `Containers-DisposableClientVM` are on, and whether `computecore.dll` and `vmcompute`
exist. Windows Home cannot run any of this [U]. Docker is NOT required: HCS is a plain Win32 API.

## 2. Base image

- **Microsoft images** from `mcr.microsoft.com` [V that they exist and how they are tagged]: `windows/nanoserver`
  (about 100 to 150 MB compressed [U]), `windows/servercore` (about 2 GB compressed, about 5 GB on disk [U]),
  `windows` and `windows/server`. Tags are `ltsc2022`, `ltsc2025`, `1809`, or KB/build tags [V]; there is no `latest`
  [V]. Licence: the Windows container OS image licence supplement allows use as a base of containers on a licensed
  host [U]. Redistributing the layers inside our installer is NOT assumed allowed: download from MCR on first use,
  from the user's own PC. Have the owner confirm before shipping.
- **Pulling without Docker** [U for details]: anonymous registry v2 API (`GET /v2/windows/servercore/manifests/<tag>`
  with the Windows manifest-list `os.version` match, then each blob `GET /v2/.../blobs/sha256:...`; blobs are
  gzip tars in a Windows layer format with `Files\` and `Hives\`). Import each layer with `computestorage.dll`:
  `HcsImportLayer` (also used by wclayer/ctr), then for the base layer `HcsSetupBaseOSLayer`, and for the writable
  scratch `HcsInitializeWritableLayer`; layer chains are given to HCS as `Layers: [{Id, Path}]` with
  `HcsAttachLayerStorageFilter` done by HCS/hcsshim [U]. The repo already has `shared/download` (checksums,
  fallback); a layer importer is new C# (`HcsLayer.cs`) plus a TS registry client. Alternative: ship a tiny
  `ctr`/`hcsshim`-based helper downloaded with a checksum, with its own supply-chain cost.
- **Version matching** [V]: Windows 11 runs Hyper-V isolation with any image (2016, 2019, 2022, 2025 from 24H2), and
  process isolation only with matching builds (plus WS2022 on Win11). Hyper-V isolation supplies the matching
  kernel, so we pick one pinned image (`ltsc2022`) and the host build does not matter. A Windows 10 host cannot run
  `ltsc2022` at all [V]. Note this host is Windows 11 build 22621 in this sandbox [V from the session].
- **Dynamic base image (Windows Sandbox)** [V]: built by CmService from host files, shared memory pages
  (direct map), WDDM GPU. Not reproducible by us and unsupported to touch. So for option A our guest OS is Server
  Core/Nano, not the user's Windows: the toolchain installers must work there (section 7).
- Servicing: the pinned image is pulled once to `%ProgramData%\AgentSandbox\hcs\layers` (host-owned, ACL
  SYSTEM and Administrators write only), digest-verified, refreshed by `sandbox doctor`.

## 3. Storage

Everything is a JSON document passed to HCS [V]; exact fields below are from hcsshim's usage [U] and the 2.x schema.

- **Agent VHDX (tools, state, logs).** The host creates a sparse dynamic VHDX with `CreateVirtualDisk`
  (virtdisk.dll; no mount, no admin needed for the call itself [U]) with `MaximumSize` as the cap (for example 64 GB)
  and a private ACL. The VM worker runs as the per-VM virtual account, so grant it access with
  `HcsGrantVmAccess(vmId, path)` (computestorage.dll) just before start and `HcsRevokeVmAccess` after [U]. Attach
  as a SCSI disk: `VirtualMachine.Devices.Scsi.<controller>.Attachments.<lun> = {Type:"VirtualDisk", Path, ReadOnly:false}`.
  First boot, inside the UVM: the guest runtime partitions and formats (NTFS) the blank disk, then maps it into the
  container with `MappedVirtualDisks`/`MappedDirectories` at `C:\AgentData` [U]. Persistence: the VHDX file lives
  under the storage folder; deleting the file is "reset". The host never mounts it, so a hostile guest cannot attack
  host NTFS parsing through a mount, and `assertNoLinks` is moot for it. Cost: the host cannot read logs; ship them
  out over the control channel (hvsocket, below) into host-side files that the guest cannot touch.
- **Scratch/OS layers.** A second VHDX (the writable layer, 20 GB sparse) per run, deleted on stop.
- **User code.** `Devices.VirtualSmb.Shares[]` on the UVM, each `{Name, Path, Flags: {ReadOnly, ShareRead, NoDirectmap...}}`
  [U], then `MappedDirectories` on the container: `[{HostPath (UVM-side path), ContainerPath, ReadOnly}]` [U]. Windows
  Sandbox uses vSMB the same way [V, Check Point]. Plan9 is for Linux guests. Read-only shares for
  everything that must not be written (host tools). The existing mapping rules in `host/launch/mappings.ts`
  (what is mapped, read-only or not) carry over unchanged.
- The guest still cannot make links in a mapped folder? Unknown: vSMB honors symlinks, so keep
  `assertNoLinks` for the code folder [U].

## 4. Networking

- Container networking goes through HNS/HCN (`computenetwork.dll`): create a NAT network, an endpoint, attach the
  endpoint ID in `Container.Networking.EndpointList` (or `NetworkAdapters` on the UVM) [U]. HNS calls need admin [U].
- **Best isolation: no NIC at all.** Control channel over **hvsocket** (`AF_HYPERV`, service GUID registered under
  `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices`, which needs admin
  once) instead of the ptyhost TCP port [U]. Internet access (npm, git, model APIs) via a **host-side filtering proxy**
  reached over a second hvsocket, with the guest setting `HTTP(S)_PROXY`. This gives "LAN blocked" by construction and
  turns `network.allowOnly` / `blockHosts` into enforced host-side rules instead of guest guardrails (better than
  today). Cost: non-proxy-aware tools (raw git over ssh, DNS lookups) need a SOCKS/DNS shim.
- Fallback if the proxy is too costly: NAT network plus HNS ACL policies (`Policies` of type `ACL` blocking
  10/8, 172.16/12, 192.168/16, 169.254/16, host gateway except DNS) [U]. Port forwarding for the terminal channel is
  then a NAT `PortMapping`, but hvsocket is preferred (no host listening port).
- DNS: from the NAT's internal resolver, or from the proxy.

## 5. Privileges

[V third-party] Lima's HCS driver requires Hyper-V Administrators membership and an elevated shell. [U] vmcompute
authorizes callers as local Administrators, SYSTEM or Hyper-V Administrators; `HcsEnumerateComputeSystems` and
`HcsGetServiceProperties` may work unelevated, while create/start probably do not. `HcsCreateComputeSystem` takes a
`securityDescriptor` but it is "reserved, must be NULL" [V]. HNS and layer import need admin [U]. P0 answers this
empirically (run once elevated, once not).

**Broker design if admin is needed** (we must not require the CLI to run elevated every time):
- A small Windows service `AgentSandboxBroker` (C# 5, built with csc as the other HostTools), installed once with
  UAC through the existing all-users installer, running as LocalSystem or a dedicated virtual account in Hyper-V
  Administrators. The least privilege option is the second one.
- Named pipe `\\.\pipe\AgentSandboxBroker` with a DACL for the installing user's SID only (plus Administrators);
  `PIPE_REJECT_REMOTE_CLIENTS`; per-connection impersonation check.
- Verbs only (validated JSON, size-limited, no raw HCS documents from the client):
  `prepare {project, mappings[], diskId}`, `start`, `stop`, `list`, `grantDisk`. The broker BUILDS the HCS
  document itself from a fixed template and the allowlisted parameters: shares only from folders the user's own token
  can already write/read (check by impersonating the caller and opening them; reject reparse points and anything under
  system, `%ProgramData%\AgentSandbox` internals, other users' profiles), VHDX only under its own storage folder,
  fixed memory/CPU bounds, no `Privileged`, no device assignment, no extra `Plan9`, no `HostPath` outside the allowlist.
- Escalation risks: path confusion (junctions/TOCTOU on share paths: open by handle, resolve final path, deny
  reparse points), a client asking to share `C:\` (denied by the allowlist and by "user can already read"), a
  compromised user process abusing it as a general VM launcher (acceptable: it can only start our fixed template), pipe
  squatting (create with `FILE_FLAG_FIRST_PIPE_INSTANCE`), and the broker's own code location being writable (install
  under Program Files). This is a new privileged component and a clear step beyond Windows Sandbox's trust model, which
  runs for any user with no extra service of ours. It is the main security cost of this backend.

## 6. Driving HCS from this repo

Layout (follows the rules: JSON built in TS, passed by temp file; C# 5, csc.exe v4.0.30319; P/Invoke in
`NativeMethods` with `SetLastError`; no `$`, `?.`, `nameof`):

- `native/csharp/HostTools/HcsTool.cs` (host helper, `hcs-tool.exe` built on first use) and, if the broker is needed,
  `HcsBroker.cs` hosting the same code. TS side `src/host/hcs/` (barrel `index.ts`): `documents.ts` (zod-validated
  builders for the compute system, layers, shares), `registry.ts` (MCR pull), `backend.ts` (the `SandboxBackend`
  implementation next to the .wsb one).
- Verbs (all `hcs-tool <verb> --in file.json --out result.json`): `props` (`HcsGetServiceProperties`), `list`
  (`HcsEnumerateComputeSystems`), `layer-import`, `layer-init-scratch`, `disk-create` (`CreateVirtualDisk`),
  `disk-grant`/`disk-revoke`, `create` (`HcsCreateOperation`, `HcsCreateComputeSystem`, wait), `start`
  (`HcsStartComputeSystem`), `exec` (`HcsCreateProcess` with `CreateStdInPipe` etc., returns the process ID; stdio over
  named pipes created by the helper), `modify` (`HcsModifyComputeSystem`, hot add of a share), `terminate`
  (`HcsTerminateComputeSystem`), `close`. Each verb waits with `HcsWaitForOperationResult` [V signature]; result
  strings are freed with `LocalFree` [V].
- Documents: `schemaVersion {Major:2, Minor:1}` for Windows 10/11 containers; UVM and SCSI/vSMB fields from 2.1 to
  2.5+, `Owner:"AgentSandbox"`, `ShouldTerminateOnLastHandleClosed:true` so a crash cleans up [U]. P0 prints the
  supported versions (the `SupportedSchemaVersions` of the `Basic` service property [U]) and picks the highest
  common one.
- **Guest runtime.** The current guest uses PowerShell 5.1, `csc.exe` (PtyHost.cs, GitShim.cs) and Node. Nano Server
  has no .NET Framework and no Windows PowerShell 5.1 [U], so the container base must be **Server Core**
  (has .NET Framework 4.8, PowerShell 5.1, csc.exe [U]). Node installs by unzip (no MSI): fine on Server Core, and
  official Node images for both exist [U]. The boot chain `logon.cmd` -> `bootstrap.ps1` becomes the container
  entrypoint process started with `HcsCreateProcess` (`CommandLine`, `WorkingDirectory`, environment from a one-shot
  file in a read-only share, as secrets are today).
- **ConPTY.** `CreatePseudoConsole` ships since 1809 in kernel32 and `conhost.exe` is in Server Core and Nano [U];
  PtyHost.cs should work, but the console host inside a container (no desktop session) is a known sore spot
  [U]. P1 first test: run PtyHost in a Server Core container and attach with `sandbox attach`. The viewer
  (`sessions/viewer`) protocol over TCP changes only in transport (hvsocket stream); the ptyhost protocol stays.

## 7. Lost and gained versus Windows Sandbox

Lost (certain or very likely): a desktop (no Windows Terminal window, no Edge, no RDP-style window) [U];
GPU/vGPU and WARP desktop apps [U]; clipboard redirection (we can keep OSC 52 over the channel); installers that
need a desktop session or the full OS (some MSIs, VS Build Tools GUI, anything using the shell, WSL, Docker,
LocalDB (already unsupported)); the dynamic image's "it is my own Windows" parity (Server Core 2022 differs from
Win11: some DLLs, no WinRT/AppX); memory sharing and small footprint (a UVM is a normal VM, plus the Server Core
layers in the 5 GB range); audio/video/printer redirection (already off by default).

Gained: the agent VHDX that the host never mounts; kernel-boundary isolation without the Windows Sandbox
one-session limit (several UVMs at once [U]); a proxy-enforced network policy; per-project persistent state and
tool caches that survive runs (no re-provisioning each boot, the biggest speedup); hvsocket instead of a TCP port;
a smaller attack surface (no desktop, no browser, no clipboard); exact control of resources and a cleanup guarantee
(`ShouldTerminateOnLastHandleClosed`); and a pinned base image rather than whatever the PC runs.

Security parity check: Windows Sandbox is a container-flavoured VM with direct-map shared memory [V]; a Hyper-V
isolated container is a VM with its own kernel (stronger boundary than process containers) [V]. Unknown: attack
surface of vSMB shares (shared by both), and the new broker (additional, ours).

## 8. Phased plan and go/no-go

**P0 (now, owner's PC, 1 hour):** run `scripts/experiments/hcs/Test-Hcs.ps1` twice (normal user, elevated), and once
more while a Windows Sandbox is running. Paste the reports. It only reads (features, services, files, the base
image folder listing, `HcsGetServiceProperties`, `HcsEnumerateComputeSystems`, `hcsdiag list`).
Also, by hand and optional: `docker`-less check of `Enable-WindowsOptionalFeature -FeatureName Containers` is NOT done by
the probe (it would change the PC); the owner decides separately whether enabling Containers is acceptable.

**P1 (experimental, `sandbox.backend: "hcs"`, default `"wsb"`):** `HcsTool` verbs `props/list/disk-create/create/start/
exec/terminate`; MCR pull and layer import of `servercore:ltsc2022` and nanoserver (for comparison); one container with a
shared code folder (read-only first) and the agent VHDX; run `node` and the ptyhost; attach from the CLI over
hvsocket; kill switch network (no NIC). Admin or broker prototype. Self-test additions run only in CI VMs that have
nested virtualization, or are skipped with a printed reason (like the live suites today).

**P2 (parity):** toolchains/databases/agents on Server Core, proxy and DNS shim, the menu and `doctor`, resource
sizing, history and secrets channel, install of the broker in the all-users installer, `repair`/cleanup of leaked
compute systems and VHDX, docs and `docs/security.md` update.

**Go criteria (all):** (1) P0 shows `computecore.dll` present and `HcsEnumerate...`/`GetServiceProperties` working;
(2) a Hyper-V isolated Server Core container starts on the owner's PC with only the Windows features the owner accepts
to enable; (3) VHDX attach and the code share work with the access model in section 3; (4) ConPTY and Node work in the
container; (5) the privilege model is acceptable: either a normal user (or Hyper-V Administrators) can create
compute systems, or a broker with the allowlist above is accepted as a new trusted component; (6) the licence of the
base image is confirmed.
**No-go (any):** creation needs a persistent elevated process we cannot confine; Containers feature cannot be enabled
(policy, Home/Pro limits); Server Core cannot run the toolchains we need; ConPTY unusable in containers; vSMB share
semantics unsafe (links escape the share).

## Sources

- [V] [HCS overview](https://learn.microsoft.com/en-us/virtualization/api/hcs/overview): client prepares VHD, network, hvsockets; JSON documents; ephemeral systems.
- [V] [HcsCreateComputeSystem](https://learn.microsoft.com/en-us/virtualization/api/hcs/reference/hcscreatecomputesystem): signature, `securityDescriptor` reserved, Container/VirtualMachine/HostedSystem, Win10 1809+.
- [V] [HcsEnumerateComputeSystems](https://learn.microsoft.com/en-us/virtualization/api/hcs/reference/hcsenumeratecomputesystems), [HcsGetServiceProperties](https://learn.microsoft.com/en-us/virtualization/api/hcs/reference/hcsgetserviceproperties), [HcsWaitForOperationResult](https://learn.microsoft.com/en-us/virtualization/api/hcs/reference/hcswaitforoperationresult).
- [V] [Container version compatibility](https://learn.microsoft.com/en-us/virtualization/windowscontainers/deploy-containers/version-compatibility): Hyper-V vs process isolation matrix, no `latest` tag, tags.
- [V] [Windows Sandbox architecture](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-architecture): dynamic base image, direct map, WDDM.
- [V, third party] [Check Point: Playing in the Windows Sandbox](https://research.checkpoint.com/2021/playing-in-the-windows-sandbox/): vSMB over VMBus, VHDx layering, CmService/vmcompute.
- [V, third party] [Lima HCS driver](https://lima-vm.io/docs/config/vmtype/hcs/): Hyper-V Administrators and elevated shell.
- Everything tagged [U] (layer APIs, `HcsGrantVmAccess`, Scsi/VirtualSmb field names, HNS, Server Core/Nano contents, ConPTY in containers, licence terms, hcsdiag output) is from memory of hcsshim and the HCS schema and is not confirmed here.
