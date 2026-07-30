Claude Free Bridge — MVP scaffold

This repository implements a Playwright-backed bridge for interacting with Claude sessions through an authenticated browser context. Recent updates add a robust auth system, multi-profile support, telemetry, and an integration helper for headless testing.

What this repo provides now
- CLI entry (src/index.ts) with auth management and probe commands
- Playwright transport (src/transport/playwright.ts) that prefers API-driven conversation retrieval with DOM fallback
- Playwright-backed auth helpers (src/session/auth.ts): persistent storageState, per-org profiles, programmatic in-page fetch, and re-auth handling
- Known-orgs store (src/session/org_store.ts) to remember discovered orgs across runs
- Lightweight telemetry/logger (src/logger.ts) controlled by env or CLI
- Integration-runner (integration-runner.js) for local integration checks

Quick install & build
1. npm install
2. npx playwright install
3. npm run build
4. npm start  (or use the CLI: node dist/index.js <command>)

Basic CLI usage
- node dist/index.js auth-info [--login]
  - Shows lastActiveOrg and account_profile. Use --login to open a headed login flow and save storageState.
- node dist/index.js auth-export [path?]
  - Export current auth.json for inspection (sensitive). If no path provided prints to stdout.
- node dist/index.js auth-clear [--profile]
  - Delete saved auth.json. Add --profile to remove the org-specific profile directory.
- node dist/index.js probe "Hello" [--headed]
  - Sends a single prompt using the Playwright transport. Attempts API-driven response retrieval; falls back to DOM scraping.
- node dist/index.js telemetry --on|--off
  - Enable or disable file telemetry logging (writes to %USERPROFILE%\.claude-free-bridge\bridge.log when enabled).

Integration helper
- npm run integration
  - Runs integration-runner.js (requires build). The runner exercises known orgs and attempts lightweight headless probes when a pre-seeded profile exists.

Auth and profiles (important)
- Persistent storageState (auth.json) is saved under: %USERPROFILE%\.claude-free-bridge\
- Per-org profiles are saved under: %USERPROFILE%\.claude-free-bridge\profiles\<orgId>\
- The system prefers a per-org profile if available. Use auth-info --login to create a profile interactively.
- auth.json contains session cookies and is sensitive. Do not commit it.

Telemetry and debugging
- Enable with: set CLAUDE_FB_TELEMETRY=1 (Windows cmd) or $env:CLAUDE_FB_TELEMETRY=1 (PowerShell), or use the telemetry CLI command.
- When enabled logs are appended to %USERPROFILE%\.claude-free-bridge\bridge.log. Logs include debug traces for fetchWithAuth, conversation polling, and known-org updates.

Security and privacy notes
- auth.json stores authenticated cookies/localStorage. Treat as secrets — store securely or integrate OS keychain for production use.
- The bridge uses browser-authenticated sessions (cookies), not user-supplied API keys.
- API endpoints used are the same internal endpoints observed from the web UI; these can change and the code falls back to DOM scraping if needed.

Development notes
- Run npx tsc -p tsconfig.json to compile TypeScript sources to dist/ before running CLI/runner.
- Keep .claude-free-bridge/ in .gitignore (this repo already ignores it).

If you want a profile-management UI or OS keychain integration next, open an issue or ask to implement the CLI to list/select/delete profiles.
