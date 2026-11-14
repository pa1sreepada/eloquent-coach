<p align="center"><img src="app/build/icon.png" width="128" alt="Eloquent Coach icon"></p>

# Eloquent Coach

*Your edge in every meeting.*

**A private, real-time communication coach for executives — running entirely on your own machine.**

Eloquent Coach listens to a live meeting (your microphone + the meeting audio), transcribes both sides locally with sub-second latency, and surfaces bite-sized coaching on a transparent, always-on-top teleprompter: a high-leverage question to ask, a counterpoint to raise, a bottom-line-first reframe, or a nudge to stop talking and listen.

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
| **Voice-following teleprompter** | Write or import a script, then float it under your camera. It scrolls as you speak, keeps up with fillers, ad-libs and paraphrasing, and picks up wherever you rejoin. Every read-through is scored. See [Teleprompter](#teleprompter). |
| **Prepare** | One-click pre-meeting brief (open commitments, history with each attendee, what they care about, likely pushback), AI rehearsal partners (skeptical CFO, board member, upset direct report, …) with a scorecard, and a stakeholder map that learns from your meetings. |
| **Live decision tracker** | The HUD shows decisions, action items (with owners) and open questions as they are said. Two executive nudges join the coaching: *Invite the room* and *Commit to a position*. |
| **Growth** | Your communication trend by meeting type (1:1, all-hands, vendor update, …): fillers, hedges, answer-first, open questions, decisiveness, *we vs I*, talk share. *Say it better* turns your weakest real lines into practice drills. See [Measuring your growth](#growth). |
| **Leadership** | Commitment ledger (what you and others promised, with due dates and reminders), team radar (who is quiet, recurring concerns), weekly digest and a narrative check that tests a message against your recent meetings. |
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

Eloquent Coach records two inputs: your **microphone** and a **loopback device** carrying everyone else.

| OS | Loopback device |
|---|---|
| macOS (14.2+) | **Built in — nothing to install.** Choose *Mac system audio* in Settings; macOS asks once for **Screen & System Audio Recording** (allow it, then restart the app). Running via `npm run dev`, grant it to your terminal app instead. |
| macOS (alternative) | [BlackHole 2ch](https://github.com/ExistentialAudio/BlackHole) — create a *Multi-Output Device* (speakers + BlackHole) in Audio MIDI Setup and use it as your call app's output |
| Windows | [VB-CABLE](https://vb-audio.com/Cable/) or *Stereo Mix* |
| Linux | The PulseAudio/PipeWire *Monitor of …* source for your output |

Then open **Settings → Audio Devices** and pick your microphone and the loopback device. Without a loopback device the app runs in mic-only mode (coaching on your own delivery only).

### 2. Connect an LLM

Start LM Studio's local server (or Ollama) with a small instruct model — e.g. `google/gemma-4-e4b`, Qwen 3 4B/8B, or Llama 3.x 8B. In **Settings → Local LLM Engine** pick **LM Studio** or **Ollama** (or type any OpenAI-compatible URL) and click **Test connection**: the app detects the server, lists its models and runs a real request. Leave *Model ID* blank to use whichever model the server already has loaded. On a 16 GB Mac keep the model around 4–9B; larger models may not fit next to live transcription. **Enable model thinking / reasoning** is off by default: reasoning models (Qwen 3, Gemma 4, ...) answer directly, which keeps live cards fast. Turning it on sends `think: true` to Ollama and drops `reasoning_effort: "none"` for LM Studio. Answers are slower and get extra token budget. **Stream live coaching cards** is on by default: each card's headline appears on the HUD as soon as the model has written it, and the supporting detail fills in a moment later. This saves several seconds with larger models. Cards are saved only in their final form, and servers that reject streaming fall back to normal requests automatically. *Coaching Instructions* (optional) lets you add personal preferences, such as "push me to lead with the answer", to every live coaching request. When the LLM runs on the same GPU as the ASR, the adaptive planner automatically reserves headroom for it. Only a server on this Mac (`127.0.0.1` / `localhost`) is accepted unless you turn on **Allow an LLM server on another machine**; servers outside your local network must then use `https://`. If your server needs an API key (e.g. LM Studio's *Require API key*), enter it under **LLM server API key**; it's kept in the Keychain. **Test connection** also warns when Ollama or LM Studio is reachable from your network, not just this Mac.

**Optional: external frontier model (hybrid).** In **Settings → External Frontier Model** you can send post-meeting work (summaries, follow-up emails, teleprompter bridge lines and polish) to a cloud model while live coaching cards stay on the local LLM. Pick OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, Azure OpenAI, or any other OpenAI-compatible API (`https://` required), save that provider's API key (kept in the Keychain, one per provider, never stored in the database or returned by the API), then click **Test** to list your models and run a tiny request. While this is on, full transcripts and notes are sent to that provider.

### 3. Run a meeting

Start a meeting from the dashboard, add an agenda and prep notes (they ground the coaching and feed the teleprompter), then toggle the HUD. Collapse the sidebar with `⌘\` for more room.

| Shortcut (⌘ on macOS, Ctrl elsewhere) | Action |
|---|---|
| `⌘⇧H` | Show / hide the HUD |
| `⌘⇧→` / `⌘⇧←` | Next / previous card |
| `⌘⇧X` | Dismiss current card |
| `⌘⇧L` | Lock / unlock the HUD (click-through vs. draggable) |
| `⌘⇧↩` | **What do I say now?** — one best line for this moment, pushed to the front of the HUD (labelled **YOUR ASK**) and pinned as a gold **Say this now** banner at the top of the Live view (works from any app while a meeting is live) |

**My Notes.** Jot decisions, names and numbers in the *My Notes* tab of the live view. Notes autosave, steer the live coaching, and are weighted most heavily when the summary is generated. You can keep editing them later in **Meeting History**.

**Follow-up email.** In **Meeting History → Summary**, click *Draft follow-up email* to get a bottom-line-first recap (decisions, next steps with owners, open questions). You can copy it, open it in Mail, or redraft it. Like the summary, it is generated only on demand and never while a meeting is live, so the GPU stays free for the meeting.

### 4. Rehearse or present with the teleprompter
<a id="teleprompter"></a>

Open **Teleprompter** in the sidebar. Write, paste or import (`.txt`/`.md`) a script, then click **Start teleprompter**. A panel appears just under the camera. Like the HUD, it is click-through, stays on top and is **hidden from screen sharing and recordings**. Hover over it to show the controls.

- **Follows your voice.** Speech is matched against the script word by word, so the line you're reading stays on the eye line (the green tick). Fillers, extra words and recognition slips don't throw it off. Numbers, currency, percentages and contractions match however you say them (*$5M* ↔ "five million dollars").
- **Go off script.** After a few unscripted words the panel switches to **Ad-lib**, starts a timer and shows the words you need to rejoin. After 10 s the local LLM suggests a one-line **bridge** back. Pick up anywhere in the script, including a later section, and it follows. Sentences you passed over are struck through.
- **In your own words.** If you say a sentence differently, it is still counted as covered (marked *paraphrased*).
- **Pace.** A live WPM chip turns amber when you're fast and blue when you're slow, against the script's target pace. The panel also shows section progress and the time remaining.
- **During a meeting** the prompter follows the meeting's mic transcript, so it doesn't open a second recognizer. Otherwise it uses its own mic-only stream. Nothing it hears is saved.
- **Wrap-up.** At the end you get coverage, pace, ad-libs, paraphrases, fillers and the sentences you skipped. Each run is saved to the script's **Rehearsals** history so you can see the trend.
- **Make it speakable** rewrites a script with the local LLM so it reads like speech (you review it before it is applied).

Script markup:

| Markup | Meaning |
|---|---|
| `# Heading` | Section, shown on the progress bar |
| `> note` | Note to yourself, shown but not expected to be read |
| `[pause]` `[look up]` `[slow]` `[smile]` | Delivery cues that pulse as you reach them |
| `[next slide]` | Optionally presses → in the front app (enable *Advance slides*; macOS asks for Accessibility permission) |
| `*word*` | Emphasis |

| Shortcut (while the prompter is open) | Action |
|---|---|
| `⌥⌘P` | Pause / resume following (e.g. for Q&A) |
| `⌥⌘↑` / `⌥⌘↓` | Previous / next sentence |

You can also click any word to jump there. Text size, eye line, width, height, background opacity, mirroring (for beam-splitter glass) and the pace band are under **Prompter display**.

### 5. Prepare, track and grow
<a id="growth"></a>

- **Before a meeting:** Dashboard → add a title and attendees, then **Build brief**, or use **Prepare** for a full brief, a rehearsal or your stakeholder map. Set **Your name** in Settings so commitments assigned to you are recognised.
- **During:** the HUD tracker strip lists decisions, actions and open questions. They are saved with the meeting and feed the commitment ledger.
- **After:** commitments sync from the live tracker and the generated summary. **Leadership** keeps the ledger, team radar, weekly digest and narrative check.

**How growth is measured when both voices can reach the mic.** The *Me* channel is the mic, so in a room or on speakers it also hears other people. The app does not try to tell voices apart. Instead it:

1. removes mic lines that echo what the loopback channel heard;
2. rates each meeting **verified** (mostly you), **mixed** or **excluded**, and lets you override the rating per meeting (Reports → People & attribution or Growth → Attribution);
3. builds trends from verified meetings and rehearsals by default (*Include mixed* is optional), and compares each metric only within the same meeting type.

Wear a headset for the meetings you want measured, and talk share and pacing become exact. Voice enrollment and voice rehearsal are future work.

LLM features (brief, rehearsal, digest, narrative check, rewrites) use your local LLM or, in hybrid mode, the external provider. While a meeting is live they wait unless the external provider is on, so they never slow live coaching. Everything else is computed locally without an LLM.

---

## Configuration

Most settings live in the app (**Settings**) and are stored in the local SQLite database.

| Setting | Default | |
|---|---|---|
| ASR latency profile | `auto` | `ultra` (80 ms chunks) · `low` · `balanced` · `accurate` (1 s) — `auto` lets the planner choose per channel |
| ASR device | `auto` | Force `gpu` or `cpu`; manual choices are validated against your machine's measurements |
| Adaptive governor | on | Steps profiles down/up at runtime based on measured lag |
| Filler words / jargon | sensible defaults | Comma-separated |
| Your name | empty | Used to recognise your commitments and attribute action items |

Environment variables:

| Variable | Purpose |
|---|---|
| `ELOQUENT_STATE_DIR` | Where calibration data and the API token file live (default `~/.eloquent-coach`) |
| `ELOQUENT_API_TOKEN` | API token for a backend you start yourself (otherwise read from, or created in, `~/.eloquent-coach/api-token`) |
| `ELOQUENT_LLM_API_KEY` | LLM server API key (overrides the one saved in Settings) |
| `ELOQUENT_EXTERNAL_LLM_API_KEY` | External frontier model API key (overrides the one saved in Settings) |
| `ELOQUENT_ASR_MODEL` / `ELOQUENT_VAD_MODEL` | Use local GGUF files instead of downloading from Hugging Face |
| `ELOQUENT_MODELS_DIR` | Folder checked for model files before Hugging Face (default `backend/models/`) |
| `ELOQUENT_PYTHON` | Python interpreter Electron uses to start the backend (default `backend/venv`) |
| `HF_HOME` | Hugging Face cache location |

---

## Privacy & data

* **Audio is never written to disk** — it is streamed into the ASR engine in memory and discarded once transcribed.
* Only text is persisted, in the local SQLite database `backend/eloquent_coach.db`: the transcript, your notes, the live coaching cards, speaking metrics, the executive summary and any follow-up email. In **Meeting History** you can rename a meeting (click its title; the coaching, notes, summary and transcript follow it), export any meeting as Markdown (summary, notes, follow-up email, live coaching cards and transcript) or delete it. You can also change the meeting type from the header; the type decides the summary sections the next time you regenerate it (for example *Status vs target* and *Slips & root causes* for an OKR & Delivery Review, *Offers & concessions* for a negotiation, *Feedback given* for a 1:1, *Lessons to apply* for a fireside chat, *Key concepts* and *Apply & practise* for a YouTube & Learning session). Summaries are short headings and bullets (a bottom line, the type's sections, action items with owners, open questions); **Copy for Slack / email** copies them with bold headings and real bullets (plain text where formatting isn't supported) and leaves the personal phrasing pivots out. In the **Transcript** tab, hover a line to correct its text or speaker, or delete it; **Select lines** deletes several at once. Regenerate the summary afterwards to include your edits. Deleting permanently removes all of it (SQLite `secure_delete` overwrites the freed pages).
* **The database is encrypted at rest** with [SQLCipher](https://www.zetetic.net/sqlcipher/) (AES-256, including its write-ahead log). The random 256-bit key is created on first run and kept in the OS credential store — the **macOS Keychain** (service *Eloquent Coach*, account *database-key*), Windows Credential Locker or Linux Secret Service — never next to the data. On macOS the Keychain item belongs to the backend's Python interpreter, so another app asking for it triggers a Keychain prompt; after a Python upgrade, macOS asks you once to allow access. Other tools (including `sqlite3`) see *file is not a database*. The database files are also owner-only (`0600`). Headless setups can supply the key as `ELOQUENT_DB_KEY` (64 hex characters); with no credential store available it falls back to an owner-only `~/.eloquent-coach/db.key`. **If the key is lost, the data can't be recovered**, and the app refuses to create a new key while an encrypted database exists.
* **Upgrading from an unencrypted version** happens automatically on the next start: the database is copied into an encrypted file, every table's row count and the integrity check are verified, and only then is the plaintext overwritten and deleted. Transcript files that older versions wrote to `backend/transcripts/` are moved into the encrypted database (kept with their meeting and included in its Markdown export), verified, then overwritten and deleted. Overwriting is best effort: SSDs, APFS snapshots and backups such as Time Machine may still hold older copies.
* Encryption protects the files at rest. It doesn't stop someone using your unlocked account through the app, and Markdown exports you save are plain text.
* `backend/eloquent_coach.db` (and the legacy `backend/transcripts/` folder from older versions) are git-ignored — **never commit them**.
* **Settings → Data & Storage** shows the database location, encryption and key store, total size, rows per kind of data, the date range of meetings and any imported legacy transcript files. **Show in Finder** reveals the database file.
* **Only the app can use the backend.** It binds to `127.0.0.1` only. At each launch the app creates a random 256-bit token; every HTTP request must send it as `Authorization: Bearer …` and every WebSocket as a subprotocol, so web pages in your browser and other programs can't read your meetings through `127.0.0.1:8000`. Requests whose `Host` isn't `127.0.0.1`/`localhost` (DNS rebinding) and WebSockets from other origins are refused. The token is also written to the owner-only `~/.eloquent-coach/api-token` so a backend you start by hand works; any program running as you can read that file, so it guards against web pages and other users, not malware in your own account.
* **LLM traffic stays on this Mac by default** (see *Connect an LLM*): remote servers need an explicit opt-in (and `https://` outside your network), credentials in the URL are rejected, LLM requests never follow redirects, and live coaching cards aren't written to the logs.
* **Desktop app hardening:** all windows run sandboxed with context isolation, can't open new windows or navigate away from the app (links open in your browser), and only the app's own pages get microphone and system-audio access. Packaged builds add a Content-Security-Policy that limits the UI to its own files and the local backend, the hardened runtime, and Electron fuses (no `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` or inspector flags; asar integrity checked).
* **Model files are pinned:** the speech models are downloaded from a fixed Hugging Face commit and their SHA-256 is checked before every load, including files you import.
* The only network calls are model downloads (Hugging Face, first run), your configured LLM endpoint and, only if you turn it on, the external frontier model provider (post-meeting work only; transcripts are sent there over HTTPS).

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
venv/bin/python -m uvicorn main:app --port 8000 --reload   # run the API alone (token: ~/.eloquent-coach/api-token)
venv/bin/python tests/test_coach.py                          # telemetry, triggers, coaching engine
venv/bin/python tests/test_adaptive.py                       # planner + governor (ASR_E2E=1 adds a live GPU→CPU swap)
venv/bin/python tests/test_api_auth.py                       # API token, Host/Origin checks, LLM URL policy
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
  api_auth.py        per-launch API token, Host and WebSocket origin checks
  realtime.py        WebSocket audio/events, MeetingSession, ASR runtime
  asr_service.py     VAD + Parakeet streaming per channel
  adaptive.py        hardware-aware planner + runtime governor
  hardware.py        CPU/GPU/memory/power probing
  coach_engine.py    trigger detection + LLM coaching cards
  telemetry.py       pacing, fillers, airtime, sentiment
  leadership.py      brief, rehearsal, stakeholders, commitments, growth, digest API
  leadership_analysis.py  deterministic growth metrics, attribution, live decision tracker
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
| Participant side is silent | Verify the loopback device in Settings and that your call app outputs to it. With *Mac system audio*, check System Settings → Privacy & Security → Screen & System Audio Recording, then restart. |
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
