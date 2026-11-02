# Eloquent Coach → Executive Real-Time Communication Coach

**Refactoring plan, architecture, and validated reference implementation**

Everything described here is integrated into `backend/` and `app/`; it was built and run on this machine (Apple M3, macOS, Python 3.13, Node 24, LM Studio + `google/gemma-4-e4b`). The validation included:

- unit tests
- a real-time-paced ASR benchmark
- `tsc` on the renderer and on the Electron code
- one end-to-end run: a uvicorn server received 2-channel audio over `/ws/audio`, and a second client received transcripts, telemetry and LLM cards over `/ws/events`; the results were persisted to SQLite.
- hardware-adaptive ASR (§11): a real calibration of this M3, policy/governor unit tests, a live GPU→CPU engine swap, and an end-to-end **contention test** against a saturated local LLM (pinned `ultra` vs adaptive).

The existing source tree has **not** been modified. Port the files using the phases in §9.

---

## 1. Executive summary

| Area | Today | Target |
|---|---|---|
| ASR | faster-whisper `distil-small.en`, fixed 1.5 s non-overlapping chunks, serial per channel | Parakeet-unified 0.6B **Q8_0 GGUF** on `transcribe.cpp` (Handy's engine), VAD-gated **buffered streaming**, one thread per channel |
| Transcript latency | ≥1.5 s buffering + ~0.3–1 s inference, unbounded backlog | **~230 ms** (ultra) / **~400 ms** (low) after speech; finals ~30–250 ms after the end-of-speech silence window (measured) |
| Coaching | 30 s timer, 1 free-text tip, category parser bug | Event-triggered (question-to-me, objection, ownerless commitment, monologue, my turn), JSON-schema cards, priority preemption, grounding filter |
| Telemetry | Pacing is always 150 WPM (bug); fillers counted via substring matching | Audio-time voiced durations, word-boundary filler/hedge regex, rolling WPM, talk-share, room sentiment, monologue/interruption/wait-time |
| Hardware fit | One global Whisper size/compute type picked by hand; wrong picks silently lag | **Measured, not guessed**: one-off 25 s calibration per machine → per-channel device/profile plan under a power- and LLM-aware budget → runtime governor that steps down/up on live lag (§11) |
| HUD | `<div>` in the main window; "always on top" pins the whole app; visible in screen share | Separate transparent, click-through, focus-less, **content-protected** overlay with a teleprompter card deck, voice-following script, and global hotkeys |

---

## 2. Current-state audit

### 2.1 Architecture as-is

```
Renderer (LiveMeetingView.tsx, 637 lines)
  getUserMedia(mic) + getUserMedia(BlackHole) → ChannelMerger → ScriptProcessorNode(4096)  [main thread, deprecated]
  └─ ws://…/ws/audio/{id}  (interleaved stereo f32)
FastAPI main.py
  audio_websocket: buffer 6×4096 frames (~1.5 s) → unbounded asyncio.Queue
  transcription_worker: faster-whisper (both channels, serially, beam=3)
     → sync SQLAlchemy on the event loop (re-query Meeting + AppConfig on every chunk) → file append
     → every 30 s: run_insight_pipeline → metrics_engine (O(n) over all transcripts) → LM Studio (new client per call)
```

### 2.2 Latency bottlenecks (ranked)

| # | Location | Problem | Impact |
|---|---|---|---|
| 1 | `main.py` `audio_websocket` (`CHUNKS_TO_BUFFER = 6`) | 1.5 s fixed buffer before any inference starts | +1.5 s floor on every word |
| 2 | `transcription_service.py` | Whisper is non-streaming; chunks don't overlap and `condition_on_previous_text=False` | Words split at chunk edges; ~0.3–1 s inference per chunk |
| 3 | `main.py` `transcription_worker` | Two channels transcribed **serially** in the default executor | Doubles compute latency |
| 4 | `asyncio.Queue()` (unbounded) | When inference is slower than real time, the backlog grows with no limit | Lag drifts to tens of seconds in long meetings |
| 5 | `transcription_worker` | Sync DB writes + `Meeting`/`AppConfig` queries on the event loop on every result | Blocks WS I/O |
| 6 | `run_insight_pipeline` | 30 s timer, `max_tokens=1200`, 180 s timeout, `GET /models` on every call, new `httpx.AsyncClient` per call | Advice arrives 30–60 s after the moment |
| 7 | `LiveMeetingView.tsx` | `ScriptProcessorNode` on the main thread; React re-renders on every transcript; the transcript array is unbounded | Audio glitches under UI load |

### 2.3 Confirmed bugs and technical debt

- **Backend cannot start.**
  - `backend/venv/bin/python` symlinks to a removed `/opt/homebrew/opt/python@3.14`, and the venv was created on a different machine.
  - `electron/main.ts` hardcodes `lib/python3.14/.../certifi` paths.
- **Pacing is constant.** `metrics_engine.py` sets `talk_time = words/150`, so `pacing = words / (words/150) = 150` always. `confidence_score` is therefore constant too.
- **Category parsing.**
  - `insight_engine.py` asks for `suggestion/answer/concept/bio`, but the parser only accepts `question/structure/risk/praise`. Everything else becomes `question`.
  - The DB-seeded `system_prompt` (`init_default_settings`) always overrides `EXECUTIVE_DEFAULT_PROMPT`, so the richer prompt is dead code.
- **Mute does nothing.** `isMuted` is captured as a stale closure inside `onaudioprocess`.
- **Settings save hot-reloads Whisper whenever `custom_jargon` is non-empty**, which is effectively every save. The reload is blocking.
- **Security.**
  - `main.py` lines 7–11 monkey-patch `httpx.Client` to disable TLS verification globally.
  - CORS is `*` with credentials.
  - `preload.ts` exposes raw `ipcRenderer.send/invoke/on` for **every** channel.
  - The HUD is captured by screen share.
- **Wrong timestamps.** Transcript timestamps are DB-insert times, not audio times, so wait-time and interruption metrics are wrong.
- **Fillers.** Substring matching on `" um "` misses `um,` / `Um.` and false-positives inside phrases.
- **Dead and duplicate code.**
  - `audio_capture.py` (PyAudio) is unused.
  - `active_insight_tasks` is defined twice.
  - `datetime.utcnow` is deprecated.
- **Electron.** The `activate` handler → `createWindow()` → `startPythonBackend()` can spawn a second backend (port 8000 conflict).
- **SQLite.** No WAL. The reports UI and the live writer contend.
- **Echo.** Laptop speakers bleed into the mic, so the room's speech appears on the "Me" channel. Mitigations are in §8.

---

## 3. Target architecture

```
┌──────────────────────────── Electron ─────────────────────────────┐
│ Main window (React)                    HUD window (React, #hud)   │
│  AudioWorklet pcm-capture  ──┐          transparent · click-through│
│  (80 ms stereo f32 frames)   │          focusable:false · screen-  │
│  mute → worklet port         │          saver level · content-     │
│                              │          protected · hotkeys        │
│ preload: window.eloquent.* (allowlisted IPC) ◄── hud:* ──► main.ts │
└──────────────────────────────┼───────────────────────▲────────────┘
            ws /ws/audio/{id}  │                       │ ws /ws/events/{id}
┌──────────────────────────────▼───────────────────────┴────────────┐
│ FastAPI  realtime.py                                              │
│  MeetingSession                                                   │
│   StreamingTranscriptionService (asr_service.py)                  │
│     ch L "Me"          ── thread ── Silero VAD → Parakeet stream  │
│     ch R "Participant" ── thread ── Silero VAD → Parakeet stream  │
│        │ partial/final AsrEvent (audio-time t0/t1, utterance_id)  │
│        ▼                                                          │
│   EventBus.publish ───────────────────────────► all subscribers   │
│        │ final                                                    │
│        ├─► to_thread: persist Transcript (+ file)   [WAL SQLite]  │
│        └─► CoachingEngine.on_final                                │
│              fast path: SpeechTelemetry.ingest → telemetry event  │
│              slow path: TriggerPolicy → single-flight LLM call    │
│                         (priority preemption, JSON schema,        │
│                          grounding filter, dedupe) → card event   │
└───────────────────────────────────────────────────────────────────┘
          transcribe.cpp (ggml: Metal / CUDA / Vulkan / CPU)      LM Studio / Ollama / llama-server
```

**Design principles**

- The audio path never waits on the database or the LLM. Persistence runs in `asyncio.to_thread`. LLM calls are spawned tasks.
- Backpressure without drift: audio that arrives while a channel is busy is **coalesced** into its next `feed()` instead of queued.
- One protocol (`app/src/hud/protocol.ts`) is shared by the main window and the HUD. Both are plain subscribers of the same bus.

---

## 4. ASR engine migration (Handy pattern)

### 4.1 Why `transcribe.cpp`

Handy (cjpais/Handy) now routes every model, including Whisper, Parakeet, Moonshine and Canary, through the **`transcribe-cpp`** Rust crate. The crate binds `handy-computer/transcribe.cpp`, a ggml runtime. The requested model is published by the Handy team at **`handy-computer/parakeet-unified-en-0.6b-gguf`**.

| Option | Loads `parakeet-unified-en-0.6b-Q8_0.gguf`? | Streaming | Notes |
|---|---|---|---|
| **transcribe.cpp** (Python `transcribe-cpp==0.4.1`, Rust crate `transcribe-cpp`) | **Yes (native format)** | Buffered streaming with commit policy, plus Silero VAD GGUF | Prebuilt wheels for macOS arm64/x86_64, manylinux, win_amd64. Metal/CUDA/Vulkan/CPU. **Chosen.** |
| llama.cpp | No: no FastConformer/TDT encoder | – | LLM only |
| sherpa-onnx | No: needs the ONNX export (different weights/format) | Yes | Good fallback if you drop the GGUF requirement |
| ONNX Runtime (raw) | No | Manual | You'd re-implement the TDT decoding loop |
| candle | No Parakeet port | – | – |

**Python bindings vs a Rust sidecar.** Python is chosen for this phase. The backend is already Python, and the `transcribe-cpp` wheel calls release the GIL, so one thread per channel is truly parallel (§4.5). A Tauri/Rust sidecar using `transcribe-cpp = { version = "0.4", features = ["metal"] }` is an optional later phase (§9, Phase 5).

### 4.2 Model facts

- **Model file:** `parakeet-unified-en-0.6b-Q8_0.gguf`. It is 731 MB on disk and memory-mapped (697 MiB resident on Metal). Published WER is 1.60% (offline).
- **VAD:** `handy-computer/silero-vad-v6.2-gguf` / `silero-vad-v6.2-F32.gguf` (1.2 MB, runs on CPU).
- **Streaming profiles.** These are the published buffered-streaming configurations. Lookahead = chunk + right.

| Profile | left / chunk / right (ms) | Lookahead | Streaming WER |
|---|---|---|---|
| `ultra` | 5600 / 80 / 80 | **160 ms** | 1.90% |
| `low` | 5600 / 160 / 160 | 320 ms | 1.64% |
| `balanced` | 5600 / 560 / 560 | 1.12 s | 1.40% |
| `accurate` | 5600 / 1040 / 1040 | 2.08 s | 1.44% |

> **"Sub-200 ms" caveat.** 160 ms is the *algorithmic lookahead* of `ultra`. The measured end-to-end time on an M3 was **~230 ms** from speech to partial text, with no GPU contention. Every step re-encodes ~5.8 s of left context, so compute grows with chunk *rate*, not chunk size.

### 4.3 Measured performance (Apple M3, two channels in parallel, real-time paced)

| Config | LLM generating concurrently? | feed() p50 / p95 | Emit lag p50 / max | Verdict |
|---|---|---|---|---|
| Metal · ultra | no | 70 / 170 ms | ≈ real time | ✅ lowest latency |
| Metal · low | no | 75 / 120 ms | −3 / 235 ms | ✅ default (no local LLM) |
| Metal · balanced | no | 84 / 109 ms | 6 / 66 ms | ✅ |
| CPU · low | no | 211 / **2666** ms | 174 / **8555** ms | ❌ falls behind |
| CPU · balanced | no | 235 / 359 ms | 157 / 323 ms | ⚠️ usable |
| Metal · ultra | **yes** | 2.1 s p50 | **13.3 s** max | ❌ starves |
| Metal · low | **yes** | 187 / **1646** ms | 172 / 2337 ms | ❌ |
| CPU · balanced | **yes** | 264 / 468 ms | 187 / 536 ms | ⚠️ |
| **Metal · balanced** | **yes** | **233 / 265 ms** | **156 / 189 ms** | ✅ **default with local LLM** |

Other measurements:

- `finalize()`: 85–230 ms.
- Model load: 0.1–1.1 s (the weights are mmapped).
- The first-ever Metal shader compile takes ~4 s, once per machine.
- Transcripts were exact ("Q3", "40%"). `ultra`/`low` occasionally drop a trailing "?", while `balanced` keeps it.

**Policy.** These numbers are from one machine, so the profile is no longer chosen by a fixed rule. `asr_profile=auto` hands the decision to the hardware-adaptive planner and governor in **§11**, which calibrate the machine they run on, give each channel its own device/profile, and react to live lag. `ChannelTranscriber.set_profile()` switches the profile at the next utterance boundary at no cost.

### 4.4 Setup

```bash
cd backend
rm -rf venv                                   # broken: points at removed python@3.14
/opt/homebrew/bin/python3.13 -m venv venv
./venv/bin/pip install -U pip
./venv/bin/pip install -r requirements.txt    # see backend/requirements.txt

# Pre-fetch models into ~/.cache/huggingface (≈732 MB). Also happens lazily on first meeting.
./venv/bin/python -c "
from huggingface_hub import hf_hub_download as d
print(d('handy-computer/parakeet-unified-en-0.6b-gguf','parakeet-unified-en-0.6b-Q8_0.gguf'))
print(d('handy-computer/silero-vad-v6.2-gguf','silero-vad-v6.2-F32.gguf'))"

# Optional overrides (air-gapped installs / packaged app resources):
export ELOQUENT_ASR_MODEL=/path/parakeet-unified-en-0.6b-Q8_0.gguf
export ELOQUENT_VAD_MODEL=/path/silero-vad-v6.2-F32.gguf
```

- `resolve_model_paths()` checks the HF cache first (`try_to_load_from_cache`), so meetings work offline after the first download. This was verified with `HF_HUB_OFFLINE=1`.
- No compiler is needed: `transcribe-cpp-native` ships prebuilt ggml.
- On Windows/Linux with NVIDIA, the wheel picks CUDA or Vulkan when `backend="auto"`.

**Dependency changes.**

| Removed | Added |
|---|---|
| `faster-whisper`, `ctranslate2`, `av`, `pyaudio` | `transcribe-cpp==0.4.1` (+ `transcribe-cpp-native`), `huggingface_hub`, `vaderSentiment==3.3.2` |

- Python is pinned to 3.13.
- **No new npm dependencies.** `zustand` is optional if you later split `LiveMeetingView` state.

### 4.5 Implementation: `backend/asr_service.py`

Key mechanics. The full file is about 300 lines.

```python
class ChannelTranscriber:          # one per channel, driven by exactly one thread
    def __init__(self, speaker, asr_path, vad_path, *, profile="low", vocabulary=None, backend="auto"):
        self.model = transcribe_cpp.Model(asr_path, backend=backend)    # mmap'd; one active stream per Model
        self.session = self.model.session()
        self.vad_model = transcribe_cpp.Model(vad_path)
        self.vad = self.vad_model.vad_session()
        self.set_profile(profile)
        self._vocabulary = vocabulary if vocabulary and self.model.supports("vocabulary") else None

    def set_profile(self, profile):                                      # applies at next utterance
        left, chunk, right = STREAM_PROFILES[profile]
        self._stream_opts = transcribe_cpp.ParakeetBufferedStreamOptions(left_ms=left, chunk_ms=chunk, right_ms=right)

    def process(self, pcm):   # mono f32 16 kHz → [AsrEvent]
        probs = self._vad_probs(pcm)                                     # per-frame Silero probs
        if self._utt is None:
            if any(p >= 0.5 for p in probs):  self._begin(...)           # new stream + 240 ms pre-roll
            else:                             self._push_pre_roll(pcm); return []
        self._feed(pcm, events)                                          # stream.feed → partial if text changed
        # trailing-silence run (per frame, not max-over-chunk) → finalize after 450 ms or 30 s cap
        if self._utt.silence_ms >= 450 or utt_len >= 30_000:  self._end(events)   # finalize → final
```

`StreamingTranscriptionService` handles the channels:

- It splits interleaved stereo (L = Me, R = Participant).
- It owns one `ThreadPoolExecutor(max_workers=1)` per channel. ctypes releases the GIL, so the channels run in true parallel.
- It **coalesces** pending audio while a channel is busy, which keeps lag bounded, as the CPU rows in §4.3 show.

`AsrEvent.to_json()`:

```json
{"type":"transcript","kind":"partial|final","speaker":"Me","utterance_id":"0e2be114c912",
 "text":"…","t0_ms":80,"t1_ms":8960,"compute_ms":84.3}
```

**Custom jargon.** Whisper's `initial_prompt` has no equivalent here. The Parakeet-unified GGUF reports `supports("vocabulary") == False` (checked), so `asr_service` passes `vocabulary=` only to models that support it. For this model the setting is ignored.

- The model emits punctuation, casing and ITN natively. "Q3" and "40%" came out correctly in testing.
- For residual mis-hearings, add a post-ASR replacement map built from `custom_jargon`, e.g. `{"cac": "CAC", "okay ours": "OKRs"}`. Apply it to finals before telemetry and persistence.

---

## 5. Live executive coaching engine (Conversate pattern)

### 5.1 Two-speed pipeline

| Path | Runs on | Latency | Output |
|---|---|---|---|
| **Fast**: `telemetry.SpeechTelemetry.ingest` | Every final utterance, inline | < 1 ms | `telemetry` event |
| **Slow**: `coach_engine.CoachingEngine` | Event triggers, single-flight | 3.4–5 s with gemma-4-e4b on M3 | 0–2 `card` events |

**Telemetry** (`telemetry.py`). All durations come from **audio time** (`t0_ms`/`t1_ms`), not wall-clock time.

- Talk share: whole meeting and rolling 5 min, target 40%.
- `my_wpm` from voiced duration.
- Fillers per minute and hedges, using word-boundary phrase regexes. The filler list is configurable from Settings `filler_words`.
- Questions asked and average wait after my question.
- Interruptions by me (an overlap with the previous speaker > 300 ms).
- Monologue seconds.
- Room sentiment: EMA of VADER compound scores on Participant speech.
- `alerts[]`:
  - `PAUSE & LISTEN`: rolling talk share > target + 15 pts (55%).
  - `LAND THE POINT`: monologue > 90 s.
  - `SLOW DOWN`: WPM > 175.
  - `CUT FILLERS`: fillers > 6/min.
  - `ROOM COOLING`: sentiment < −0.25.
  - Each alert has a minimum-speech guard so it doesn't fire early in the meeting.

**Triggers** (`TriggerPolicy`):

| Trigger | Condition | Priority | Bypasses 8 s cooldown | Default card kinds |
|---|---|---|---|---|
| `question_to_me` | Participant question addressed with "you/your" | 1 | ✅ | answer, bluf |
| `objection` | Participant objection markers + sentiment < 0.1 | 1 | ✅ | counterpoint, alignment |
| `commitment_no_owner` | "we should / let's / next step" with no owner or date | 2 | | alignment |
| `monologue` | Me > 90 s uninterrupted | 2 | | question (hand back) |
| `my_turn` | Me silent ≥ 20 s of others talking | 2 | | question, context |
| `heartbeat` | 60 s with nothing else | 3 | | risk, context |

**Single-flight and preemption.** One LLM call is in flight at a time. A higher-priority trigger **cancels** the in-flight call. In the end-to-end run, a P1 objection preempted a P2 commitment call as designed.

### 5.2 Prompt contract

The `SYSTEM_PROMPT` is **static**, so llama.cpp and LM Studio can reuse its KV cache across calls. It defines six live card kinds: `question`, `counterpoint`, `alignment`, `bluf` (Pyramid Principle: answer first, then the strongest supports), `risk` and `context`. The HUD still renders the legacy `answer` and `bio` kinds, but the model is no longer offered them because they duplicated `context`.

It also sets a four-rule quality bar:

1. **Specific:** if a card would fit any meeting, return no card.
2. **Grounded:** never invent a fact; when one is missing, ask for it.
3. **Executive voice:** no hedges.
4. **Fresh:** do not repeat anything in `ALREADY SHOWN`.

Headlines are ≤ 12 words and **speakable verbatim**. Bodies are ≤ 20 words. Code drops any headline over 18 words.

The request is OpenAI-compatible, so it works with LM Studio, Ollama, or llama-server:

```python
{"model": cached_id, "temperature": 0.3, "max_tokens": 220,
 "response_format": {"type": "json_schema", "json_schema": {"name": "cards", "schema": CARD_SCHEMA}}}
```

The user prompt puts stable context first and the task last, so the model follows the instruction it read most recently:

1. `MODE` plus a per-mode `FOCUS` lens (`MODE_FOCUS`): Fireside, Board, 1:1, Negotiation, Conflict, OKR, General
2. `AGENDA`
3. `LEADER PREFERENCES`: the optional Settings → *Coaching Instructions* field
4. `PREP NOTES`: the **top-4 lines by token overlap** with the live transcript
5. `TRANSCRIPT`: the last 120 s, capped at 2,500 characters
6. `SIGNALS`: talk share, room sentiment, monologue length
7. `ALREADY SHOWN`: the last 6 card headlines
8. `TASK`: the trigger and its guidance

**Post-meeting briefing** (`post_meeting_synthesis.py`) outputs four marked sections: Executive Summary (bottom line first), Action Items (Owner | Action | Due; never invented), Open Questions (including unanswered live coaching questions), and Strategic Reroutes (up to 3, each ORIGIN quoted verbatim). Fireside mode uses a host/guest variant.

Long meetings are not truncated. The transcript is split into chunks sized from the model's *loaded* context window (LM Studio `/api/v0/models`). Each chunk is condensed into notes in order, then the briefing is written from those notes.

### 5.3 Grounding (hallucination control)

In the first prototype, the model asserted "we have engineering bandwidth", which contradicted the prep notes. There are now two layers of defense:

1. Prompt rule: never state a number, name, capability or commitment that is absent from the TRANSCRIPT or PREP NOTES. When unsure, phrase the card as a question.
2. `is_grounded()` drops any card whose figures (`40%`, `$2.5M`, `3`, …) are not present in the prep notes, agenda, or transcript. It is unit-tested.

Cards are also deduped against the last 10 headlines (Jaccard > 0.6).

**Card shape** (`card` event):

```json
{"type":"card","id":"a1b2c3d4e5","kind":"counterpoint","headline":"Engineering capacity is a constraint we must address.",
 "body":"If we commit to Enterprise, how do we resource the migration timeline?","priority":1,"ttl_s":45,
 "trigger":"objection","created_at_ms":1793592770000}
```

**End-to-end transcript** (real server, real model, real-time audio):

```
@  9084ms FINAL Me: Let's align on the Q3 roadmap. I think we should prioritize the enterprise tier, because annual recurring revenue grew 40%
@ 12456ms CARD p2 alignment/commitment_no_owner: So, who owns the migration piece and when do we target it?
@ 13543ms FINAL Participant: I'm not sure we have the engineering capacity. Who owns the migration timeline
@ 18588ms CARD p1 counterpoint/objection: Engineering capacity is a constraint we must address.
@ 18588ms CARD p1 alignment/objection: Let's agree on the success metric for Q3.
```

**LLM cold start.** LM Studio JIT-loads models, and in the first server run the first call took more than 12 s. `MeetingSession` now fires `llm.warmup()` (a `max_tokens=1` request) when the audio socket opens.

---

## 6. HUD and teleprompter overhaul (Teleprompter pattern)

### 6.1 Window: `app/electron/hudWindow.ts`

```ts
hud = new BrowserWindow({
  width: 600, height: 340, x: centered, y: workArea.y + 4,
  transparent: true, frame: false, hasShadow: false, resizable: false,
  focusable: false,             // never steals focus from Zoom/Meet/Keynote
  skipTaskbar: true, show: false, backgroundColor: '#00000000',
  webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
})
hud.setAlwaysOnTop(true, 'screen-saver')                          // above full-screen apps
hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
hud.setContentProtection(true)                                     // invisible to screen share / recording
hud.setIgnoreMouseEvents(true, { forward: true })                  // click-through; hover re-enables
devUrl ? hud.loadURL(`${devUrl}#hud`) : hud.loadFile(indexHtml, { hash: 'hud' })
```

- It is shown with `showInactive()`.
- Hovering the panel sends `hud:interactive` → `setIgnoreMouseEvents(false)`. Leaving restores click-through.
- **Global hotkeys** are registered only while the HUD is shown:

| Shortcut | Action |
|---|---|
| ⌘⇧H | Toggle the HUD |
| ⌘⇧← / ⌘⇧→ | Previous / next card |
| ⌘⇧X | Dismiss the card |
| ⌘⇧L | Lock the deck |

**Preload** (`app/electron/preload.ts`). This replaces the raw `ipcRenderer` bridge with an allowlist:

```ts
contextBridge.exposeInMainWorld('eloquent', {
  showHud: (meetingId: number, script?: string) => ipcRenderer.send('hud:show', meetingId, script ?? ''),
  hideHud: () => ipcRenderer.send('hud:hide'),
  setHudInteractive: (on: boolean) => ipcRenderer.send('hud:interactive', !!on),
  onHudMeeting: (cb) => subscribe('hud:meeting', cb),
  onHudScript:  (cb) => subscribe('hud:script', cb),
  onHudCommand: (cb) => subscribe('hud:command', cb),
})
```

**`electron/main.ts` changes** (already applied in the reference copy):

- Removed the global `set-always-on-top` handler.
- Added `registerHudIpc(...)` in `whenReady`.
- `certifiEnv()` discovers `lib/python3.x` dynamically.
- `startPythonBackend()` is guarded so `activate` cannot spawn a second backend.
- Shortcuts are unregistered on `will-quit`.

### 6.2 Renderer

| File | Role |
|---|---|
| `src/main.tsx` | `#hud` hash, which lazy-loads `HudApp` |
| `src/hud/protocol.ts` | Shared event types |
| `src/hud/useCoachEvents.ts` | `/ws/events` subscription with exponential-backoff reconnect |
| `src/hud/cardDeck.ts` | Pure teleprompter **deck reducer** |
| `src/hud/scriptAligner.ts` | **Voice-following** script pointer and pagination |
| `src/hud/HudApp.tsx` + `hud.css` | Overlay UI: telemetry strip, alert line, active card with TTL bar, queue badge, teleprompter page, live caption |
| `src/hud/transcriptStore.ts` | Partial-in-place upsert by `utterance_id`, capped at 200 lines (main window) |
| `src/hud/useDualChannelCapture.ts` | AudioWorklet capture hook (replaces `ScriptProcessorNode`) |
| `public/pcm-capture-worklet.js` | Audio-thread framing (80 ms / 1280 samples × 2 ch); mute via `port.postMessage` |

**Deck rules** (`cardDeck.ts`, unit-tested in `app/tests/hud.test.ts`):

- Queue order is priority, then newest first. The queue is capped at **6**.
- An incoming higher-priority card **preempts** the active one, except while the user is delivering it (pinned) or the deck is locked.
- When "Me" says ≥ 50% of the active headline's content words, the card is marked **used** and **pinned**. When I stop speaking (final), the deck **advances**.
- TTL is 45 s for P1 and 75 s otherwise. Expiry is skipped while the card is pinned or locked, and the TTL bar pauses.
- `next`/`prev` rotate through the queue. `dismiss` promotes the next card.

**Teleprompter** (`scriptAligner.ts`). This is for prepared remarks, such as an opening statement or a board update.

- The script is pushed via `showHud(meetingId, script)`.
- The pointer advances only when the **last 6 spoken tokens** match the script at ≥ 60% within a **40-word look-ahead window**. It never moves backwards.
- Pages are about 28 words, split at sentence boundaries, and **auto-flip** as the pointer crosses them. Read words dim, and the next word is underlined.

### 6.3 Main-window changes (`LiveMeetingView.tsx`)

```tsx
const { start, stop } = useDualChannelCapture(isMuted)      // mute now works (worklet port, no stale closure)
const [lines, setLines] = useState<Line[]>([])
useCoachEvents(meetingId, (e) => {
  if (e.type === 'transcript') setLines(prev => applyTranscript(prev, e))
  else if (e.type === 'card') setInsights(prev => [e, ...prev].slice(0, 5))
  else if (e.type === 'telemetry') setMetrics(e)
})
// on start:  await start(id, setConnectionStatus); window.eloquent?.showHud(id, prepScript)
// on stop:   stop(); window.eloquent?.hideHud()
```

Make these changes:

- Delete the inline HUD `<div>` (lines ~300–420), the `set-always-on-top` call, and the `ScriptProcessorNode` block (lines 70–165).
- Talk ratio, WPM and fillers now come from `telemetry` events. Don't recompute word counts on every render.

---

## 7. Backend integration: `main.py` changes

`backend/realtime.py` contains `EventBus`, `RealtimeConfig`, `MeetingSession`, and the two WebSocket routes. Wire it in as follows.

```diff
-import ssl
-import httpx
-# Monkey patch httpx to disable SSL verification globally ...
-original_init = httpx.Client.__init__
-def patched_init(self, *args, **kwargs):
-    kwargs['verify'] = False
-    original_init(self, *args, **kwargs)
-httpx.Client.__init__ = patched_init
+import realtime
-from transcription_service import TranscriptionService
-from insight_engine import InsightEngine
 ...
 app = FastAPI(title="Eloquent Coach API")
-app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, ...)
+app.add_middleware(CORSMiddleware,
+    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "file://", "null"],
+    allow_credentials=False, allow_methods=["*"], allow_headers=["*"])
+app.include_router(realtime.router)

 def init_default_settings(db):
     defaults = {
         "llm_api_url": "http://127.0.0.1:1234/v1",
-        "whisper_model": "distil-small.en",
-        "whisper_compute_type": "int8",
+        "llm_model": "",                 # empty = first non-embedding model reported by /models
+        "asr_profile": "auto",           # auto (planner, §11) | ultra | low | balanced | accurate
+        "asr_backend": "auto",           # auto (planner, per channel) | gpu | cpu
+        "asr_adaptive": "true",          # runtime governor on/off
         ...

 @app.on_event("startup")
-def on_startup():
+async def on_startup():
     ...
-    transcription_svc = TranscriptionService(...)
+    asyncio.create_task(realtime.warmup())     # GGUFs, hardware probe, cached calibration
+                                               # (or a background one), power polling

-@app.websocket("/ws/audio/{meeting_id}")          # delete: audio_websocket, transcription_worker,
-...                                                #         run_insight_pipeline, active_insight_tasks
```

`SettingsUpdate` and `update_settings`:

- Replace `whisper_model`/`whisper_compute_type` with `asr_profile`, `asr_backend`, `asr_adaptive`, and `llm_model`.
- **Delete** the Whisper hot-reload block. ASR settings are read when each meeting's audio socket opens, so there is nothing to reload.
- In `SettingsView.tsx`:
  - Replace the Whisper model/compute panel with `app/src/components/AsrSettingsPanel.tsx`: `<AsrSettingsPanel value={settings} onChange={p => setSettings({...settings, ...p})} />`. It reads `/asr/status`, shows the recommended plan with reasons, labels each option with this machine's estimated latency, validates manual choices via `/asr/validate`, and offers "Re-measure this machine" (§11.6).
  - Add an LLM model field.
  - Remove the `insight_interval` setting, since triggers are event-driven.

`end_meeting`:

- Keep `PostMeetingSynthesis`.
- `metrics_engine.update_metrics` is still called for the reports. Fix its pacing so it uses `sum(end_ms - start_ms)` from the new columns instead of `words/150`.

**Database** (`backend/database.py`):

- WAL + `synchronous=NORMAL` via a connect-event pragma.
- `transcripts.start_ms`, `end_ms`, `utterance_id` columns.
- Idempotent `ALTER TABLE` migrations in `init_db()`.
- Final transcripts are written with `timestamp = meeting.start_time + t0_ms`, so they are audio-aligned. The transcript file gets `[hh:mm:ss]` meeting-relative stamps.

**Electron dev flow.** After recreating the venv (§4.4), `npm run dev` in `app/` spawns `backend/venv/bin/python -m uvicorn main:app`. That command is unchanged.

---

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **GPU contention** with a local LLM (measured: pinned `ultra` lagged by up to 20.7 s) | §11. The planner budgets the GPU for the LLM and offloads the room channel to CPU. The governor steps down within ~5 s (measured: max lag 1.5 s under the same load). The coach defers P2/P3 cards under pressure |
| **Wrong manual configuration** | `auto` is the default. Manual pins are honoured but validated against this machine's calibration with plain-language warnings; the governor still protects a pinned profile unless adaptive mode is switched off |
| Calibration cost / staleness | ~25 s once per machine fingerprint (chip, cores, RAM, devices, engine version), in the background, never during a meeting; cached 30 days; conservative heuristic plan until done |
| **Echo**: speaker bleed puts the room's words on the "Me" channel | `echoCancellation: true` on the mic constraint (done in `useDualChannelCapture`); recommend headphones; later, suppress "Me" finals whose text matches a Participant utterance within ±1 s |
| LLM hallucination | Grounding prompt + `is_grounded()` number filter + prep-note retrieval; cards are phrased as questions when unsure |
| LLM latency (3–5 s) | Event triggers + P1 preemption + warmup; pre-generate opening talking points from agenda/prep notes at meeting start as P3 cards |
| **Model licence** | Parakeet weights are under NVIDIA's model licence (check the HF card for `parakeet-unified-en-0.6b` before commercial distribution); transcribe.cpp is MIT |
| First Metal shader compile (~4 s) | `realtime.warmup()` at startup; optionally run a 1 s silent `feed()` |
| 732 MB download | Lazy on first meeting, cached; `ELOQUENT_ASR_MODEL` lets a packaged app bundle the file in `resources/` |
| `setContentProtection` limits | Works on macOS/Windows for standard capture APIs; **not** guaranteed against hardware capture or every conferencing app's legacy capture path. Document it for users |

---

## 9. Phased roadmap

| Phase | Scope | Exit criteria |
|---|---|---|
| **0. Unblock** (½ day) | Recreate the venv on 3.13; fix the `electron/main.ts` certifi path and double spawn; remove the TLS monkey-patch; tighten CORS | `npm run dev` starts the backend cleanly |
| **1. ASR swap** (1–2 days) | Add `asr_service.py`, `realtime.py`, and the `database.py` migration; wire `main.py` (§7); delete `transcription_service.py` and `audio_capture.py`; run `tests/bench.py` | `bench.py balanced` p95 < 300 ms; transcripts persisted with `start_ms` |
| **1b. Hardware-adaptive ASR** (1–2 days) | Add `hardware.py` and `adaptive.py`; the patched `asr_service.py`/`realtime.py`/`coach_engine.py`; the `/asr/*` endpoints; `AsrSettingsPanel`; the HUD ASR badge | `tests/test_adaptive.py` passes; `tests/e2e_ws.py` under `tests/llm_load.sh` keeps Me's max lag < 2 s |
| **2. Capture** (½ day) | AudioWorklet + `useDualChannelCapture` + `transcriptStore` in `LiveMeetingView` | Partials update in place; mute works; no main-thread audio callback |
| **3. Coaching** (1–2 days) | Add `telemetry.py` and `coach_engine.py`; retire `insight_engine.py` live use; fix `metrics_engine` pacing; update Settings | `tests/test_coach.py` passes; cards within 5 s of a trigger |
| **4. HUD** (2 days) | `hudWindow.ts`, the new preload, `src/hud/*`, remove the inline HUD | HUD invisible in a Zoom/Meet screen-share test; hotkeys work; `tests/hud.test.ts` passes |
| **5. Optional** | Rust sidecar (`transcribe-cpp` crate) or a Tauri port, à la Handy; diarisation inside the "Participant" channel; pre-meeting talking-point generation; Windows WASAPI loopback (replaces BlackHole) | – |

---

## 10. How to re-run the validation

```bash
# backend (after §4.4 venv setup)
cd backend
venv/bin/python tests/test_coach.py           # telemetry, triggers, engine, grounding
venv/bin/python tests/bench.py balanced         # ASR at real-time pace (add 'cpu' as 2nd arg)
ASR_E2E=1 venv/bin/python tests/test_adaptive.py # planner + governor (+ live GPU→CPU swap)

# end-to-end + contention (server running on :8000 with a meeting row, LM Studio on :1234)
bash tests/llm_load.sh 80 & venv/bin/python tests/e2e_ws.py <meeting_id> 3 8000

# frontend
cd ../app
npm test                                                            # deck reducer + aligner (Node ≥ 22.18)
npm run typecheck                                                   # renderer + Electron
```

---

## 11. Hardware-adaptive ASR (no hand-tuned configs)

**Question this answers:** is Handy's engine worth it if it can slow the laptop down, and can the app configure itself for the hardware it runs on?

**Answer: yes, it's worth it.** The engine's cost depends on the **step rate** you choose, not on Parakeet itself:
- On this M3 one `ultra` channel uses 46% of the GPU, while `balanced` uses 6%.
- faster-whisper was CPU-only on macOS and had a 1.5 s buffer floor regardless of hardware.

Speed is therefore something to budget for, not a reason to stay on Whisper. The rule is to **measure the machine, plan within a budget, and keep watching**. Ultra is never on by default when a local LLM shares the GPU; it is chosen only when the measurements say it fits.

```
startup ─► hardware.probe_hardware()      chip, cores, RAM, GPU devices (transcribe_cpp.backends())
        ─► adaptive.load_cached()         per-machine fingerprint; else calibrate in background (~25 s)
meeting ─► adaptive.recommend()           per-channel (device, profile) under a duty budget
        ─► AdaptiveController.observe()   live lag per channel → degrade / split / CPU fallback / recover
        ─► LlmCoordinator                 coach yields the GPU to ASR under pressure
every 30 s ─► read_power_state()          battery / Low Power Mode / thermal → re-plan
```

### 11.1 Hardware and power probe: `hardware.py`
- **macOS:** `sysctl` (chip, performance cores, RAM) and `pmset` (battery, Low Power Mode, thermal warning).
- **Linux:** `/proc`.
- **Windows:** `psutil`, if installed.
- **Devices** come from `transcribe_cpp.backends()`, so CUDA, Vulkan and ROCm machines work without code changes.
- `llm_is_local(url)` decides whether the LLM competes for the same GPU.

### 11.2 Calibration: `adaptive.calibrate()`
Calibration measures **duty**: seconds of compute per second of audio. It runs every device × profile, both solo and with both channels running. It feeds a band-limited synthetic speech signal at 80 ms frames:
- warm-up first, which absorbs the one-time Metal shader compile;
- from cheapest to most expensive profile;
- it stops at the first profile that can't keep up.

Results are cached in `~/.eloquent-coach/asr_calibration.json` (override with `ELOQUENT_STATE_DIR`), keyed by a hardware + engine-version fingerprint, for 30 days. Calibration runs in the background at startup and is **cancelled when a meeting starts**. `POST /asr/calibrate` re-runs it and is refused (409) during a meeting.

Measured on this M3 (16 GB, on battery). It took **24–26 s**.

| Device | ultra (solo / pair) | low | balanced | accurate |
|---|---|---|---|---|
| Metal | 0.46 / 0.69 | 0.22 / 0.36 | 0.06 / 0.09 | 0.02 / 0.03 |
| CPU | 1.07 / 2.14 ❌ | 0.50 / 1.37 | 0.16 / 0.26 | 0.04 / 0.10 |

The synthetic signal costs the same as real speech: `low` 0.348 vs 0.352, `balanced` 0.097 vs 0.099. Calibration therefore needs no microphone and no recording.

### 11.3 Planner: `adaptive.recommend()` and `validate()`
**Budget per channel** (the maximum sustainable duty):
- GPU 0.60, or **0.35 when a local LLM shares it**;
- CPU 0.50;
- ×0.8 on battery;
- ×0.5 under Low Power Mode or a thermal warning.

**Roles:**
- **Me** can use any profile. It drives the live caption and the teleprompter.
- **Participant** is limited to `balanced` or `accurate`. Its words only feed the 3–5 s LLM, so it never needs more speed.

**Search:** all device/profile combinations, ranked lexicographically by:
1. fastest profile for Me;
2. `balanced` for the room;
3. Me on the GPU;
4. least GPU load, which leaves the GPU to the LLM.

If nothing fits, the planner falls back to `accurate` with an honest warning. Until calibration finishes, a heuristic is used: `balanced` with a local LLM, `low` otherwise, never `ultra`.

What it chose on this M3, recorded with live hardware and covered by `tests/test_adaptive.py`:

| Situation | Me | Participant | Why |
|---|---|---|---|
| Remote LLM, AC power | GPU · **ultra** (~240 ms) | CPU · balanced | GPU is ours; the room is moved off it |
| Remote LLM, battery | GPU · **ultra** | CPU · balanced | 0.46 ≤ 0.48 |
| Local LLM, AC or battery | GPU · **low** (~400 ms) | CPU · balanced | ultra 0.46 > 0.35 (or 0.28 on battery) |
| Local LLM, Low Power Mode | GPU · balanced | CPU · balanced | low 0.22 > 0.175 |
| M3 Max (synthetic table) | GPU · ultra even with a local LLM | – | headroom |
| CPU-only laptop (synthetic) | CPU · balanced | CPU · balanced | nothing faster fits |

**`validate()` is the Settings guardrail.** A manual choice is **honoured, never blocked**, and returns plain-language warnings. For example:
- "'ultra' on gpu uses 72% of gpu time per channel (budget 28%); expect lag spikes while the LLM generates…"
- "'low' on cpu can't keep up on this machine (needs 1.37 s compute per 1 s of audio)."

### 11.4 Runtime governor: `adaptive.AdaptiveController`
`StreamingTranscriptionService` calls `monitor(speaker, lag_ms, audio_ms, in_utterance)` after every step. Lag is measured from when the oldest sample in the batch arrived until it was processed, and only samples taken during speech count.

| Rule | Value |
|---|---|
| Lag limit | Me 300 ms, Participant 900 ms |
| Degrade (one profile slower) | ≥ 6 of the last ≥ 10 samples over the limit |
| Severe (> 1.5 s) | degrade **and split the current utterance** so the new profile applies immediately; cancel any in-flight P2/P3 LLM call |
| At `accurate` on GPU and still behind | load a CPU engine off-thread, **hot-swap at the next pause** (`switch_device`) |
| Cooldown after any change | 8 s. Samples taken during the cooldown are ignored, because they reflect the old profile |
| Recover (one profile faster, or back to the planned device) | after 60 s calm, only if calibration says the target fits, never while an LLM call is in flight |
| Flapping | a degrade within 120 s of a recovery doubles the required calm period, up to 10 min |
| Power/thermal change | `update_plan()` lowers the ceiling immediately |

The HUD receives `asr_status` events. It stays silent while healthy and shows a small amber `⏷ ASR BALANCED` tag only when the governor has traded latency for stability.

### 11.5 LLM coordination: `coach_engine.LlmCoordinator`
- **P1 cards** (a question to me, an objection) always run.
- **P2/P3 cards** are **deferred** in either of these cases:
  - while the governor reports pressure;
  - when the LLM is local and I'm mid-sentence.
- The highest-priority deferred trigger fires on a later final, once the gate clears. Deferrals expire after 20 s.
- Under pressure, `max_tokens` drops from 220 to 160.
- While a local call is in flight, `external_load` blocks ASR recovery, so the two don't oscillate.

### 11.6 Settings and API
- `asr_profile`: `auto` (default) | ultra | low | balanced | accurate
- `asr_backend`: `auto` (default, per-channel) | gpu | cpu
- `asr_adaptive`: `true` (default) | false

The endpoints:
- `GET /asr/status` returns:
  - hardware, power and calibration;
  - the recommended plan with reasons;
  - every option with this machine's estimated latency and budget fit;
  - live governor state per meeting.
- `POST /asr/validate {asr_backend, asr_profile}` returns the plan and warnings.
- `POST /asr/calibrate` starts a re-measurement (returns 202).

### 11.7 End-to-end contention test
Setup:
- the real server, WebSocket audio paced in real time, 45 s of 2-speaker audio;
- LM Studio `gemma-4-e4b` saturated by 4 parallel 500-token generations (`tests/llm_load.sh`).

| Config | Me partial lag p50 / p95 / **max** | Finals delivered | Governor |
|---|---|---|---|
| No contention, auto plan | −4 / 17 / **21 ms** | 2/2 | – |
| Pinned `ultra`, adaptive off | 3.2 s / 17 s / **20.7 s** | 1 of 3 Me finals during the run | – |
| **Auto + adaptive** | 123 / 846 / **1494 ms** | **6/6, on time** | low → balanced at +5 s |

Two problems found and fixed during this test:
- **Under GPU contention, model load took 13–20 s.** The audio socket wasn't read during that time, which stalled WebSocket keepalive pings. `/ws/audio` now keeps reading and buffers up to 30 s of audio while the session loads.
- **The `/ws/audio` socket also streams events back.** Scripted clients (e.g. Python `websockets`) must read it, otherwise their receive queue fills, pongs go unseen and the keepalive times out after ~40 s. Browser WebSockets always consume incoming frames, so `useDualChannelCapture` is unaffected. `tests/e2e_ws.py` drains it explicitly.

### 11.8 Recommendation
- Keep **Auto + adaptive** as the default. Expose manual pins only behind the guardrail warnings.
- If the local LLM and this app are the only GPU users, the planner already gives Me `low` (~400 ms) and moves the room to CPU. A remote or larger-GPU setup earns `ultra` automatically.
- A user who wants to force `ultra` with a local LLM can do so. The warning tells them what it costs, and the governor still protects the meeting unless they turn adaptive mode off.
