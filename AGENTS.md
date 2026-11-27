# AGENTS.md

Guidance for AI coding agents working in this repo. Human-facing docs live in `README.md` and `SECURITY.md`.

## Layout
- `app/` — Electron 44 + React 19 + Vite + TypeScript. `electron/` = main process (`main.ts` spawns the backend, `security.ts` permissions/CSP, `updater.ts` auto-update); `src/` = renderer (`api.ts` is the only way to call the backend); `tests/` = plain Node tests.
- `backend/` — Python 3.13 FastAPI (`main.py`), SQLCipher DB (`database.py`, `secure_store.py`), coaching/LLM/ASR modules, `tests/test_*.py` (plain scripts, no pytest).
- `scripts/` — setup, model import, dependency updates, `bundle_backend.py` (relocatable Python for packaged builds).

## Commands
Backend (always use the venv, never system pip):
```sh
cd backend && python3 -m venv venv && venv/bin/pip install -r requirements-dev.txt
for t in coach adaptive meeting_api prompter_api secure_store api_auth leadership voice rephrase pro; do venv/bin/python tests/test_$t.py; done
```
Frontend (in `app/`, Node 24):
```sh
npm ci && npm run -s typecheck && npm test && npx vite build
npx eslint <changed files>   # full `npm run lint` already fails on untouched files
```
Packaging: `npm run dist:mac` (needs a Developer ID cert + notarytool keychain profile via env; never commit credentials).

## Invariants
- **Local-first & private**: transcripts/audio stay on device. Don't add network calls or telemetry without an explicit user setting; document any in README's privacy section.
- **API auth**: every backend request needs the per-launch token (`api_auth.ApiGuard`): HTTP `Authorization: Bearer`, WS subprotocols `['eloquent','token.<t>']`, Host must be 127.0.0.1/localhost. Renderer: `installApiAuth()` patches fetch at startup; use `apiSocket()` from `src/api.ts` for WebSockets.
- **Encrypted DB**: SQLCipher; key in OS keyring (`ELOQUENT_DB_KEY` overrides, used by tests). Plain `sqlite3` can't open it. Data dir = `ELOQUENT_DATA_DIR` (packaged app sets it to userData).
- **Secrets** (API keys, calendar ICS URLs) go in the OS Keychain, never in the DB, logs, or repo.
- Electron: keep `contextIsolation`, sandbox, fuses, and the permission allowlist in `security.ts` tight.
- Adding a backend test file → also add it to `.github/workflows/ci.yml`. Adding an app test → add it to `npm test` in `app/package.json`.

## Workflow
- Small, surgical changes; update README when behavior or setup changes.
- Commit to `main` with trailer `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`, push, and confirm CI is green (`gh run watch <id> --exit-status`).
- Behind a corporate TLS proxy, Electron/npm downloads may need `NODE_OPTIONS=--use-system-ca`.
