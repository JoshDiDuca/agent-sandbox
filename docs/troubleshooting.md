# Troubleshooting

Start with `sandbox repair`, then `sandbox doctor` and `sandbox logs -f`.

| Problem | Try |
|---|---|
| Windows Sandbox missing | `sandbox setup` checks the edition and virtualization, and offers to turn it on |
| "A Windows Sandbox is already running" | Only one runs at a time: `sandbox status`, then `sbx-show` or `sandbox stop` |
| A toolchain failed on first start | The rest still works. `sandbox repair` removes the half-install, so the next start retries |
| Install commands fail | `npm install -g` needs Node.js 20+; the one-liner installs it. Check your internet and try again |
| The first start is slow | Expected once: it downloads what the project needs. Later starts reuse it |
| Disk filling up | `sandbox data` shows what is big; `sandbox data clean <part>` frees it |
| Config errors | The message names the key and the problem; `sandbox config show` prints the effective config |
| pnpm, Bun or npm workspaces fail with EPERM | Mapped folders allow no symlinks; see [mapped folders](toolchains.md#mapped-folders) |
| A database didn't start | Check `sandbox logs`. Turn it on explicitly with `databases.<name>.enabled: true` |
