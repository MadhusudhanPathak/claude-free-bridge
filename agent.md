Agent checkpoint — claude-free-bridge
Timestamp: 2026-07-31T02:00:00+00:00

Summary of progress
- Evolved the Playwright-backed bridge into a small local HTTP API that proxies Anthropic-style chat completion requests to an authenticated Claude web session.
- Implemented streaming (robust, API-driven incremental deltas) and a single-worker FIFO queue to respect the single-browser session constraint.
- Added automatic re-auth handling that pauses the queue on auth invalidation (E_AUTH_INVALID), launches an interactive re-auth flow, and resumes processing.
- Added a minimal PyQt GUI for quick inspection and control, and extended the integration-runner to exercise the API (including streaming).

Design & behaviour
- Transport (src/transport/playwright.ts): prefers API polling (fetchWithAuth) for deterministic retrieval of conversation messages; falls back to DOM polling/scraping if the API is unavailable. Exposes an onChunk callback for streaming deltas.
- API server (src/api.ts): provides /health, /v1/models and /v1/chat/completions. Supports stream:true (SSE) and stream:false responses. Uses a single-worker FIFO queue and pauses for re-auth when necessary.
- Auth (src/session/auth.ts): unchanged in behaviour — storageState-based authentication, fetchWithAuth for in-session requests, and ensureAuth to trigger interactive login. On 401/403 fetchWithAuth clears stored auth and raises E_AUTH_INVALID which the queue detects.
- Streaming: implemented conservatively by detecting and forwarding incremental growth of the assistant message (API-driven), avoiding brittle low-level network interception.

Integration tests
- integration-runner.js now:
  - Starts the built server (dist/index.js serve)
  - Waits for /health
  - Executes a non-streaming chat probe and validates response shape
  - Executes a streaming chat probe and validates reception of at least one data chunk and a final stop event
  - Stops the server and returns success/failure

How to reproduce locally
1. npm install
2. npx playwright install
3. npm run build
4. node dist/index.js auth-info --login  (complete interactive login)
5. node dist/index.js serve --host 127.0.0.1 --port 8080
6. Use curl or a coding agent pointed at http://127.0.0.1:8080/v1 to exercise the API
7. Run npm run integration to execute the built integration tests

Notes, limitations & next steps
- The streaming implementation trades absolute minimum latency for robustness and maintainability; it is intentionally non-brittle.
- The re-auth mechanism is interactive (requires user to complete a login flow in a browser). This keeps the system simple and avoids storing credentials.
- Recommended next work: add OS keychain integration for storageState, add optional GUI features (queue view, start/stop server), add unit tests for session helpers.

Saved-by: copilot-cli
