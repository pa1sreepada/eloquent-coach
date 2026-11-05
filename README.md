<p align="center"><img src="app/build/icon.png" width="128" alt="Second Chair icon"></p>

# Second Chair

*Your executive coach, in a whisper.*

**A private, real-time communication coach for executives — running entirely on your own machine.**

In a courtroom, the second chair is the co-counsel who slides the lead attorney the perfect note at the perfect moment. That is what this app does in your meetings.

Second Chair listens to a live meeting (your microphone + the meeting audio), transcribes both sides locally with sub-second latency, and surfaces bite-sized coaching on a transparent, always-on-top teleprompter: a high-leverage question to ask, a counterpoint to raise, a bottom-line-first reframe, or a nudge to stop talking and listen.

No audio, transcripts, or prompts leave your computer unless you point it at a remote LLM.

---

## Features

| | |
|---|---|
| **Local streaming ASR** | NVIDIA Parakeet 0.6B (Q8_0 GGUF) via [`transcribe-cpp`](https://pypi.org/project/transcribe-cpp/) / ggml — the engine used by [Handy](https://github.com/cjpais/Handy). Metal on Apple Silicon (tested), plus whatever GPU/CPU backends the `transcribe-cpp` wheel for your platform provides. Partial results in ~100–400 ms on an M3. |
| **Two speakers, two channels** | Mic → *Me*, system loopback → *Participant*. Each channel has its own decoder, so attribution is exact — no diarization guesswork. |
| **Hardware-adaptive** | Measures this machine once (~25 s), then picks the fastest latency profile and device (GPU/CPU) per channel that fits a compute budget. A runtime governor steps down under load (e.g. while your local LLM is generating) and recovers when it's calm. No hand-tuned configs. |
| **Live coaching engine** | Event-driven (questions asked, decisions, monologues, objections) rather than on a timer. Produces prioritized cards: leading questions, strategic counterpoints, alignment cues, Pyramid-Principle / BLUF framing — grounded in your agenda and prep notes. |
| **Telemetry** | Talk-time share, words per minute, filler words, hedges, monologue length, wait time after questions, interruptions, and room sentiment. |
| **Teleprompter HUD** | Transparent, click-through, always-on-top overlay with a card deck that auto-advances with the conversation, plus a script aligner that follows your prepared talking points as you speak. |
| **Post-meeting synthesis** | On-demand executive summary per meeting (Reports → Generate), strategic alternatives, metrics history and daily reports. |

---

## Architecture

```
┌──────────────────────── Electron app (app/) ────────────────────────┐
│ Main window (React)         HUD window (transparent, always-on-top)  │
│  • AudioWorklet: mic=L, loopback=R, 16 kHz float32, 80 ms frames     │
│  • Settings, history, reports                                        │
└───────────────┬──────────────────────────────▲───────────────────────┘
        ws /ws/audio/{id}                 ws /ws/events/{id}
                │  (stereo PCM)                │  (transcript · card · telemetry · asr_status)
┌───────────────▼──────────────── FastAPI (backend/) ──────────────────┐
│ realtime.py  MeetingSession                                          │
│   ├─ asr_service.py  Silero VAD + Parakeet stream ×2 (one per speaker)│
│   ├─ adaptive.py     planner + runtime governor  ◄── hardware.py     │
│   ├─ telemetry.py    pacing / fillers / airtime / sentiment          │
│   └─ coach_engine.py triggers → LLM (OpenAI-compatible) → cards      │
│ main.py      meetings, settings, synthesis, reports  (SQLite)        │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │ HTTP (OpenAI-compatible)
                        LM Studio / Ollama / llama.cpp server / any API
```

The detailed design, benchmarks and rationale live in [`docs/refactor/REFACTOR_PLAN.md`](docs/refactor/REFACTOR_PLAN.md).

---

## Requirements

| | Version | Notes |
|---|---|---|
| Python | 3.10 – 3.13 (3.13 recommended) | `transcribe-cpp` ships prebuilt wheels for macOS (arm64/x86_64), Linux (x86_64/aarch64) and Windows (x86_64) |
| Node.js | 22.18+ (24 recommended, see `app/.nvmrc`) | |
| An OpenAI-compatible LLM | — | [LM Studio](https://lmstudio.ai) (default `http://127.0.0.1:1234/v1`), [Ollama](https://ollama.com) (`http://127.0.0.1:11434/v1`), or a hosted API |
| Disk | ~1 GB | ASR + VAD models are downloaded from Hugging Face on first use and cached |
| Hardware | Apple Silicon recommended | Any modern x86_64 works; the app adapts to slower machines automatically |

---

## Quick start

```bash
git clone https://github.com/<you>/eloquent-coach.git
cd eloquent-coach

python3.13 scripts/setup.py --models   # venv + Python deps, npm deps, ASR models
cd app && npm run dev                  # launches Electron + the backend on 127.0.0.1:8000
```

`setup.py` is safe to re-run; use `--recreate` to rebuild the Python environment from scratch. On Windows use `py -3.13 scripts\setup.py`.

**First launch:** the backend benchmarks the ASR on your hardware in the background (~25 s, once per machine; cached in `~/.eloquent-coach/`). Meetings started before it finishes use a conservative heuristic plan.

### 1. Route meeting audio

Second Chair records two inputs: your **microphone** and a **loopback device** carrying everyone else.

| OS | Loopback device |
|---|---|
| macOS | [BlackHole 2ch](https://github.com/ExistentialAudio/BlackHole) — create a *Multi-Output Device* (speakers + BlackHole) in Audio MIDI Setup and use it as your call app's output |
| Windows | [VB-CABLE](https://vb-audio.com/Cable/) or *Stereo Mix* |
| Linux | The PulseAudio/PipeWire *Monitor of …* source for your output |

Then open **Settings → Audio Devices** and pick your microphone and the loopback device. Without a loopback device the app runs in mic-only mode (coaching on your own delivery only).

### 2. Connect an LLM

Start LM Studio's local server (or Ollama) with a small instruct model — e.g. `google/gemma-4-e4b`, Qwen 3 4B/8B, or Llama 3.x 8B. In **Settings → Local LLM Engine** pick **LM Studio** or **Ollama** (or type any OpenAI-compatible URL) and click **Test connection**: the app detects the server, lists its models and runs a real request. Leave *Model ID* blank to use whichever model the server already has loaded. On a 16 GB Mac keep the model around 4–9B; larger models may not fit next to live transcription. **Enable model thinking / reasoning** is off by default: reasoning models (Qwen 3, Gemma 4, ...) answer directly, which keeps live cards fast. Turning it on sends `think: true` to Ollama and drops `reasoning_effort: "none"` for LM Studio. Answers are slower and get extra token budget. *Coaching Instructions* (optional) lets you add personal preferences, such as "push me to lead with the answer", to every live coaching request. When the LLM runs on the same GPU as the ASR, the adaptive planner automatically reserves headroom for it.

### 3. Run a meeting

Start a meeting from the dashboard, add an agenda and prep notes (they ground the coaching and feed the teleprompter), then toggle the HUD. Collapse the sidebar with `⌘\` for more room.

| Shortcut (⌘ on macOS, Ctrl elsewhere) | Action |
|---|---|
| `⌘⇧H` | Show / hide the HUD |
| `⌘⇧→` / `⌘⇧←` | Next / previous card |
| `⌘⇧X` | Dismiss current card |
| `⌘⇧L` | Lock / unlock the HUD (click-through vs. draggable) |
| `⌘⇧↩` | **What do I say now?** — one best line for this moment, pushed to the HUD (works from any app while a meeting is live) |

**My Notes.** Jot decisions, names and numbers in the *My Notes* tab of the live view. Notes autosave, steer the live coaching, and are weighted most heavily when the summary is generated. You can keep editing them later in **Meeting History**.

**Follow-up email.** In **Meeting History → Summary**, click *Draft follow-up email* to get a bottom-line-first recap (decisions, next steps with owners, open questions). You can copy it, open it in Mail, or redraft it. Like the summary, it is generated only on demand and never while a meeting is live, so the GPU stays free for the meeting.

---

## Configuration

Most settings live in the app (**Settings**) and are stored in the local SQLite database.

| Setting | Default | |
|---|---|---|
| ASR latency profile | `auto` | `ultra` (80 ms chunks) · `low` · `balanced` · `accurate` (1 s) — `auto` lets the planner choose per channel |
| ASR device | `auto` | Force `gpu` or `cpu`; manual choices are validated against your machine's measurements |
| Adaptive governor | on | Steps profiles down/up at runtime based on measured lag |
| Filler words / jargon | sensible defaults | Comma-separated |

Environment variables:

| Variable | Purpose |
|---|---|
| `ELOQUENT_STATE_DIR` | Where calibration data is cached (default `~/.eloquent-coach`) |
| `ELOQUENT_ASR_MODEL` / `ELOQUENT_VAD_MODEL` | Use local GGUF files instead of downloading from Hugging Face |
| `ELOQUENT_MODELS_DIR` | Folder checked for model files before Hugging Face (default `backend/models/`) |
| `ELOQUENT_PYTHON` | Python interpreter Electron uses to start the backend (default `backend/venv`) |
| `HF_HOME` | Hugging Face cache location |

---

## Privacy & data

* **Audio is never written to disk** — it is streamed into the ASR engine in memory and discarded once transcribed.
* Only text is persisted, in the local SQLite database `backend/eloquent_coach.db`: the transcript, your notes, the live coaching cards, speaking metrics, the executive summary and any follow-up email. In **Meeting History** you can rename a meeting (click its title; the coaching, notes, summary and transcript follow it, and a legacy transcript file is renamed to match), export any meeting as Markdown (summary, notes, follow-up email, live coaching cards and transcript) or delete it. Deleting permanently removes all of it (SQLite `secure_delete` overwrites the freed pages).
* `backend/eloquent_coach.db` (and the legacy `backend/transcripts/` folder from older versions) are git-ignored — **never commit them**.
* **Settings → Data & Storage** shows the database location, total size, rows and space used by each kind of data, the date range of meetings and any legacy transcript files. **Show in Finder** reveals the database file.
* The backend binds to `127.0.0.1` only, and CORS is restricted to the local app.
* The only network calls are model downloads (Hugging Face, first run) and your configured LLM endpoint.

---

## Keeping dependencies up to date

Two complementary mechanisms; neither applies a breaking (major) upgrade without review.

**On GitHub — Dependabot** ([`.github/dependabot.yml`](.github/dependabot.yml))
Security updates as soon as advisories are published, plus weekly version-update PRs for npm, pip and GitHub Actions (patch/minor grouped, majors separate). Every PR runs CI: backend tests, frontend typecheck/tests/build, `pip-audit`, `npm audit`, and GitHub dependency review. Enable *Dependabot alerts* and *security updates* under **Settings → Code security** on the repository.

**Locally — manual safe updater**

```bash
python3 scripts/update_deps.py --check        # report outdated packages + known vulnerabilities; changes nothing
python3 scripts/update_deps.py                # apply safe updates, run all tests, roll back automatically on failure
python3 scripts/update_deps.py --skip-build   # same, without the production-build check
```

"Safe" means patch/minor updates within the declared ranges (`package.json` carets; `requirements.txt` caps the next major) plus `npm audit fix` (never `--force`). Anything that needs a major upgrade is listed under **Needs review** in the report (`.dependency-reports/`, git-ignored).

---

## Development

```bash
# backend
cd backend
venv/bin/python -m uvicorn main:app --port 8000 --reload   # run the API alone
venv/bin/python tests/test_coach.py                          # telemetry, triggers, coaching engine
venv/bin/python tests/test_adaptive.py                       # planner + governor (ASR_E2E=1 adds a live GPU→CPU swap)
venv/bin/python tests/bench.py balanced                      # ASR at real-time pace
venv/bin/python tests/e2e_ws.py <meeting_id> 1 8000          # end-to-end over the WebSocket API

# frontend
cd app
npm run typecheck && npm test && npm run lint
npm run build
```

```
backend/
  main.py            REST API: meetings, settings, synthesis, reports
  realtime.py        WebSocket audio/events, MeetingSession, ASR runtime
  asr_service.py     VAD + Parakeet streaming per channel
  adaptive.py        hardware-aware planner + runtime governor
  hardware.py        CPU/GPU/memory/power probing
  coach_engine.py    trigger detection + LLM coaching cards
  telemetry.py       pacing, fillers, airtime, sentiment
  tests/
app/
  electron/          main process, HUD window, preload bridge
  src/components/    main-window views
  src/hud/           HUD app, capture worklet hook, event protocol
  public/pcm-capture-worklet.js
scripts/
  setup.py           one-shot setup
  update_deps.py     safe dependency updater
docs/refactor/       architecture & design notes
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `npm run dev` hangs or fails with *Cannot find module …rolldown-binding…* / *esbuild for another platform* | A native binary in `node_modules` was removed — often by corporate endpoint-security software. Re-run `npm ci`; if it keeps disappearing, ask IT to allow-list `app/node_modules/@rolldown`, `@esbuild` and `electron`. |
| "Python backend not found" in the Electron console | Run `python3 scripts/setup.py`, or set `ELOQUENT_PYTHON`. |
| Transcripts lag noticeably | Open **Settings → Transcription** and click *Re-measure this machine*; close other GPU-heavy apps; keep *Adaptive* on. |
| No coaching cards | The HUD and Live Meeting view show *Coaching unavailable: …* with the server's reason (unreachable, model too large for memory, ...). Use **Settings → Test connection** to check the URL and model. The model is warmed up when a meeting starts, so a cold load doesn't time out the first card. |
| Participant side is silent | Verify the loopback device in Settings and that your call app outputs to it. |
| Model download fails with `CERTIFICATE_VERIFY_FAILED` (corporate TLS proxy, or macOS python.org builds) | The backend verifies against the OS trust store via `truststore`; re-run `python3 scripts/setup.py` so it is installed. Don't set `SSL_CERT_FILE` unless it points to a bundle that includes your company's root CA (an explicit value is respected). |
| Model download fails (403 Forbidden, proxy, offline) | Copy files you already have: `python3 scripts/import_models.py "~/Library/Application Support/com.pais.handy/models"` (any file or folder works). They go to `backend/models/`; restart the backend. |
| npm is very slow or fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` (corporate TLS-inspection proxy) | Use the OS certificate store: `export NODE_OPTIONS=--use-system-ca` (Node 22.15+). The setup/update scripts do this automatically. Don't disable `strict-ssl`. |

---

## Acknowledgements

* [Handy](https://github.com/cjpais/Handy) and [`transcribe-cpp`](https://pypi.org/project/transcribe-cpp/) for the local streaming ASR approach
* NVIDIA Parakeet and Silero VAD models (via Hugging Face)
* Even Realities' *Conversate* and *Teleprompter* for interaction-design inspiration

Model weights are downloaded from their publishers and are subject to their own licenses.

## License

[MIT](LICENSE)
