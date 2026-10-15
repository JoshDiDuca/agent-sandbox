# Web UI (design)

Status: **Phase 1 (the foundation) is built, off by default** (`web.enabled`; `sandbox web start` works either way; with
`web.enabled` on, every sandbox start also starts it). Planned to be complete in 1.9, the release before 2.0. This page is the design the
code follows; user-facing steps go in README.md once it ships.

## What it is for

See and use your sandbox sessions from a browser: the list of sessions, a live terminal for each (type into it as with
`sandbox attach`), and new sessions. First in a browser on this PC (including another Windows user of it, when you
share your sandbox), later from a phone on your own network.

## Shape

```
browser (React app, xterm.js)  ──HTTP + WebSocket──>  sandbox web (Node, on the PC, as you)
                                                          │ reads run\ (sessions), checks the sharing rules
                                                          └──TCP, ptyhost protocol──>  session terminal in the sandbox
```

- **One repo, one package.** The server reuses `shared/pty` (protocol, client), `host/channel` (`SandboxChannel`,
  session requests) and `host/sharing` (who may do what). Every page besides the terminal is a view of the shared core
  ([design/shared-core.md](design/shared-core.md)): the browser runs its operations and queries over an RPC socket, and
  draws its pages with the same pure definitions the CLI and the menu use. The app lives in `web/` (React + TypeScript,
  Mantine 7, TanStack Query, `@xterm/xterm`), is bundled by esbuild (already a dependency; no Vite) into `dist/web/` and
  ships in the package. Its dependencies are dev dependencies: only the built files ship.
- **Server:** `src/host/web/` (the HTTP server, the WebSocket bridge, auth) with `node:http` and the `ws` package (small,
  no dependencies of its own, bundled). Started by `sandbox web` (start / stop / status / open), runs in the background
  like the sync watcher, and keeps running when no sandbox does (the page says so).
- **The browser never gets a session's attach token.** The server holds it, connects to the session's ptyhost (only to
  sandbox addresses, `isSandboxAddress`, as `attach` does) and passes frames both ways: OUTPUT to the browser; INPUT,
  RESIZE and PING from it. Several browsers may watch one session, as several `attach` terminals can.

## Security

The server is a way into every agent you run, so it is treated like a login:

- **Off by default**, switched on in Settings or with `sandbox web start`. It is not settable from a repo's
  `.sandbox-config.json`.
- **Loopback only** (`127.0.0.1`) until the LAN phase. Every Windows user of the PC can reach loopback, so nothing works
  without a token:
  - A 32-byte random token per server start, kept in a host-only file in your storage (private ACL), never in a
    sandbox's data folder. `sandbox web open` opens `http://127.0.0.1:<port>/#k=<token>`. The fragment never reaches the
    server's logs or the browser history.
  - The page trades the token once (`POST /api/login`, constant-time compare, rate-limited) for an `HttpOnly`,
    `SameSite=Strict` session cookie. Every API call and the WebSocket upgrade need that cookie.
- **No other site can drive it.** The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding).
  The WebSocket upgrade must come from the server's own `Origin`. State-changing calls need a CSRF header. There is no
  CORS. CSP is `default-src 'self'` with no inline scripts; frames are refused (`frame-ancestors 'none'`). Everything
  is served from the package: no CDN.
- **Same rules as the CLI.** Another user's sandbox is shown and used only as far as `ownerRule` allows (look; use when
  shared; never restart or launch). Data read from `run\` is validated as everywhere else; terminal text goes only to
  xterm.js (no HTML), links in it open only after a confirmation, and clipboard writes from the terminal (OSC 52) are
  ignored.
- **LAN / phone (later, opt-in):** HTTPS with a certificate made for this PC (its fingerprint shown as a QR code to
  pair), a pairing code per device, devices listed and revocable, a Windows Firewall rule for private networks only.
  Not part of the foundation.

## Phases

1. **Foundation** (done, behind the setting): the server, auth, the bridge, the React app with the session list, a
   terminal page (resize, reconnect, detach) and "new session" (an agent in a project of the running sandbox).
2. **1.9:** a plain shell session kind (PowerShell in the sandbox through ptyhost, so new terminals show up in the web
   UI too), closing a session, a menu entry and Settings rows, the mobile layout and an on-screen key row (Esc, Tab,
   Ctrl, arrows) for phone keyboards.
3. **LAN and phones:** the opt-in LAN mode above.

## What Phase 1 is (as built)

- **Settings:** `web.enabled` (default off; on = every sandbox start also starts the server), `web.openOnLaunch` (default off; opens the
  browser already signed in) and `web.port` (default 47800, 1024-65535). Not in `LocalOverrides`.
- **Commands:** `sandbox web start | stop | status | open` (PC only). `start` spawns the hidden `_web` command detached,
  works with `web.enabled` off (it then runs for this run only), and prints no
  token. `open` starts it if needed and opens the default browser (through `cmd /c start`) on `/#k=<token>`. `stop`
  signs in with the token and asks the server to stop. The server needs the built app in `dist/web` (`npm run build`).
- **Server** (`src/host/web/`): `node:http` and `ws` (bundled, `bundleDependencies`), on `127.0.0.1` only. The token, pid
  and port are in `<storage>\web\server.json`, in a folder made private with `protectPrivateFolder`. Login is
  `POST /api/login` (constant-time compare; 8 wrong tries within a minute lock it for a minute), cookie `sbxweb`
  (`HttpOnly`, `SameSite=Strict`, 12 hours unused). Calls that change something need the `X-Sandbox-Web: 1` header and
  an `Origin` that is the page; the WebSocket needs the cookie and that `Origin`; every request needs a loopback
  `Host`. The CSP is `default-src 'self'` with scripts only from the server; styles may be inline because xterm.js
  sets them.
- **API:** `GET /api/info` (sandbox state, owner line, agents, projects), `GET /api/sessions` (no attach address or
  token), `POST /api/sessions` `{harness, project}` (an agent in a project the running sandbox has), `POST /api/stop`,
  `WS /api/sessions/:id/terminal?cols=&rows=`, and `WS /api/rpc` (below).
- **RPC socket** (`WS /api/rpc`, `host/web/rpc.ts`): the same Origin and cookie checks as a terminal, at most 8 per
  server and 32 open calls or subscriptions per socket. Every message is checked against the kernel's zod schemas
  (`src/app/kernel/rpc.ts`); anything else (binary, not JSON, unknown fields, a bad id) closes the socket with 1008. Only
  definitions registered in `src/app/registry.ts` whose `surfaces` include the web run (`createRpcHost`); their input
  and output are checked like on every surface. Questions an operation asks go to the browser and its answer is checked
  against the question's kind (anything else counts as no); a browser that leaves mid-question answers no. Errors reach
  the browser as message and fix; a bug says only "Something went wrong." Live queries are read again at their
  `live.everyMs` and sent only when the result changed. Outputs never carry an attach token, and secrets are `***`. Sharing rules: nothing of another user's sandbox unless it is shared
  (`ownerRule`, `use`); restarting and launching are not offered. The address check is the backend's
  (`hostEndpoint` in `host/channel/attach.ts`, `isSandboxAddress`); the bridge connects to what it is given.
- **Terminal socket:** browser to server, binary = keystrokes, text = `{t:'resize',cols,rows}` (anything else closes it
  with 1008); server to browser, binary = output (through the same `OutputFilter` as `attach`, so OSC 52 never
  arrives), text = `ready` / `restarting` / `exit` / `error`. The server sends HELLO with the session token and PING
  every 5 s, holds output back when the browser is slow and closes it after a minute.
- **App** (`web/`, React 18, Mantine 7 with its static stylesheets (no CSS-in-JS script, so the CSP holds), TanStack
  Query, xterm.js; bundled by `scripts/bundle-web.mjs` into `dist/web` with hashed names): a shell with the menu's
  sections down the left (a section that is not in the web UI yet says where it is), each page a view of the shared
  core drawn from its Page (`web/src/render`), operations with their questions as modals and their progress and result
  as notifications, the terminal page (fit, reconnect with backoff, back / detach), the new-session dialog, light or
  dark with the OS. Links in the terminal (OSC 8 only) ask before opening.
- **Tests:** `npm test web` (`src/selftest/web.test.ts`): login, Host / Origin / CSRF, path traversal, sessions without
  tokens, the bridge against a fake ptyhost, and the RPC socket against a fake host (checks, questions, errors, live
  queries, refusals). `npm test app` covers the shared core it serves.
