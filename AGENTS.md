# Components

This document describes each component in Claude Free Bridge: its responsibility, its
boundaries, and how it talks to the others. "Agent" here is used loosely — most of these are
plain modules, not autonomous agents — with the exception of the orchestrator, which drives an
actual tool-use loop.

## CLI (`src/index.ts`)

**Role:** single entry point for every operator-facing command (auth, serve, probe, run,
telemetry). Built on `commander`.

**Boundaries:** contains no business logic itself — every action delegates immediately to
`session/auth.ts`, `session/browsers.ts`, `transport/playwright.ts`, `orchestrator/loop.ts`, or
`api.ts`. Its job is argument parsing, user-facing output (`console.log`/`console.error`), and
process exit codes.

## HTTP API server (`src/api.ts`)

**Role:** exposes an Anthropic-Messages-compatible subset over HTTP (`/health`, `/v1/models`,
`/v1/chat/completions`) so external coding agents can talk to the bridge like they would talk
to the real Anthropic API.

**Boundaries:** owns the `RequestQueue`, a single-worker FIFO queue that serializes all chat
requests — this exists because `transport/playwright.ts` can only drive one claude.ai session
at a time. When a request fails with `AuthInvalidError`, the queue pauses itself, calls
`ensureAuth` (interactive re-login), then resumes and retries the same request. It validates
request bodies before handing them to the queue but has no knowledge of how prompts are
actually delivered to claude.ai — that's the transport's job.

## Transport (`src/transport/playwright.ts`)

**Role:** the only component that actually talks to claude.ai's UI. Given a prompt, it submits
it into the web composer and returns the assistant's reply, optionally streaming incremental
deltas via an `onChunk` callback.

**Boundaries:** prefers polling claude.ai's internal conversation API (via `fetchWithAuth`) for
retrieving replies, since that is more deterministic than reading the DOM; DOM scraping is a
fallback. It depends on `session/auth.ts` for credentials but has no opinion on how those
credentials were obtained (interactive login vs. imported cookie look identical to it). If it
cannot find the message composer, it fails fast with a screenshot rather than silently
returning nothing.

## Session subsystem (`src/session/`)

**`auth.ts`** — owns everything about the stored session: `auth.json` (Playwright storageState
format) on disk, direct HTTP requests carrying the session cookie (`fetchWithAuth`,
`getLastActiveOrg`), and driving an interactive login browser (`ensureAuth`/`ensureAuthForOrg`)
when no valid session exists. Throws `AuthInvalidError` when the server rejects the stored
cookie (401/403), which is the signal `api.ts`'s queue watches for.

**`browsers.ts`** — pure detection: locates real installed Chrome/Edge/Brave/Firefox binaries
on disk so `auth.ts` can drive one of them instead of Playwright's bundled Chromium. Has no
dependency on any other module in the project.

**`orgStore.ts`** — a small TTL-based cache of organization ids the bridge has seen, so
`getLastActiveOrg` doesn't need to hit the network every time. Depends only on the logger.

**Boundary rule:** nothing outside `session/` writes to `auth.json` or reads cookies directly —
every other module goes through `auth.ts`'s exported functions.

## Orchestrator (`src/orchestrator/`)

**`loop.ts`** — an experimental single-pass agent loop (`agentLoop`): sends a task prompt via
the transport, parses any `<tool_use>` blocks out of the reply, executes them through
`tools/registry.ts`, and persists the conversation. It does not loop back with tool results for
a second turn yet (documented MVP limitation).

**`context.ts`** — `ContextComposer` tracks message history for one run and applies a naive
summarization once history grows past a threshold, so prompts stay bounded in size. Pure
in-memory state; no I/O.

**Boundary rule:** the orchestrator is the only caller of `tools/registry.ts` — tools are never
invoked directly by the CLI or API server.

## Parser (`src/parser/xml.ts`)

**Role:** extracts `<tool_use><tool_name>...</tool_name><parameters>...</parameters></tool_use>`
blocks out of raw assistant text. Pure function, no side effects, no dependencies on other
modules.

## Tools (`src/tools/`)

**`fs.ts`, `diff.ts`, `shell.ts`** — the actual primitives an agent run can invoke: read/write/
list files, apply a unified-diff or search/replace patch, run a shell command. Each validates
its own inputs and returns a typed success/error result rather than throwing, so a bad tool
call degrades to an error result instead of crashing the loop. `shell.ts` refuses commands
matching a small destructive-pattern denylist unless the caller explicitly confirms.

**`registry.ts`** — the only place that maps a parsed `ToolUse` to one of the primitives above.
Adding a new tool means adding one case here and one new primitive module; nothing else needs
to change.

**Boundary rule:** primitives never call each other or the registry — only the registry calls
primitives.

## Persistence (`src/db/sqlite.ts`)

**Role:** stores conversation/message history for `orchestrator/loop.ts`. Uses `better-sqlite3`
if it happens to be installed, otherwise transparently falls back to a JSON file — callers
never need to know which backend is active.

**Boundary rule:** the only consumer is `orchestrator/loop.ts`; the API server and transport
have no persistence of their own.

## Configuration (`src/config/paths.ts`)

**Role:** the single source of truth for every path under `~/.claude-free-bridge/` (auth file,
profile directories, known-orgs cache, db file, log file). Every other module imports paths
from here rather than constructing them independently.

## Logger (`src/logger.ts`)

**Role:** structured console logging plus optional file logging (toggled via the `telemetry`
CLI command or `CLAUDE_FB_TELEMETRY=1`). Used for internal diagnostics; CLI user-facing output
still goes through `console.log`/`console.error` directly, since that's a different concern
(operator communication vs. diagnostic trace).

## Desktop GUI (`claude_bridge_gui.py`)

**Role:** a PyQt5 panel that wraps the CLI commands above (build, authenticate with a browser
picker, import a session cookie, start/stop the server, run a probe, smoke-test the chat API,
run the integration suite) so they can be triggered with a click instead of a terminal.

**Boundaries:** it shells out to the same `dist/index.js` CLI everything else uses — it holds
no bridge logic of its own, only process management and log display.

## Integration runner (`integration-runner.js`)

**Role:** end-to-end smoke test. Starts the built server, waits for `/health`, and — if a
stored session exists — exercises both a non-streaming and a streaming `/v1/chat/completions`
call against the real transport.
