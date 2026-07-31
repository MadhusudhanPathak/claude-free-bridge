Claude Free Bridge — MVP scaffold

This repository implements a Playwright-backed bridge that lets local coding agents interact with an authenticated Claude web session. It provides a small HTTP API (Anthropic-compatible subset), a Playwright transport that drives Claude's web UI / internal APIs, an auth system based on Playwright storageState, a minimal PyQt control panel, and integration tests.

What this repo provides now
- CLI entry (src/index.ts) with auth management, server (serve), and probe commands
- HTTP API (src/api.ts) exposing:
  - GET /health  — checks whether a stored authenticated session appears available
  - GET /v1/models — returns a model list ("claude-3.5-web") for compatibility
  - POST /v1/chat/completions — accepts Anthropic-style requests and proxies them to the Playwright transport. Supports stream: true (SSE) and stream: false (full response)
- Playwright transport (src/transport/playwright.ts) that prefers API-driven conversation polling with DOM fallback, and supports an onChunk callback for streaming deltas
- Playwright-backed auth helpers (src/session/auth.ts): persistent storageState, per-org profiles, programmatic in-page fetch (fetchWithAuth), and re-auth handling
- Automatic re-auth flow and queue pause/resume when stored sessions expire (E_AUTH_INVALID)
- Minimal PyQt control panel (claude_bridge_gui.py) for quick interactive actions and status overview
- Integration tests (integration-runner.js) that start the server and verify non-stream and stream behavior

Quick install & build
1. git clone ... && cd claude-free-bridge
2. npm install
3. npx playwright install
4. npm run build

Run the CLI
- Use built CLI after build: node dist/index.js <command>
- Useful commands:
  - auth-info [--login] — show lastActiveOrg and account_profile; --login opens a headed interactive login and saves storageState
  - auth-export [path?] — export the stored auth.json (sensitive)
  - auth-clear [--profile] — clear stored auth.json; --profile removes the Playwright profile directory as well
  - probe [prompt] [--headed] — sends a single prompt via Playwright transport (debugging)
  - serve [--host 127.0.0.1] [--port 8080] — start the HTTP API server
  - telemetry --on|--off — toggle file telemetry

HTTP API usage (examples)
- GET /v1/models
  curl http://127.0.0.1:8080/v1/models

- Non-streaming completion:
  curl -X POST http://127.0.0.1:8080/v1/chat/completions \
    -H "Content-Type: application/json" \
    -d '{"model":"claude-3.5-web","messages":[{"role":"user","content":"Say hello"}],"stream":false}'

- Streaming completion (SSE):
  curl -N -X POST http://127.0.0.1:8080/v1/chat/completions \
    -H "Content-Type: application/json" \
    -d '{"model":"claude-3.5-web","messages":[{"role":"user","content":"Stream test"}],"stream":true}'

Design choices and robustness
- Streaming is implemented by polling Claude's conversation API (via fetchWithAuth) when available and by DOM polling otherwise. It emits incremental deltas when the assistant's message grows. This approach is intentionally conservative and avoids brittle CDP/SSE interception inside the browser.
- Single-session constraint: the server uses a single-worker FIFO queue so browser input races are avoided. On session expiry the queue pauses, triggers interactive re-auth, and resumes — preserving requests.

Deployment recommendations (simple and robust)
- Requirements:
  - Node 18+ and npm
  - Playwright browsers: after npm install run npx playwright install
  - For GUI: Python 3.8+ and PyQt5 (pip install PyQt5)

- Production (recommended): Run the server as a managed process with PM2 or systemd so it restarts automatically.
  - Using PM2 (cross-platform, simple):
    1. npm install -g pm2
    2. pm2 start --name claude-bridge -- node dist/index.js serve -- --host 127.0.0.1 --port 8080
    3. pm2 save
  - Using systemd (Linux): create /etc/systemd/system/claude-bridge.service with:
    [Unit]
    Description=Claude Free Bridge
    After=network.target

    [Service]
    Type=simple
    WorkingDirectory=/path/to/claude-free-bridge
    ExecStart=/usr/bin/node /path/to/claude-free-bridge/dist/index.js serve -- --host 127.0.0.1 --port 8080
    Restart=always
    RestartSec=5

    [Install]
    WantedBy=multi-user.target

    Then: sudo systemctl daemon-reload && sudo systemctl enable --now claude-bridge

- Windows: use NSSM or run as a scheduled task or run under PM2 for Windows

Security notes for deployment
- auth.json is sensitive (contains cookies/localStorage). For production:
  - Create a dedicated machine/user for the bridge and protect the %USERPROFILE%/.claude-free-bridge directory with appropriate file permissions
  - Consider integrating OS keychain/credential storage to encrypt auth.json at rest (future work)
  - Expose the HTTP API only on localhost or behind a reverse proxy that enforces authentication and TLS

Integration tests
- After building the project run: npm run integration
- The script starts the built server, verifies /health, performs a non-streaming probe and a streaming (SSE) probe, and then stops the server. It requires at least one authenticated profile to run full API tests.

GUI
- A minimal PyQt GUI (claude_bridge_gui.py) is provided for convenience. It is intentionally minimal and always displays the relevant information:
  - Whether auth.json exists
  - lastActiveOrg (if discoverable in auth.json cookies)
  - Number of profiles
  - Server status (Running / Stopped)
  - Buttons: Authenticate, Start Server, Refresh
- To run: pip install PyQt5 && python claude_bridge_gui.py

Development notes
- Run npx tsc -p tsconfig.json to compile TypeScript sources to dist/ before running the CLI/runner
- The integration runner expects the built dist/ folder

If you want documentation added to other files or a different deployment flavor (Docker container, Windows service example), tell me which one and I will add it.
