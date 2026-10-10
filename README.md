# ChatGPT Button (Windows prototype)

Hold the Copilot key to record. Release it to transcribe locally with whisper.cpp, then send the transcript to Codex app-server. A single Codex turn cleans the question and generates an answer in a persistent conversation. Hear the reply through Windows SAPI or local Piper TTS. Press the key again while the reply is playing to interrupt it. `npm start` runs the voice loop together with an Electron conversation panel and desktop orb, using the signed-in Codex account without an `OPENAI_API_KEY`. `npm run start:cli` runs the terminal-only voice loop with the same default app-server backend. The assistant is currently instructed to clean questions and answer in Polish.

## Requirements

The default `VOICE_MODE=local` uses the ChatGPT subscription. An optional experimental `VOICE_MODE=realtime` sends microphone audio directly to Codex app-server and plays its streamed audio reply. See **Codex realtime audio** below for its separate API-key requirements.

The orb displays **LOCAL** for local Whisper/TTS or **API** for Codex realtime. The engine is selected once at startup from `.env`; restart the application after changing `VOICE_MODE`. LOCAL refers to speech processing, while Codex still generates the answer. Each mode retains its own conversation history and authentication configuration.

Voice orchestration lives in `src/voice/local-engine.ts` and `src/voice/realtime-engine.ts`, behind the contract in `src/voice-engine.ts`. `src/voice/create-engine.ts` constructs and validates the selected services. `src/main.ts` handles the microphone, gestures, conversation controls and UI events through that shared contract. `npm test -- test-voice-engine.ts` checks stage ordering, cancellation, partial transcripts, lifecycle and startup selection without inference requests.

- Windows 11, Node.js 22.18+, PowerShell 5.1, FFmpeg with DirectShow input.
- A working microphone visible to FFmpeg.
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) `whisper-server.exe` for the default mode, plus a multilingual GGML model such as `ggml-small.bin`. Keep `whisper-server.exe` beside the executable specified by `WHISPER_BIN`, put it on `PATH` when using the default binary name, or set `WHISPER_SERVER_BIN` explicitly. `whisper-cli.exe` is needed for `STT_MODE=cli` and the STT benchmark. English-only `.en` models cannot transcribe Polish.
- [Codex CLI](https://learn.chatgpt.com/docs/app-server), available as `codex.cmd` on `PATH`, with your existing ChatGPT login (`codex login` if needed). The default backend uses ephemeral app-server threads. `CODEX_MODE=cli` uses `codex exec --ephemeral`; the application supplies prior messages as context.
- A Polish Windows SAPI voice for the default TTS mode, or Piper and FFplay for local neural speech. The app selects an installed Polish SAPI voice automatically. To choose a specific installed voice, set `CHATGPT_BUTTON_VOICE` in `.env` to part of its name, for example `CHATGPT_BUTTON_VOICE=Paulina`. List SAPI voices with `powershell -NoProfile -Command "$v=New-Object -ComObject SAPI.SpVoice; $v.GetVoices() | ForEach-Object { $_.GetDescription() }"`.

## Configure and run

Run commands from the repository root. Install dependencies first:

```powershell
npm.cmd install
```

The first Electron launch may download its official runtime binary.

### Osobna historia aplikacji

Conversation data lives under `%LOCALAPPDATA%\ChatGPTButton`, independent of the
project directory. `CHATGPT_BUTTON_DATA_DIR` in `.env` can override that root.
The Electron host and voice worker use the same path. LOCAL, realtime and
realtime's ImageGen worker have separate `local-codex`, `realtime-codex` and
`imagegen-codex` storage directories. Only realtime audio uses its directory as
`CODEX_HOME` and `CODEX_SQLITE_HOME`, isolating API-key authentication.
LOCAL and ImageGen use your existing Codex account and configuration, with
ephemeral threads that stay outside the standard Codex/VS Code history.
Existing shared history and the old project-local realtime data are left intact;
they are not imported into the new homes or automatically deleted.

LOCAL and ImageGen need no additional login if Codex is already signed in:

```powershell
codex login # only if not already signed in
```

Realtime audio still uses `OPENAI_API_KEY`. Choose the model with `CODEX_MODEL` or your normal
Codex configuration. Old private Codex histories are left intact.

Each home's `session.json` stores only current/previous thread IDs and timestamps.
The popup's **Wróć do poprzedniej rozmowy** control works after reset, expiry and
restart. LOCAL and ImageGen messages are stored in application-owned `<id>.json`
files and supplied as context to fresh ephemeral turns. Realtime messages are
read from its isolated Codex history, including paginated history.
Empty conversations do not enable undo; failed reads preserve the selected
conversation. Context still expires two minutes after the last successful answer.

Registered application history files (and realtime threads via `thread/delete`) are deleted
after **24 hours without activity**. Cleanup runs at startup, before requests and
once a minute while the app is idle. It does not interrupt active requests; failed
deletions are retried. When the app is closed, cleanup runs at its next start.
Linked image tasks remain available while a retained conversation references them.
Expired image links and PNGs without another retained reference are also removed.
Deletion is limited to IDs in the private home's `history-index.json`; it never
lists or deletes standard Codex/VS Code history.

Use **Zapisz rozmowę…** in the tray/orb context menu to keep the selected conversation
as a Markdown file. The export embeds generated PNGs and survives automatic cleanup;
some Markdown viewers do not render embedded data-URL images. It is a readable export,
not an importable Codex session. Saving is unavailable while a response is running.

```powershell
npm.cmd run diagnose:keys
```

Hold and release Copilot. Read the `vk` of its DOWN and UP events. F23 is `134`, but use what your machine actually reports. If the key emits several events, choose the virtual key that stays down for the entire hold.

```powershell
npm.cmd run diagnose:devices
```

Set the exact DirectShow audio device name from the output. The diagnostic uses `FFMPEG_BIN` from `.env` when configured and treats FFmpeg's expected nonzero exit after successful device listing as success. Copy `.env.example` to `.env`, then set `MIC_DEVICE`, `WHISPER_BIN`, `WHISPER_MODEL`, and `COPILOT_VK`:

```powershell
Copy-Item .env.example .env
```

Node loads `.env` when present for `npm start`, `npm run start:debug`, and `npm run start:cli`; no shell exports are needed. `.env` is ignored by Git. Missing or invalid setup is reported in the panel with a restart action; detailed service diagnostics remain in the terminal.

```powershell
npm.cmd start
```

In Git Bash, use `cp .env.example .env` to create the configuration and run `npm start`. Use `npm` instead of `npm.cmd` for the other commands.

To inspect recognition and speech output, run `npm.cmd run start:debug` instead of `npm.cmd start` (in Git Bash, `npm run start:debug`). Both modes print the cleaned question and the full AI answer; TTS skips fenced code blocks. Debug mode additionally prints the raw transcription, audio levels, timing measurements, and Codex thread ID. `Ctrl+Shift+N` starts a new conversation; `Ctrl+C` exits. Context expires 2 minutes after the last successful answer; the next voice or text question starts a new conversation. Restart resumes within that window; after expiry, use the previous-conversation control while its history is still retained.

Only debug mode prints `[time]` measurements. Its main total is `Recording end to playback start`, measured from Copilot key release until the selected player reports active playback. The contiguous components are recording finalization, STT, Codex, and TTS startup to playback; they add up to that total apart from display rounding. Codex request acceptance and turn generation are nested details within the Codex component. Debug also reports playback duration and the full cycle. SAPI's audio queue status and FFplay's audio clock are approximate playback markers, not speaker-loopback measurements of the first audible sample. Console status messages and labels are in English; the assistant currently returns Polish questions and answers.

### Backend and model settings

| Setting | Default | Effect |
| --- | --- | --- |
| `CODEX_MODE` | app-server (unset) | Set `cli` to generate answers with a separate `codex exec` process per question. History still uses app-server. |
| `CODEX_MODEL` | Private Codex home configuration/default | Override the model for new and resumed conversations in both backends; for example, `gpt-6-luna` if available to your account. |
| `CODEX_EFFORT` | `low` | Reasoning effort for app-server turns; for example, `medium`. The CLI fallback does not pass this setting to Codex. |
| `STT_MODE` | server (unset) | Keep the Whisper model loaded between questions. Set `cli` to launch `whisper-cli.exe` for each transcription. |
| `WHISPER_SERVER_BIN` | Beside an absolute `WHISPER_BIN`, otherwise on `PATH` | Override the location of `whisper-server.exe`. |
| `WHISPER_THREADS` | Whisper default | Positive integer for CPU threads in either STT mode. Benchmark before choosing it. |
| `STT_LANGUAGE` | `pl` | Whisper recognition language; this does not change the assistant's Polish response instructions. |

`start:cli` selects the terminal interface; `CODEX_MODE=cli` selects the answer backend. These settings are independent. Both Codex backends request structured JSON containing the cleaned question and full answer. New threads use a read-only sandbox, and app-server turns explicitly enforce it.

### Codex realtime audio

Codex CLI **0.161.0** provides experimental `thread/realtime/*` methods. A live startup check with ChatGPT authentication returned `realtime conversation requires API key auth`. This mode therefore requires an OpenAI API key and uses API billing separately from the ChatGPT subscription. The default local mode continues to use the signed-in ChatGPT account.

Add to `.env`, keeping your existing `MIC_DEVICE` and `COPILOT_VK`:

```dotenv
VOICE_MODE=realtime
OPENAI_API_KEY=your-api-key
# Optional: CODEX_REALTIME_VOICE=alloy
# Optional: CODEX_REALTIME_MODEL=your-supported-realtime-model
# Optional: FFPLAY_BIN=C:\path\to\ffplay.exe
```

Run `npm start` or `npm run start:cli`. FFmpeg, FFplay and Codex CLI must be available. Whisper, its model, SAPI and Piper are not started in this mode. Remove `CODEX_MODE=cli` if set. The realtime model uses Codex's realtime default unless `CODEX_REALTIME_MODEL` overrides it; `CODEX_MODEL` still selects the model for typed questions.

Hold Copilot to record and release it to upload the utterance. The app converts the recording to mono PCM16 at 24 kHz, adds a short silence tail for voice activity detection, and uses the **v2** realtime protocol over the existing stdio app-server connection. Audio starts playing as chunks arrive through FFplay. A final transcript followed by a 250 ms quiet window ends the output stream; the player drains queued audio before returning to idle. Pressing Copilot again, cancelling or resetting stops playback and closes the current realtime session. Recordings are limited to 60 seconds. The conversation panel displays question and answer transcripts as soon as Codex sends them, updating partial text during audio playback. Completed transcript segments are also displayed immediately; the full answer need not wait for playback to finish. The exchange is saved to application history after playback completes. Typed questions continue to use normal text turns without spoken playback.

Each voice request creates a new realtime session and includes all saved exchanges from the selected conversation in its prompt, including voice transcripts and typed replies. History is loaded from Codex after an application restart and when restoring a previous conversation. Resetting the conversation or the existing two-minute inactivity expiry starts an empty context; restoring the previous conversation brings its context back. Generic realtime startup context forwarding is disabled. Longer histories increase API input usage and remain subject to the audio model's context limit. Typed questions retain the normal Codex thread behavior.

Realtime uses `%LOCALAPPDATA%\ChatGPTButton\realtime-codex` as its dedicated Codex home, including API credentials, history, retention index and `session.json` metadata. The account login RPC stores the API key in that dedicated home's credential store. History is restored from Codex's paginated timeline, including voice transcripts and typed answers. The two-minute expiry, durable previous-conversation control and 24-hour retention also apply to this separate session.

Available `CODEX_REALTIME_VOICE` values in 0.161.0: `alloy`, `arbor`, `ash`, `ballad`, `breeze`, `cedar`, `coral`, `cove`, `echo`, `ember`, `juniper`, `maple`, `marin`, `sage`, `shimmer`, `sol`, `spruce`, `vale`, `verse`.

`npm test -- test-realtime.ts` checks PCM conversion, malformed audio, asynchronous startup failures, playback completion, cancellation, serialized teardown, timeline history and conversation context without an API key. `npm run test:integration -- test-realtime-wire.ts` additionally checks the installed app-server, FFplay and follow-up context after restart and reset against a local simulated WebSocket backend using an isolated temporary home and a dummy key; it requires Codex and FFplay on PATH. This smoke test does not make paid inference requests. A complete conversation against the real audio service still requires a valid API key.

Switch back with `VOICE_MODE=local` or remove `VOICE_MODE`.

### Try Piper TTS

Download the [Windows x64 Piper package](https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip) and a Polish voice's `.onnx` and `.onnx.json` files, for example [Gosia medium](https://huggingface.co/rhasspy/piper-voices/tree/main/pl/pl_PL/gosia/medium). Extract Piper, keep both voice files together, and set these values in `.env` (replace paths with your locations):

```dotenv
TTS_MODE=piper
PIPER_BIN=C:\path\to\piper\piper.exe
PIPER_MODEL=C:\path\to\pl_PL-gosia-medium.onnx
```

FFplay must be available on `PATH`, or set `FFPLAY_BIN` to its executable. The app pipes Piper's 16-bit mono PCM into FFplay as it is synthesized and reads the sample rate from the voice JSON. Piper runs locally without an API key. Switch back with `TTS_MODE=sapi`. On this machine, the trial files are under `.chatgpt-button/piper/` and are ignored by Git.

To compare Whisper CPU thread counts on exactly the same speech, add `SAVE_AUDIO=1` to `.env`, record one question, and use the printed WAV path with `npm run bench:stt -- "C:\path\to\recording.wav"`. The script loads the configured model with 4 and 8 threads and transcribes the WAV twice per setting. Compare the second run and its text; model loading is shown separately. Set `WHISPER_THREADS` in `.env` to the faster value, then remove `SAVE_AUDIO=1` when finished. Results vary with the machine, audio length, and system load; `.env.example` leaves the thread count unset.

## Blue orb visual prototype

Run `npm run preview:web` and open http://127.0.0.1:4173 to preview a ChatGPT-inspired blue orb. The Polish demo switches between idle, listening, and speaking animations and includes a pause control. It is a standalone visual simulation with no microphone or voice-loop connection, no new dependencies, and reduced-motion support.

Import `preview/voice-orb.js` as a browser module (keep `orb-renderer.js` beside it) and use `<voice-orb state="idle"></voice-orb>`. Set `state` to `idle`, `listening`, or `speaking`, add `paused` to freeze the animation, and customize size with `--orb-size`. WebGL renders flowing blue and white clouds using domain-warped noise, with simulated speech activity and smooth state changes. Reduced motion renders a still frame; unsupported WebGL or context loss displays a static CSS fallback. Animation stops while hidden or offscreen and GPU resources are released when the component is removed.

The orb defaults to 45 CSS px with a 9 × 9 drawing buffer, independent of screen pixel density; the browser scales the interior smoothly. Set `render-scale="0.5"` or `render-scale="1"` for more detail (accepted range 0.1–1, default 0.2, maximum buffer size 256 × 256). Color transitions have asymmetric, varying widths, and speaking gradually blends them into wider flowing currents; activity is still simulated.

Only the orb's color field is rendered at reduced resolution. The circular edge is clipped by CSS at the full display resolution, so lowering `render-scale` softens the interior without pixelating the outline.

### Desktop orb (Electron)

`npm start` starts the real voice services with the conversation popup hidden. The
orb is hidden while idle and during startup. It appears when recording starts,
stays visible through transcription, answer generation and speech. It remains
visible while the pointer is over the orb or popup; leaving both hides them after
one second. A new recording cancels stale hide requests. Click
the tray icon to reopen the popup at any time. Hover over the visible orb to show
the frameless conversation popup above it without taking focus. Move into the
popup to read or use its controls; leaving both surfaces dismisses it after a
short delay. Use **Przypnij popup** to keep the panel open when the pointer leaves;
Escape dismisses it and clears the pin. Press the orb to open text chat; press it again to return to the
compact latest-exchange view, preserving the draft. Press Escape to dismiss it.
Window focus changes do not close the conversation.
The dark hover popup shows the latest question and answer, with no answer-generation
status text. A short Copilot press (under 250 ms) shows the orb and a focused popup
containing only the text input, hiding earlier messages until the next question.
Holding Copilot for at least 250 ms records a voice question; audio is collected
from key-down to preserve its beginning, and a short tap discards it without transcription.
This tap/hold distinction applies to the desktop app; terminal mode records every
Copilot press until release.
Clicking the orb or tray reveals the conversation and a text composer: Enter sends,
Shift+Enter adds a newline. Typed questions continue the same Codex conversation
and receive a text reply without speech playback. The composer has no send or cancel button.
Recording uses Copilot; **Nowa rozmowa** remains in the tray menu.
Replies can include Markdown code blocks and inline code in both the latest
answer and conversation history. Blocks preserve indentation, omit language headers,
scroll horizontally for long lines and offer **Kopiuj**. Voice playback reads the
explanation and skips code blocks; code-only replies direct you to the popup.
`npm test -- test-answers.js` verifies parsing and speech filtering.
While the voice application runs, its keyboard hook consumes the configured
`COPILOT_VK` press and release, preventing the corresponding Windows action.
Other keys pass through. Exiting releases the hook, including after an unexpected
Node process exit. `npm run diagnose:keys` starts only a passive keyboard observer and does not suppress keys;
the isolated orb preview does not install a keyboard hook.
Closing the panel hides it without stopping services; **Zakończ** in the tray
menu quits and shuts down the microphone, keyboard hook and voice workers.
The microphone remains active between questions, as in terminal mode; only
question recording retains samples. Conversation text is held in memory in the
main process and renderers for display; the session file contains only metadata,
while Codex retains its own history.

The following `npm run preview:desktop` mode remains an isolated animation preview:

Run `npm run preview:desktop` to show the 45 px orb in a transparent, frameless, always-on-top window, 20 px from the bottom-right corner of the primary display's work area (above the taskbar). Its position updates when monitor/work-area settings change. The window does not take keyboard focus or appear in the taskbar.

Right-click the orb or its system-tray icon to choose a test state, pause animation, or select **Zakończ** to exit. This remains a separate visual prototype; it is not connected to the Copilot recording/TTS loop. It loads local files and shares the same `voice-orb` component with the browser preview. The renderer is sandboxed with Node integration disabled and a narrow IPC bridge for visual settings.

The desktop orb fades/slides in over 380 ms. Its scale follows measured microphone levels while listening and measured synthesized audio levels during playback. Color mixing remains a visual animation; the browser preview uses simulated breathing pulses. **Zakończ** fades/slides the orb out over 240 ms before quitting; a timeout still allows quitting if the renderer stops responding. Reduced-motion settings disable these animations, and the pause control freezes the color animation. Restart the desktop app or preview after changing the desktop files.

`npm run test:desktop` checks positioning, transparency, WebGL, state/pause IPC, audio-reactive scale, conversation snapshots and restoration, safe text rendering, code copying, pinning, error recovery labels, reset, keyboard focus, narrow layout, and orb visibility through a simulated voice cycle. It runs without microphone or Codex calls. It opens native windows and tests clipboard IPC with a mocked write sink; it does not change the system clipboard. Run it explicitly when the desktop is available.

The desktop orb has its own profile and Chromium cache in `%LOCALAPPDATA%\ChatGPTButton\electron\desktop` (cache under `session/`). The desktop preview uses the ignored project-local `.chatgpt-button/electron/preview` directory. Desktop tests use temporary app data and a separate Chromium profile, so they can run while the desktop orb is open. Paths are configured before Electron starts Chromium. Test captures are retained under `.chatgpt-button/test-results/desktop-<id>/`; temporary profiles and data are removed after the run.

## Image generation

Type `/image kot w kosmosie` or say **„Wygeneruj obraz kota w kosmosie”**.
In LOCAL mode, Codex can choose its built-in ImageGen from a natural-language
request, such as "Chciałbym ilustrację kota w kosmosie. Stwórz ją dla mnie."
This works for typed messages and Whisper transcripts, with both app-server and
CLI backends. `/image` remains an explicit command. Automatic selection uses
`CODEX_MODEL` or the Codex configuration, so that model must support ImageGen;
`CODEX_IMAGE_MODEL` selects the model only for explicit generation commands.
In API mode, explicit generation phrases still route requests using the existing
text rule. Questions about images remain text/audio requests. Each request generates one PNG and shows
it in the conversation with a **Zapisz obraz** button and a native save dialog.

Generation uses Codex's built-in ImageGen. Explicit generation uses
`CODEX_IMAGE_MODEL=gpt-6.1-sol` by default; automatic LOCAL generation uses the
normal conversation model. It uses the existing Codex ChatGPT login.
In the tested Codex 0.161.0, API-key sessions do not expose the built-in tool
even though provider capabilities advertise image generation. API mode therefore
keeps API audio and generates images in a separate ChatGPT-authenticated Codex
task. No separate Images API fallback is used. Account limits still apply.

On a final voice transcription requesting an image, realtime audio stops and the
image task starts. API mode shows the resulting confirmation as text; it does
not synthesize another audio response for this task. Image generation is not
streamed as voice. Editing existing images is not implemented.

PNGs are kept in the app data root's `images/` directory. App-owned JSON retains
ImageGen questions and answers; API conversations retain task IDs and positions in `image-links/`,
so images can be restored with their conversation. The ImageGen worker has its
own storage directory and `session.json`, with ephemeral Codex threads. New conversation clears the displayed images;
the 24-hour retention policy cleans up old threads and unused artifacts. Follow-up
voice/text requests receive image tasks' textual context without image pixels.
Restart the app after updating the desktop files.

`npm test -- test-images.ts` checks routing, wire results, artifact validation,
metadata-only links, history restoration and voice cancellation.
`npm run test:desktop` exercises actual previews, unavailable images and native saving.

## Tests and type checking

Run the default development check after installing dependencies:

```powershell
npm.cmd run check
```

`check` runs strict TypeScript checking followed by `npm test`. `npm test`
runs 12 unit test files, including tooling checks, without starting voice services,
native UI, keyboard hooks or inference. Each test run gets temporary
`CHATGPT_BUTTON_DATA_DIR`, `CODEX_HOME` and `CODEX_SQLITE_HOME` directories.
The runner does not load `.env`, removes inherited API credentials and cleans up
its temporary data. Tests needing simulated authentication create their own dummy key.

| Command | Scope and requirements |
| --- | --- |
| `check` | Typecheck plus unit tests; the default development and CI check. |
| `test` | Twelve unit test files using mocks and temporary fixtures; no external executables or inference. |
| `test:integration` | Mock PowerShell speaker worker, installed Codex storage protocol, and simulated realtime provider with FFplay. Requires Windows PowerShell, Codex and FFplay; no paid inference. |
| `test:desktop` | Real Electron windows, rendering and IPC with mocked clipboard writes and save dialogs; requires an interactive desktop. |
| `test:keyboard` | Real Windows keyboard hooks and injected F24/F22 events; run explicitly on an interactive desktop. |
| `typecheck` | Strict checking of TypeScript in `src/`, `scripts/` and `tests/`; emits no JavaScript. |

Unit and integration files live in `tests/unit/` and `tests/integration/`;
the keyboard test is in `tests/native/`, with support code in `tests/helpers/`.
The Electron smoke remains in `electron/orb-main.cjs`, which the runner starts
with `--smoke-test`. `scripts/` contains launchers, the test runner,
diagnostics, benchmarks and explicit probes. Select a file within its group for
focused work:

```powershell
npm.cmd test -- test-app-storage.ts
npm.cmd test -- test-overlay.cjs --test-name-pattern "departure"
npm.cmd run test:integration -- test-storage-wire.ts
```

`test-app-storage.ts` verifies private paths, untouched shared login, durable undo,
24-hour deletion, retry, image references, CLI busy protection and portable exports.
`test-storage-wire.ts` exercises the installed Codex against a local simulated
Responses backend and confirms ephemeral app-server/CLI history, context replay
after restart and app-file deletion, using a simulated global home.
It uses a dummy key and does not make paid inference requests. `test:desktop` also checks
the export menu, native save cancellation, successful save and failure recovery.

`test-conversation-session.ts` verifies session expiry, metadata persistence, history
loading and previous-conversation restoration. `test-codex-errors.ts` checks
user-facing Codex error messages. `test-audio-levels.ts` checks PCM levels
and playback tracking; `test-clipboard.cjs` checks the clipboard IPC handler
with a mocked clipboard, including failure handling. It does not change the system clipboard.

`test-overlay.cjs` exercises the overlay controller and native cursor tracker
with deterministic timers: next-question cycles, stale hide cancellation, surface
crossing and rapid reopening. `npm run test:desktop` also sends mouse down/up through
Chromium and checks the normal visibility path and input-only popup.
`test-copilot.ts` verifies taps, holds, repeats, cancellation and delayed timers
without microphone or Codex calls. `test-speaker.ts` launches a mock PowerShell
worker to verify process reuse, interruption and audio markers; it does not synthesize
speech or test physical playback. `test-realtime-wire.ts` uses the installed
Codex and FFplay with a local simulated provider and dummy credentials. FFplay
opens its audio output, but the test sends silent PCM rather than a real API response.
On Windows, `npm run test:keyboard` uses native
hooks and synthetic F24/F22 events to verify selective suppression, event delivery,
restoration after stop, and cleanup after the owning Node process dies.
It does not press the physical Copilot key or start voice services.
`npm run start:debug` prints `[overlay]`
mode/visibility changes and open requests without logging input text in those entries.

Run only the TypeScript check when needed:

```powershell
npm.cmd run typecheck
```

Node's type stripping only removes types when running the app; it does not check
them. Electron and preview JavaScript are not yet included in TypeScript checking.

### Application and development commands

| Command | Purpose |
| --- | --- |
| `start` | Desktop voice application. |
| `start:cli` | Terminal voice application. |
| `start:debug` | Desktop application with service and overlay diagnostics. |
| `preview:desktop` | Electron visual preview with sample conversation; no voice services. |
| `preview:web` | Browser visual preview at localhost:4173. |
| `diagnose:keys` | Passive keyboard-only observer; no microphone, STT or Codex startup. |
| `diagnose:devices` | List DirectShow devices using configured FFmpeg. |
| `bench:stt` | Compare local Whisper timings for a supplied WAV. |

`npm run probe:imagegen` and `npm run probe:image-history` are explicit experiments,
excluded from `check`, unit and integration groups. They use real Codex connections
and keep artifacts under `.chatgpt-button/`. The ImageGen probe inspects account and
provider capabilities by default; `--generate`, `--integrated` and `--automatic`
request real image generation and may consume account/API quota. The history probe
requires an existing generated-image source and realtime API credentials; it creates
test history and session metadata without inference. Neither probe is a default test.

## Components

- `src/keyboard/bridge.ps1`: a small Win32 low-level keyboard hook bridge. It emits physical DOWN and UP events as JSON lines. `src/keyboard/copilot-key.ts` reads them in Node.
- `src/audio/recorder.ts`: FFmpeg opens the microphone at startup and streams 16 kHz mono PCM. Samples are kept only while Copilot is held; release writes a WAV immediately. This keeps the microphone in use while the app runs, even between utterances. Set `FFMPEG_BIN` to the real executable if your `ffmpeg.exe` on `PATH` is a launcher such as Chocolatey's shim.
- `src/stt/transcriber.ts`: local whisper.cpp server loaded once at startup. The model stays in memory between utterances; `STT_MODE=cli` in `.env` restores the old per-utterance CLI mode for troubleshooting.
- `src/codex-app-server.ts`: keeps [Codex app-server](https://learn.chatgpt.com/docs/app-server) running, reads saved history, resumes conversations, and sends each question as a structured-output turn. See the backend settings above for model and reasoning configuration.
- `src/codex.ts`: shared Polish assistant instructions and the optional `CODEX_MODE=cli` answer backend, using `codex exec` / `codex exec resume` and an app-server connection for history.
- `src/conversation-session.ts` and `src/conversation-history.ts`: session metadata, two-minute expiry, previous-conversation restoration, and paginated Codex history loading.
- `src/speaker.ts`: prewarms a Windows SAPI voice when the app starts and keeps the PowerShell worker between answers. A new key press interrupts speech and starts a fresh worker while recording. Speaking rate defaults to `2` on SAPI's `-10` to `10` scale; set `CHATGPT_BUTTON_TTS_RATE=0` in `.env` for the former pace.
- `src/piper-speaker.ts`: optional local Piper voice streamed to FFplay. Each utterance starts a Piper process; a new key press stops both Piper and FFplay.

The answer layer currently waits for the full structured Codex reply before TTS;
answers are not displayed or spoken token by token. SAPI synthesizes the full
utterance to PCM before playback; Piper streams synthesized PCM to FFplay.
To inspect a bad transcription, add `SAVE_AUDIO=1` to `.env`; the terminal prints
the saved WAV path. Recordings are created in the system temporary directory and
normally deleted after processing. Remove the option afterward to avoid
accumulating recordings.

Debug mode also prints captured WAV duration and sound levels (RMS and peak in dBFS). Compare WAV duration with the key-hold time to spot missing audio. Codex timing is split into request acceptance and turn completion. The Whisper server is bound to `127.0.0.1` and loads the model once.

## Known limitations

- The keyboard hook suppresses only the configured `COPILOT_VK` while the voice application runs. Some keyboards may emit a different shortcut or may not expose a held F23 event; check `npm.cmd run diagnose:keys` first and configure the virtual key your keyboard reports.
- Windows SAPI voice quality depends on installed voices. Piper requires a separate executable and voice download; neither is bundled in Git.
- Microphone, local model, and signed-in Codex CLI are required for the full voice loop. This repository does not bundle an STT model or download one automatically.
