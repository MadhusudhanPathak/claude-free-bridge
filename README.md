# Claude Free Bridge

A local HTTP bridge that lets coding agents and other Anthropic-API-compatible tools talk to an
authenticated `claude.ai` web session, driven via Playwright. It exposes a small
Anthropic-compatible API, a CLI for authentication and debugging, and an optional desktop
control panel.

## Overview

Claude Free Bridge runs on your machine and acts as a translator:

```text
coding agent  --(Anthropic-style HTTP)-->  Bridge  --(browser automation / cookie auth)-->  claude.ai
```

It maintains one authenticated browser/session at a time (claude.ai does not support
concurrent sessions well), queues incoming requests FIFO, and automatically pauses and
triggers re-authentication if the session expires mid-use.

Because it depends on scraping/driving claude.ai's web UI, it is inherently more fragile than
an official API and can break if Claude changes its UI or bot-detection. Two authentication
strategies are supported to reduce that risk — see [Authentication](#authentication) below.

## Prerequisites

- Node.js 18+ and npm
- A `claude.ai` account you can log into interactively
- (Optional, for the desktop GUI) Python 3.8+ and PyQt5

## Setup

```bash
git clone <this-repo>
cd claude-free-bridge
npm install
npx playwright install        # downloads Playwright's bundled Chromium
npm run build
```

## Authentication

Sessions are stored as named **accounts** (`session/accounts.ts`), so you can hold several
claude.ai logins side by side and switch between them. There are three ways to get a session
into an account:

### 1. Interactive login (primary)

Opens a real browser window, you log into claude.ai normally, and the session is captured
automatically the moment login completes — no manual steps beyond logging in:

```bash
node dist/index.js list-browsers                # see what's detected on this machine
node dist/index.js auth-login work --browser chrome
```

### 2. Import from a real browser (alternate — no browser window opens)

Log into claude.ai normally in Chrome, Edge, or Brave, then let the bridge read the `sessionKey`
cookie directly out of that browser's own (encrypted) cookie database instead of logging in
fresh:

```bash
node dist/index.js list-cookie-browsers            # see what's detected on this machine
node dist/index.js list-cookie-profiles chrome      # see profiles within a browser
node dist/index.js auth-import-browser work --browser chrome --profile Default
```

Newer Chrome profiles protected by "App-Bound Encryption" (v20 cookies) can't be decrypted
directly; this falls back automatically to briefly relaunching that browser headless against a
throwaway copy of the profile and reading the cookie back through it — still no page is ever
navigated to claude.ai.

### 3. Manual session import (works anywhere, including other OSes/browsers)

Log into claude.ai in your own regular browser, then in DevTools open
**Application → Storage → Cookies → `https://claude.ai`** and copy the `sessionKey` value:

```bash
node dist/index.js auth-set-session "sk-ant-sid01-..."          # saves/activates the "default" account
node dist/index.js auth-set-session "sk-ant-sid01-..." --account work   # saves as a named account
```

### Managing accounts

```bash
node dist/index.js auth-accounts        # list saved accounts, marks the active one
node dist/index.js auth-use work        # switch the active account
node dist/index.js auth-remove-account work
```

Verify the active session works:

```bash
node dist/index.js auth-info
```

If a stored session goes stale (expired/revoked), the API server pauses its request queue and
waits — there is no automatic re-login. Re-run `auth-login`/`auth-set-session`/`auth-import-browser`,
or `auth-use` another saved account, and the queue resumes automatically.

## Running the server

```bash
node dist/index.js serve --host 127.0.0.1 --port 8080
```

```bash
curl http://127.0.0.1:8080/v1/models

curl -X POST http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-3.5-web","messages":[{"role":"user","content":"Say hello"}],"stream":false}'

curl -N -X POST http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-3.5-web","messages":[{"role":"user","content":"Stream test"}],"stream":true}'
```

Point a coding agent's Anthropic base URL at `http://127.0.0.1:8080` and use model id
`claude-3.5-web` (the model field is otherwise ignored — every request goes to whatever
account is currently authenticated).

## CLI reference

| Command | Purpose |
| --- | --- |
| `auth-login [accountName] [--browser <id>]` | Primary: open a real browser window, log in normally, session captured automatically |
| `list-cookie-browsers [--json]` | List browsers whose cookie DB can be read for `auth-import-browser` |
| `list-cookie-profiles <browserId> [--json]` | List profiles within a browser (see above) |
| `auth-import-browser <name> [--browser] [--profile]` | Alternate: read the sessionKey cookie directly from a real browser, save as account `<name>` |
| `auth-set-session <sessionKey> [--account <name>]` | Manual: import a session cookie by pasting it |
| `auth-accounts [--json]` | List saved accounts and which one is active |
| `auth-use <name>` | Switch the active account |
| `auth-remove-account <name>` | Delete a saved account |
| `auth-info` | Show `lastActiveOrg`/`account_profile` for the active session |
| `auth-clear` | Clear the active session (saved accounts are untouched) |
| `auth-export [path]` | Export `auth.json` (sensitive — contains session cookies) |
| `list-browsers [--json]` | List real installed browsers the transport can drive to talk to claude.ai |
| `probe [prompt] [--headed]` | Send one prompt via the transport, for debugging |
| `serve [--host] [--port]` | Start the HTTP API server |
| `telemetry --on\|--off` | Toggle file logging to `~/.claude-free-bridge/bridge.log` |
| `run [task] [--workspace] [--yes]` | Experimental agent loop with file/shell tool-use |

## Architecture

```text
src/
  index.ts              CLI entry point (commander)
  api.ts                 HTTP server: request queue, auth-invalid pause/resume, SSE streaming
  logger.ts              Console + optional file logging
  config/
    paths.ts             Single source of truth for ~/.claude-free-bridge/* paths
  session/
    auth.ts              Cookie-based HTTP auth for the active account (no login automation)
    accounts.ts           Named account slots — save/switch/remove saved sessions
    cookieExtract.ts       Reads sessionKey straight out of a real browser's cookie DB (DPAPI on Windows)
    orgStore.ts           Cache of known organization ids
    browsers.ts           Detects installed Chrome/Edge/Brave/Firefox for the transport to drive
  transport/
    playwright.ts         Drives claude.ai: submits prompts, polls for replies (API-first, DOM fallback)
  orchestrator/
    loop.ts               Experimental single-pass agent loop
    context.ts             Bounded conversation history with naive summarization
  parser/
    xml.ts                Extracts <tool_use> blocks from assistant replies
  tools/
    fs.ts, diff.ts, shell.ts   File/diff/shell primitives used by the agent loop
    registry.ts             Dispatches a parsed tool call to the right primitive
  db/
    sqlite.ts              Conversation persistence (sqlite if available, JSON file otherwise)
```

See [AGENTS.md](AGENTS.md) for a description of each component's responsibilities and how
they interact.

Other entry points:

- `claude_bridge_gui.py` — optional PyQt5 desktop panel that wraps the CLI (build, account
  import/switch/remove, serve/stop, probe, API smoke test, integration tests) with one-click
  buttons
- `integration-runner.js` — builds on the `serve` command to exercise `/health` and both
  streaming/non-streaming chat completions end-to-end

### Design notes

- **Two ways in, one account model**: `session/accounts.ts` stores every session — however it
  was obtained — as a named, switchable slot rather than one global login, mirroring the
  per-account model in [lugia19/Claude-Usage-Extension](https://github.com/lugia19/Claude-Usage-Extension)
  (multiple claude.ai accounts side by side via `auth-accounts`, `auth-use`, `auth-remove-account`).
  `auth-login` gets there by driving a real login flow; `auth-import-browser` gets there without
  opening a browser at all, by reading a session that's already logged in — ported from that same
  extension, which runs inside a browser the user is already logged into and reads the session
  straight out of its cookie jar via `browser.cookies.get(...)`. `session/cookieExtract.ts` is the
  direct Node equivalent for a standalone process.
- **Single-session queue, manual re-auth**: `api.ts` processes requests one at a time (FIFO)
  since claude.ai's web UI doesn't support concurrent input into one session. On an auth failure
  it pauses the queue and waits — there is no automatic re-login — until the operator fixes the
  session via `auth-login`, `auth-set-session`, `auth-import-browser`, or `auth-use`, at which
  point the queue resumes automatically without dropping the in-flight request.
- **Cookie-based HTTP over browser automation once a session exists**: `fetchWithAuth` and
  `getLastActiveOrg` in `session/auth.ts` make plain HTTP requests carrying the stored session
  cookie rather than launching a browser. A valid session cookie reads as a normal returning
  user to claude.ai, which is both faster and less likely to trigger bot-detection than
  navigating an automated browser.
- **Real browser binaries wherever a browser has to be driven**: `session/browsers.ts` detects
  and prefers a real installed Chrome/Edge/Brave over Playwright's bundled Chromium — for
  `auth-login`'s login window, for the App-Bound Encryption fallback in `cookieExtract.ts`, and
  for the transport submitting prompts into the claude.ai web UI — since a real browser
  fingerprint is less likely to be challenged.

## Desktop GUI

```bash
pip install PyQt5
python claude_bridge_gui.py
```

Provides buttons for build, logging in via a real browser window (primary), importing a session
from an already-logged-in browser or by pasting a cookie (alternates), switching/removing saved
accounts, start/stop server, a one-off probe, an API smoke test, and running the integration
suite — each streams its command's output into the panel's log view.

## Development

```bash
npm run dev          # run the CLI directly from TypeScript via ts-node
npm run build         # compile src/ to dist/
npm run integration   # build first, then run the end-to-end integration checks
```

## Security notes

- `~/.claude-free-bridge/auth.json` contains session cookies — treat it like a credential.
  Restrict filesystem permissions on that directory and never commit it.
- Bind the HTTP API to `127.0.0.1` unless it sits behind a reverse proxy that enforces its own
  authentication and TLS.
