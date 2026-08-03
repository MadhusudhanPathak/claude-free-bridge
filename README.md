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

Two ways to authenticate, depending on whether claude.ai's bot-detection challenges you:

### 1. Interactive login (default)

```bash
node dist/index.js auth-info --login
```

This detects browsers installed on your machine (Chrome, Edge, Brave, or falls back to
Playwright's bundled Chromium) and lets you pick one. It opens that browser, you log in
normally, and the session is captured automatically the moment login completes — no manual
steps beyond logging in.

```bash
node dist/index.js list-browsers   # see what's detected on this machine
```

### 2. Manual session import (fallback, if you hit a bot-detection wall)

Log into claude.ai in your own regular browser, then in DevTools open
**Application → Storage → Cookies → `https://claude.ai`** and copy the `sessionKey` value:

```bash
node dist/index.js auth-set-session "sk-ant-sid01-..."
```

Verify either method worked:

```bash
node dist/index.js auth-info
```

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
| `list-browsers [--json]` | List browsers detected on this machine |
| `auth-info [--login] [--browser <id>]` | Show `lastActiveOrg`/`account_profile`; `--login` runs interactive auth |
| `auth-set-session <sessionKey>` | Import a session cookie manually |
| `auth-clear [--profile]` | Delete stored auth (and optionally the browser profile) |
| `auth-export [path]` | Export `auth.json` (sensitive — contains session cookies) |
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
    auth.ts              Session storage, interactive login, cookie-based HTTP auth
    browsers.ts           Detects installed Chrome/Edge/Brave/Firefox for login
    orgStore.ts           Cache of known organization ids
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

- `claude_bridge_gui.py` — optional PyQt5 desktop panel that wraps the CLI (build, auth,
  serve/stop, probe, API smoke test, integration tests) with one-click buttons
- `integration-runner.js` — builds on the `serve` command to exercise `/health` and both
  streaming/non-streaming chat completions end-to-end

### Design notes

- **Single-session queue**: `api.ts` processes requests one at a time (FIFO) since claude.ai's
  web UI doesn't support concurrent input into one session. On an auth failure it pauses the
  queue, triggers re-authentication, then resumes without dropping the in-flight request.
- **Cookie-based HTTP over browser automation where possible**: `fetchWithAuth` and
  `getLastActiveOrg` in `session/auth.ts` make plain HTTP requests carrying the stored session
  cookie rather than launching a browser. A valid session cookie reads as a normal returning
  user to claude.ai, which is both faster and less likely to trigger bot-detection than
  navigating an automated browser.
- **Real browser binaries for login**: `session/browsers.ts` detects and prefers a real
  installed Chrome/Edge/Brave over Playwright's bundled Chromium for the one step that still
  needs a browser (interactive login), since a real browser fingerprint is less likely to be
  challenged.

## Desktop GUI

```bash
pip install PyQt5
python claude_bridge_gui.py
```

Provides buttons for build, authenticate (with a browser picker), manual session import,
start/stop server, a one-off probe, an API smoke test, and running the integration suite —
each streams its command's output into the panel's log view.

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
