# Components

This document describes each component in Claude Free Bridge: its responsibility, its
boundaries, and how it talks to the others. The product has two halves joined by one local
WebSocket:

- the **app** (`packages/helper`, Node; shipped as `ClaudeFreeBridge.exe` or run from npm/source):
  serves the HTTP API that other apps call, and the **Control Center** page users set things up in;
- the **extension** (`packages/extension`, Manifest V3, Chromium): runs inside the user's
  logged-in browser and is the only part that talks to claude.ai.

Both import their shared types and helpers from `packages/shared/src/`.

```text
app/tool ──HTTP──▶ helper: http/server → adapters → SendQueue → ExtensionLink ══WS══▶
      extension: HelperLink → background (runJob) → tabRunner → content script → claude/* ──▶ claude.ai

user ──▶ Control Center (helper/ui, served by the helper) ──/ui/* + public API──▶ helper
```

## Build, tooling and release

| File | Role |
| --- | --- |
| `package.json` | One package for everything; also the npm package (`files` = bundled app + extension). No runtime dependencies (everything is bundled). Dev dependencies: `esbuild`, `typescript`, `ws`, `postject` and `rcedit` (exe), plus types. The `version` field is the single source of the release version. |
| `build.mjs` | esbuild bundles `helper/src/{cli,server}.ts` (Node/CommonJS, all dependencies inlined) to `packages/helper/dist/`. The Control Center (`helper/ui/main.ts` plus its HTML/CSS) is built during that bundle and embedded as the `virtual:ui-assets` module. It also bundles `extension/src/{background,content,sidepanel/panel}.ts` (browser/IIFE) to `packages/extension/dist/`, writes the manifest with the package version, and copies the side panel HTML/CSS and icons. `__VERSION__` is defined everywhere. |
| `scripts/release.mjs` | Windows + Node 22+. It builds and runs the tests, then turns `dist/cli.js` into `ClaudeFreeBridge.exe`: a Node single-executable app, with its icon and file details set by rcedit before postject injects the app. It smoke-tests the exe with `--version`, then writes `release/ClaudeFreeBridge-<v>-windows-x64.zip` (exe + `extension/` + `README.txt` + `LICENSE.txt`) and `release/claude-free-bridge-extension-<v>.zip`, using a built-in zip writer. |
| `tsconfig.base.json` | Shared strict settings, type-check only (`noEmit`); esbuild does the compiling. Unused locals and parameters are errors. |
| `tsconfig.helper.json` / `.extension.json` / `.ui.json` | Node types / DOM + Chrome types / DOM only. They're kept apart so globals can't leak into the wrong code. `shared/` is checked by all three. |

**Keep it lean:** no dead code or unused exports. Export something only if another module or a
test uses it. `npm run typecheck` must stay clean.

## Shared (`packages/shared/src/`)

Code here runs in Node, the extension and the Control Center, so it uses only APIs all three
have (no Node, DOM or Chrome specifics).

- **`protocol.ts`**: the single definition of every app↔extension WebSocket frame, the
  operations (`OpMap`: `send`, `listConversations`, `getConversation`, `createConversation`,
  `deleteConversation`, `status`), error codes, close codes, settings and status shapes.
- **`errors.ts`**: `BridgeFailure`, the error both sides throw (a protocol error code, a
  message and an optional `retryAfter`), and `toBridgeError()`, which turns anything thrown into
  its wire form.
- **`sse.ts`**: `readSseEvents()`, a server-sent events reader used for claude.ai's completion
  stream (extension) and the Playground's streamed replies (Control Center).
- **`text.ts`**: `shorten()` / `firstLine()` for chat names and activity labels.
- **`globals.d.ts`**: declares the build-time `__VERSION__`.

**Boundary rule:** any change to what crosses the WebSocket starts in `protocol.ts`. Bump
`PROTOCOL_VERSION` for incompatible changes; the app refuses mismatched extensions with a
message telling the user to load the extension that came with the app.

## App (`packages/helper/src/`)

**`cli.ts`**: entry point. With no command (double-click), it starts the app and opens the
Control Center:

- If the port is taken by a running copy of the app, it just reopens that copy's Control Center.
- If another program has the port, it explains, and waits for Enter so the console doesn't vanish.
- `serve` starts without a window. `token [--rotate]` and `status` are for servers and developers.

It holds no other logic.

**`app.ts`**: desktop behaviour:

- `findExtensionDir()`: next to the exe when running as `ClaudeFreeBridge.exe`, otherwise
  `packages/extension/dist`.
- `openWindow()`: an app-style Edge window on Windows, otherwise the default browser.
- `openFolder()` and `controlCenterUrl()`.

**`server.ts`**: `startHelper(config, appHooks)` wires `ExtensionLink`, `SendQueue` and the
HTTP server onto one port. `appHooks` (extension folder, `onQuit`, `saveConfig`, `openFolder`)
are what only the desktop app provides; the tests pass none. `cfg` may be changed in place
(key reset).

**`config.ts`**: the single source of truth for `~/.claude-free-bridge/` (`CLAUDE_FB_HOME`
overrides it) and `config.json`. On first run it generates the API key, the pairing code
(`pairingToken`) and the `uiToken`. Missing fields get defaults; a file that isn't valid JSON or
has a value of the wrong type is reported and never overwritten.

**`security.ts`**: constant-time secret comparison and the loopback-host check.

**`logger.ts`**: console logging; `CLAUDE_FB_DEBUG`, `CLAUDE_FB_LOG` and `CLAUDE_FB_QUIET`
control it.

**`extensionLink.ts`**: the app's end of the WebSocket at `/ext`.

- **Who may connect:** only `chrome-extension://` origins that send the pairing code in their
  first `hello` frame. After 10 wrong codes it refuses connections until restart.
- **One connection at a time:** a reconnect from the same `instanceId` replaces the old one;
  another browser is refused while the first still answers pings.
- **Untrusted input:** every frame is parsed and shape-checked; malformed frames are refused
  (handshake) or ignored (afterwards), never fatal.
- **Diagnostics:** it records `lastRejection`, so the Control Center can say "wrong pairing code".
- **Calls:** `call(op, params, {onChunk, signal, timeoutMs})` matches each request to its reply
  frames, and sends `cancel` on abort or timeout. `waitUntil()` waits for a condition (such as
  "connected" or "logged in") with a timeout and an abort signal.
- **Status:** it caches the extension's last reported status and emits
  `connected` / `disconnected` / `status`.
- **Key reset:** `setPairingToken()` switches codes and makes the connected extension pair again.

**`queue.ts`**: `SendQueue` runs `send` operations one at a time, in arrival order.

- **Expired login:** on `AUTH_INVALID` it holds that request, and everything behind it, until the
  extension reports `loggedIn: true`, then retries. It gives up after `authWaitMs`.
- **Missing extension:** it waits up to `connectWaitMs` for the extension to (re)connect.
- **No duplicate output:** once text has reached the client, it never retries.

Operations other than `send` skip the queue.

### HTTP layer (`packages/helper/src/http/`)

**`server.ts`**: routing and security checks, in this order:

1. The Host header must be a loopback name.
2. Any `Origin` header must be the app's own origin (the Control Center) or in `allowedOrigins`.
3. `/health`, the Control Center files and `/ui/*` (with its own token check) are open.
4. Everything else needs the API key.

It also handles WebSocket upgrades for `ExtensionLink`.

**`context.ts`**: `Ctx` (what every handler gets: config, app hooks, link, queue, in-flight map)
and `AppHooks`.

**`io.ts`**: request/response plumbing: JSON bodies (20 MB cap, objects only), `sendError()`
(maps error codes to HTTP status and adds `Retry-After`), client-disconnect aborts, and
`LazySse`, an SSE response whose headers go out with the first event, so a failure before any
text still gets a proper HTTP status.

**`models.ts`**: the `claude-web` default model, the model list, and which requested models
pass through to claude.ai (only those allowed in the extension's settings).

**`openai.ts`, `anthropic.ts`**: validate each API's request and convert between its request,
response, error and SSE formats and a `SendParams` with `source: 'api'`.

**`prompt.ts`**: flattens system text and message history into one prompt for a new
claude.ai chat, names that chat `API · …`, and estimates token counts.

**`bridge.ts`**: the `/bridge/*` endpoints for real claude.ai chats, plus the in-flight map
of request ids that `/bridge/cancel/:id` uses.

**`ui.ts`**: serves the embedded Control Center (`/`, `/ui.js`, `/ui.css`) with a strict
Content-Security-Policy that forbids framing. It also serves the Control Center's private API,
which only answers requests whose `x-cfb-ui` header matches `uiToken`:

- `GET /ui/session`: version, API key, pairing code, API URL, extension folder;
- `POST /ui/open-extension-folder` (through the `openFolder` app hook);
- `POST /ui/reset-keys`: new API key and pairing code, saved, and the extension made to pair again;
- `POST /ui/quit`.

**Boundary rules:**

- The app never handles claude.ai cookies or URLs; everything about claude.ai happens in the extension.
- HTTP handlers reach the extension only through `SendQueue` (for `send`) or `ExtensionLink`
  (for everything else).
- HTTP handlers don't touch the desktop directly; they go through `AppHooks`.
- Only `http/ui.ts` reveals secrets, and only to holders of the `uiToken`.

## Control Center (`packages/helper/ui/`)

**Role:** the window users work in. The app opens it as `/#ui=<uiToken>`. The page keeps the
token in `sessionStorage` and removes it from the address bar. Without a valid token it shows
a locked screen. It has three tabs:

- **Setup** (`main.ts`): three steps, ticked off by polling `/bridge/status` every 3 s:
  1. Add the extension (shows the folder, with Copy and Open buttons).
  2. Paste the pairing code. Done once the extension is connected; warns on `lastRejection`.
  3. Log in to claude.ai.

  When everything is done, it switches to the Playground the first time it loads.
- **Use with your apps** (`apps.ts`): API key (masked, Show/Copy), base URLs, model, copy-ready
  examples with the real key, and **Reset keys**.
- **Playground** (`playground.ts`): chat through the OpenAI / Anthropic / Bridge APIs with
  streaming, Stop, chat list (Bridge mode) and the raw HTTP of each request.
  `playgroundApi.ts` holds the per-API request and response formats, as pure functions.

The top bar shows live status and a **Quit** button. If the app stops responding, a banner
says so. `session.ts` holds the shared state (session, `uiToken`) and the fetch helpers;
`dom.ts` holds the small DOM helpers (element lookup, toast, copy, masking).

**Boundaries:** the Control Center is a client of the public HTTP API (with the session's API
key) plus `/ui/*`. It imports from `shared/` (types and the SSE reader), never app code.

## Extension (`packages/extension/src/`)

**`background.ts`**: the service worker and the extension's coordinator. Its `runJob` handles
every operation, whether it comes from the app or the side panel:

1. checks the `sessionKey` cookie;
2. gets the worker tab and picks the org;
3. runs the operation in the tab's content script (`tabRunner.ts`);
4. logs it to the activity list.

It also:

- tracks claude.ai login from cookie changes, content-script start-ups and auth failures;
- pushes `status` to the app and keeps the toolbar badge up to date;
- serves the side panel over a port;
- opens the panel as a welcome tab on first install, and as a tab in browsers without a side panel.

**`tabRunner.ts`**: `runInTab()` sends one operation to a tab's content script over a
`chrome.tabs.connect` port, streams chunks back, and disconnects the port on abort (which
aborts the fetch in the tab).

**`helperLink.ts`**: the extension's end of the WebSocket.

- **Handshake:** a `hello` with the pairing code.
- **Keepalive:** a `ping` every 20 s (WebSocket traffic keeps an MV3 service worker alive in
  Chromium 116+), reconnects with backoff, and a `chrome.alarms` check every 30 s.
- **Refused codes:** if the app refuses a pairing code (wrong code, version mismatch, too many
  attempts), it saves that in `store.refused` and doesn't retry it automatically, so it can't
  trip the app's lockout. A new code, or the user clicking Connect, clears this.
- **Busy app:** if another browser is connected, it retries slowly.

**`workerTab.ts`**: finds an open claude.ai tab, or opens a pinned background tab, and waits
for it to load. It marks the tab so the browser won't unload it, and injects the content script
into tabs opened before the extension was installed. Concurrent callers share one lookup.

**`content.ts`**: runs in claude.ai tabs. It receives jobs on a port, runs them through
`claude/`, posts back chunks and a result, and aborts the fetch if the port closes.

**`claude/`**: **the only code that knows claude.ai's internal endpoints and response
formats.** Its requests are same-origin fetches from the page, so they carry the page's
cookies. When claude.ai changes its API, this is the folder to fix.

- `http.ts`: the request helper, and mapping claude.ai's HTTP errors to protocol error codes;
- `account.ts`: the account, its organizations and plans;
- `conversations.ts`: listing, reading (current branch of the message tree), creating and deleting chats;
- `completion.ts`: sending a message and parsing the completion stream (the current
  `content_block_delta` format and the older `completion` format, including stream errors).

**`store.ts`**: saved state.

- `chrome.storage.local`: the connection (app address, pairing code, `instanceId`, `refused`) and settings.
- `chrome.storage.session`: the cached login/account, activity log and worker tab id.

**`sidepanel/`**: the side panel UI:

- a **Connect to the app** card until the extension is paired, or after a wrong code;
- status (app, claude.ai, requests), Test chat, Settings and Activity;
- **Advanced** (app address, new pairing code, disconnect).

It talks only to `background.ts` over the `cfb-panel` port and holds no logic of its own.

**`messages.ts`**: types for messages inside the extension (service worker ↔ content script,
service worker ↔ side panel).

**Boundary rules:** only `claude/` builds claude.ai API requests, and only the content
script runs them. Only `background.ts` decides login state. The side panel never calls Chrome
APIs that change state; it sends commands.

## Tests

- `packages/helper/test/helper.test.mjs`: the real app (HTTP + WebSocket) against a
  `FakeExtension` that implements the extension's side of the protocol. Covers:
  - access control: keys, origins, Host header, pairing, the second-browser rule, and malformed frames;
  - both compatible APIs, streaming and non-streaming;
  - queue order, holding requests until login, and cancellation;
  - the bridge endpoints;
  - the Control Center's token-gated `/ui/*`, including key reset;
  - the settings file: first-run creation, and broken files left untouched (runs the built CLI).
- `packages/extension/test/completion.test.mjs`: the claude.ai completion-stream parser,
  bundled on the fly.

`npm test` builds and runs both. Nothing in the test suite touches a real browser or claude.ai.
`npm run release` runs them again before packaging.
