Agent checkpoint — claude-free-bridge
Timestamp: 2026-07-30T19:48:21.394+02:00

Summary of progress
- Project scaffolded (TypeScript) and evolved into a Playwright-backed bridge with CLI controls.
- Major additions since last checkpoint:
  - Playwright-backed auth system with persistent storageState and per-org profiles
  - Programmatic in-page fetch (fetchWithAuth) that runs requests inside an authenticated page
  - Known-org store (TTL) to remember discovered organizations across runs
  - Transport upgrades to prefer API-driven conversation retrieval (with DOM fallback)
  - Telemetry/logger and an integration-runner for headless checks
  - CLI commands for auth management, probes, telemetry toggling, and basic integration scripting

What failed / outstanding
- The conversation API endpoints used are private-facing and may change; code falls back to DOM scraping when necessary.
- StorageState files are sensitive and currently stored unencrypted on disk. OS keychain integration is recommended for production builds.

Auth & profile highlights
- Persistent storageState is saved automatically after an interactive login and may be stored either in the root auth.json or per-org under profiles/<orgId>/auth.json.
- Profiles root: %USERPROFILE%\.claude-free-bridge\profiles\<orgId>\
- getLastActiveOrg() uses a cookie fast-path then falls back to querying account_profile endpoints inside the authenticated page.
- fetchWithAuth(url, opts) executes fetch inside the Playwright page (credentials: include) so cookies/localStorage are honored.
- On 401/403, fetchWithAuth clears stored auth for the affected profile and throws an error with code E_AUTH_INVALID so callers can re-auth.

Files of interest
- src/session/auth.ts         — ensureAuthForOrg, ensureAuth, fetchWithAuth, profile helpers, clear/export helpers
- src/session/org_store.ts    — known-org TTL store (add/get/remove/clear)
- src/transport/playwright.ts — sendPromptViaPlaywright: prefers API conversation fetch, falls back to DOM scraping
- src/logger.ts               — telemetry-controlled logger (file + console)
- src/index.ts                — CLI: auth-info, auth-export, auth-clear, probe, telemetry
- integration-runner.js       — local integration helper that exercises known orgs (requires built dist)
- auth_version_01.md          — archived previous auth implementation (kept for reference)

Resume checklist / next steps
1) Build and test locally:
   - npm install
   - npx playwright install
   - npm run build
2) Create a profile / authenticate interactively:
   - node dist/index.js auth-info --login
   - Complete the browser login and navigate to /chat. The CLI will detect /chat and save storageState to the profile.
3) Test probe:
   - node dist/index.js probe "Hello" --headed
   - If on a conversation URL and org is known the transport will poll the conversation API; otherwise it will scrape the DOM.
4) Run integration runner (after build):
   - npm run integration
   - This exercises known orgs and validates account_profile for the first known org if a profile exists.

Recommended next work
- Add explicit CLI to list/select/delete profiles (user-facing multi-profile selection)
- Integrate OS keychain / credential store to encrypt auth.json at rest
- Add unit tests for org_store and logger, and a CI integration job that runs integration-runner with pre-seeded credentials (requires secure secret handling)
- Harden API polling with better backoff, and optionally intercept network requests for deterministic conversationId detection

Security considerations
- auth.json contains session cookies and is sensitive — do NOT commit it. The repo .gitignore already excludes .claude-free-bridge/.
- Consider migrating sensitive storage to OS keychains before shipping to end users.

Saved-by: copilot-cli
