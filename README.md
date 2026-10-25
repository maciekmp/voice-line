# Voice Line (Windows prototype)

Voice Line is the application's product name; its npm package is `voice-line`.

Configuration uses `VOICE`, `TTS_RATE` and `APP_DATA_DIR`. The default data root
is `%LOCALAPPDATA%\VoiceLine`; project previews and diagnostics use `.app-data/`.
Previous prototype settings and data paths are not read or migrated.

Hold the Copilot key to record. Release it to transcribe locally with whisper.cpp, then send the transcript to Codex app-server. A single Codex turn cleans the question and generates an answer in a persistent conversation. Hear the reply through Windows SAPI or local Piper TTS. Press the key again while the reply is playing to interrupt it. `npm start` runs the voice loop together with an Electron conversation panel, using the signed-in Codex account without an `OPENAI_API_KEY`. `npm run start:cli` runs the terminal-only voice loop with the same default app-server backend. The assistant is currently instructed to clean questions and answer in Polish.

## Requirements

The default `VOICE_MODE=local` uses the ChatGPT subscription. An optional experimental `VOICE_MODE=realtime` sends microphone audio directly to Codex app-server and plays its streamed audio reply. See **Codex realtime audio** below for its separate API-key requirements.

The panel header displays **LOCAL** for local Whisper/TTS or **API** for Codex realtime. The engine is selected once at startup from `.env`; restart the application after changing `VOICE_MODE`. LOCAL refers to speech processing, while Codex still generates the answer. Each mode retains its own conversation history and authentication configuration.

Voice orchestration lives in `src/voice/local-engine.ts` and `src/voice/realtime-engine.ts`, behind the contract in `src/voice-engine.ts`. `src/application-runtime.ts` constructs the shared services, controller and input adapter. Electron uses `src/worker-main.ts`; the terminal uses `src/cli-main.ts`. Both use the same conversation and Copilot flow. `src/main.ts` is a compatibility launcher. `npm test -- test-voice-engine.ts` checks stage ordering, cancellation, partial transcripts, lifecycle and startup selection without inference requests.

- Windows 11, Node.js 22.18+, PowerShell 5.1, FFmpeg with DirectShow input.
- A working microphone visible to FFmpeg.
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) `whisper-server.exe` for the default mode, plus a multilingual GGML model such as `ggml-small.bin`. Keep `whisper-server.exe` beside the executable specified by `WHISPER_BIN`, put it on `PATH` when using the default binary name, or set `WHISPER_SERVER_BIN` explicitly. `whisper-cli.exe` is needed for `STT_MODE=cli` and the STT benchmark. English-only `.en` models cannot transcribe Polish.
- [Codex CLI](https://learn.chatgpt.com/docs/app-server), available as `codex.cmd` on `PATH`, with your existing ChatGPT login (`codex login` if needed). The default backend uses ephemeral app-server threads. `CODEX_MODE=cli` uses `codex exec --ephemeral`; the application supplies prior messages as context.
- A Polish Windows SAPI voice for the default TTS mode, or Piper and FFplay for local neural speech. The app selects an installed Polish SAPI voice automatically. To choose a specific installed voice, set `VOICE` in `.env` to part of its name, for example `VOICE=Paulina`. List SAPI voices with `powershell -NoProfile -Command "$v=New-Object -ComObject SAPI.SpVoice; $v.GetVoices() | ForEach-Object { $_.GetDescription() }"`.

## Configure and run

Run commands from the repository root. Install dependencies first:

```powershell
npm.cmd install
```

The first Electron launch may download its official runtime binary.

### Osobna historia aplikacji

Conversation data lives under `%LOCALAPPDATA%\VoiceLine`, independent of the
project directory. `APP_DATA_DIR` in `.env` can override that root.
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

Each home's versioned `session.json` stores current/previous application conversation
IDs, timestamps, revision, commit receipts and the mapping to retained Codex thread IDs.
New retained conversations have an application UUID independent of the Codex UUID.
The compatibility API name `currentThreadId` refers to the application conversation;
RPC adapters resolve the Codex ID separately. Old records retain their original IDs.
The popup's **Wróć do poprzedniej rozmowy** control works after reset, expiry and
restart. Completed messages in every mode are stored in application-owned `<id>.json`
files. LOCAL and ImageGen supply them as context to fresh ephemeral turns. Realtime
uses the same committed history after restart, preserving exchange IDs and excluding
requests cancelled before commit. Older private realtime conversations without a
local file import available Codex history once; later timeline entries cannot overwrite
committed application history.
Empty conversations do not enable undo; failed reads preserve the selected
conversation. Context still expires two minutes after the last successful answer.

At startup, malformed LOCAL/ImageGen conversation files are moved to
`<id>.json.corrupt-<uuid>` in the same storage directory, preserving their original
bytes for manual recovery. Only that conversation's session reference is cleared;
healthy current/previous history remains available. Missing files clear their
references too. Recovery files survive automatic history cleanup; referenced PNGs
remain subject to the normal retention policy. Filesystem access or write errors
are still reported as storage failures.

Registered application history files (and realtime threads via `thread/delete`) are deleted
after **24 hours without activity**. Cleanup runs at startup, before requests and
once a minute while the app is idle. It does not interrupt active requests; failed
deletions are retried. When the app is closed, cleanup runs at its next start.
Linked image tasks remain available while a retained conversation references them.
Expired image links and PNGs without another retained reference are also removed.
Deletion is limited to IDs in the private home's `history-index.json`; it never
lists or deletes standard Codex/VS Code history.

Use **Zapisz rozmowę…** in the tray menu to keep the selected conversation
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

To inspect service diagnostics, run `npm.cmd run start:debug` instead of `npm.cmd start` (in Git Bash, `npm run start:debug`). Questions and answers appear in the panel; debug mode prints audio levels and timing measurements. Use `npm.cmd run start:cli -- --debug` for the interactive terminal with those diagnostics. TTS skips fenced code blocks. `Ctrl+Shift+N` starts a new conversation. Context expires 2 minutes after the last successful answer; the next voice or text question starts a new conversation. Restart resumes within that window; after expiry, use the previous-conversation control while its history is still retained.

Debug mode also prints incoming Codex stdout lines before parsing, prefixed with `[codex:app-server:raw]` or `[codex:exec:raw]`. This includes RPC replies, notifications, streamed text and any inline image/audio data returned by the protocol, for local, realtime and image generation sessions. Raw messages appear only in the terminal; this logging does not write a separate file.

Only debug mode prints `[time]` measurements. Its main total is `Recording end to playback start`, measured from Copilot key release until the selected player reports active playback. The contiguous components are recording finalization, STT, Codex, and TTS startup to playback; they add up to that total apart from display rounding. Codex request acceptance and turn generation are nested details within the Codex component. Debug also reports playback duration and the full cycle. SAPI's audio queue status and FFplay's audio clock are approximate playback markers, not speaker-loopback measurements of the first audible sample. User-facing terminal status and conversation labels are in Polish; debug measurements retain their technical English names.

### Interactive terminal

Run `npm.cmd run start:cli`. Type a message at `Ty>` and press Enter; typed
messages receive text replies without speech playback. Copilot uses the same
250 ms threshold as Electron: key-down interrupts the current operation,
a short tap returns to typing, and a hold records from key-down until release.
Before playback, interruption removes the unfinished turn from context. After
playback starts, LOCAL retains the committed answer and realtime preserves the
received fragment. A correction/continuation tap clears the draft; a voice hold
preserves it. Service updates and answers preserve the text currently being edited.
The terminal stays available for drafting and commands while services are starting.

| Command | Action |
| --- | --- |
| `/new` | Start a new conversation; `Ctrl+Shift+N` does the same. |
| `/previous` | Restore the previous retained conversation. |
| `/cancel` | Interrupt current work and return to typing. |
| `/history` | Print the current conversation, including image file paths. |
| `/status` | Show separate text, recording and playback availability. |
| `/retry` | Stop and recreate services and the keyboard hook; retain the draft. |
| `/paste` | Enter multiline input; `/send` submits it and `/abort` discards it. |
| `/image <description>` | Request an image through the selected backend. |
| `/save "C:\path with spaces\conversation.md"` | Export completed conversation and embedded images. |
| `/help`, `/quit` | Show help or shut down services and exit. |

In multiline mode every line except `/send`, `/abort` and `/quit` is literal text.
A rejected text submission keeps its draft. Ctrl+C interrupts an active operation;
when idle it exits. Generated images are listed with their PNG paths; Markdown
exports embed them using the same exporter as Electron. Exports survive automatic
history cleanup, while the temporary artifact paths remain subject to retention.

Piped input runs successive turns in order and waits for each to finish before
processing the next line. EOF drains that work and shuts down cleanly. This mode
does not open audio devices or install a keyboard hook. Failed startup, rejected
submissions, operation errors or failed exports produce a nonzero exit status.
For example:

```powershell
@('Pierwsze pytanie', 'Pytanie uzupełniające', '/save rozmowa.md') | npm.cmd run start:cli
```

Text startup is independent of microphone, STT and TTS in both interfaces.
Missing microphone configuration or failed recognition startup disables recording
without disabling text. Failed TTS startup allows LOCAL voice questions with
text-only replies. Invalid audio or shortcut settings are reported for that
service; invalid conversation-backend settings still prevent conversation startup.
Use the panel's retry action or terminal `/retry` to recreate services. Restart the
application after changing `.env`, since each process reads one configuration snapshot.

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

Hold Copilot to record and release it to upload the utterance. The app converts the recording to mono PCM16 at 24 kHz, adds a short silence tail for voice activity detection, and uses the **v2** realtime protocol over the existing stdio app-server connection. Audio starts playing as chunks arrive through FFplay. A final transcript followed by a 250 ms quiet window ends the output stream; the player drains queued audio before returning to idle. Pressing Copilot again, cancelling or resetting stops playback and closes the current realtime session. Recordings are limited to 60 seconds. The conversation panel displays question and answer transcripts as soon as Codex sends them, updating partial text during audio playback. Completed transcript segments are also displayed immediately; the full answer need not wait for playback to finish. The exchange is saved on completion; interrupted playback retains the received text, marked as interrupted. Typed questions continue to use normal text turns without spoken playback.

Each voice request creates a new realtime session and supplies recent committed exchanges from the selected conversation, including voice transcripts and typed replies. Committed application history supplies restart and previous-conversation context; old private conversations without that history import Codex data once. Resetting the conversation or the existing two-minute inactivity expiry starts an empty context; restoring the previous conversation brings its context back. Generic realtime startup context forwarding is disabled. Typed questions retain the normal Codex thread behavior.

LOCAL ephemeral prompts and realtime audio prompts share a history policy: at most
32 newest exchanges and 32 KiB of UTF-8 JSON, including escaping and role overhead.
The builder keeps complete pairs in chronological order. If the newest pair alone
exceeds the budget, it keeps the beginning and end of its question/answer with an
explicit truncation marker. The current question and base instructions are outside
this history budget and remain intact. This is a byte limit, not an estimate of
model tokens. The stored history, export and undo retain all committed exchanges;
only the context sent with a new request is shortened.

Realtime uses `%LOCALAPPDATA%\VoiceLine\realtime-codex` as its dedicated Codex home, including API credentials, history, retention index and `session.json` metadata. The account login RPC stores the API key in that dedicated home's credential store. History is restored from Codex's paginated timeline, including voice transcripts and typed answers. The two-minute expiry, durable previous-conversation control and 24-hour retention also apply to this separate session.

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

FFplay must be available beside the configured absolute `FFMPEG_BIN` or on `PATH`, or set `FFPLAY_BIN` to its actual executable (not a Chocolatey launcher). The app pipes Piper's 16-bit mono PCM into FFplay as it is synthesized and reads the sample rate from the voice JSON. Piper runs locally without an API key. Switch back with `TTS_MODE=sapi`. On this machine, the trial files are under `.app-data/piper/` and are ignored by Git.

To verify native playback interruption with the configured Piper model, run
`node --env-file-if-exists=.env --experimental-strip-types tests/native/test-piper-interruption.ts`.
It exercises Copilot tap and hold through the controller, checks that the actual
FFplay process exits, and uses a dummy audio device without microphone or Codex calls.

To compare Whisper CPU thread counts on exactly the same speech, add `SAVE_AUDIO=1` to `.env`, record one question, and use the printed WAV path with `npm run bench:stt -- "C:\path\to\recording.wav"`. The script loads the configured model with 4 and 8 threads and transcribes the WAV twice per setting. Compare the second run and its text; model loading is shown separately. Set `WHISPER_THREADS` in `.env` to the faster value, then remove `SAVE_AUDIO=1` when finished. Results vary with the machine, audio length, and system load; `.env.example` leaves the thread count unset.

## Desktop panel (Electron)



`npm start` starts the real voice services with the panel hidden.

The popup is the only desktop window. A short Copilot
press from hidden opens only the focused text input. A second tap opens history;
subsequent taps alternate history with the latest exchange and input. A voice
view shows the latest exchange without input; tapping adds input, and another
tap opens history. Sending text always selects the latest-exchange input view.

Generated images appear as soon as each completed result has been validated and
saved, while the remaining variants are still being generated. Multiple variants
share one large preview with thumbnails above it. Click a thumbnail or use the
arrow keys, Home and End to switch variants; incoming results preserve your choice.
The same gallery is available in conversation history. Preview results remain
pending until the complete response is committed.

Click the pencil button next to the displayed image's save button to attach that
variant to a question or edit request. The selected image appears above the input;
use **Usuń** to clear it. Selection applies to the next text or voice message and
clears when the command is submitted or the conversation changes. Questions about
an attached image can return text without generating a replacement.

Copilot interrupts immediately on key-down. Before actual playback starts it
removes the current exchange from history and context; a tap clears the draft
and opens correction without also toggling views. Once playback has started,
LOCAL keeps its full answer and API saves the received fragment marked interrupted.
A tap then clears the draft and allows continuing by text. Holding at least 250 ms
selects voice recording while preserving an unsent draft; release submits it.
Audio is captured from key-down and discarded for taps. CLI shares this tap/hold flow.

Escape hides the panel without stopping work and preserves the draft; updates
from the same operation do not reopen it. Hover cannot open the hidden panel.
After completion/interruption, a five-second timer hides the panel unless hover, input
focus or pin protects it at expiry. If protected then, it remains until explicit
dismissal or another operation. Departure, blur and unpin never start another timer.
Errors stay visible until dismissal or another action. During startup/service failure,
Copilot displays status and allows drafting, but recording and sending are unavailable.
A press begun while unavailable needs to be repeated after readiness.

Normal Codex text turns enable built-in live web search (`web_search="live"`),
including LOCAL voice questions and typed questions in either voice mode. The
assistant checks current information and includes source links in its answer.
This does not require a separate search API key. Native realtime audio sessions
retain their existing tool-free prompt; use LOCAL or a typed question for web research.
The tray opens history with a text composer. Enter sends,
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
the isolated desktop preview does not install a keyboard hook.
Closing the panel hides the panel without stopping services; **Zakończ** in the tray
menu quits and shuts down the microphone, keyboard hook and voice workers.
The microphone remains active between questions in interactive mode; only
question recording retains samples. The worker owns conversation history and
publishes snapshots for display. Completed messages and image references are
persisted in application-owned history files; the session file stores metadata.

### Audio feedback and preview

The popup is anchored 20 px from the right and bottom edges of the primary display's work area. It grows upward, with a width of 380 px and maximum height of 500 px, constrained to the available work area. Monitor changes reposition the panel. Automatic voice activity shows it without taking keyboard focus.

The fixed header contains LOCAL/API and the existing pin/previous-conversation controls. The tray's **Efekty wizualne** submenu lists **Słupki**, **Mini orb** (24 px), **Podświetlenie** (a blue edge glow) and **Fale** (the orb's flowing clouds over the bottom of the panel). Selection takes effect immediately and is saved automatically, without changing the conversation, draft, focus or visibility. The next launch restores it; bars are the default when no valid saved choice exists.

The application saves the choice atomically in `desktop-settings.json` under its data root (normally `%LOCALAPPDATA%\VoiceLine`, or `APP_DATA_DIR`). Preview uses `.app-data/desktop-preview-settings.json` independently. A save failure leaves the effect active for the current session and displays an error; the previously saved choice remains intact. Pausing animation remains a session-only option.

Indicators react to measured microphone or playback levels only during listening and speaking. State transitions and hiding reset the level. **Wstrzymaj animację** and reduced-motion preferences make feedback static. Hidden panels stop animation; changing away from the mini orb releases its GPU resources. Unsupported WebGL or context loss uses a static CSS fallback. The LOCAL/API label is hidden until the engine reports its mode.

Microphone capture requests a 40 ms DirectShow buffer and flushes PCM packets immediately. Recording uses 20 ms RMS windows and preserves syllable peaks within incoming pipe chunks. Quiet microphone levels receive visual gain, with an immediate attack and a 50 ms release time constant shared by all indicators; the orb and waves do not smooth the envelope a second time. Recorded PCM is unchanged. Playback metering retains its 40 ms windows. Restart the application after changing capture settings.

Run `npm run preview:desktop` to open the panel without voice services or a keyboard hook. The tray provides **Stan podglądu** and **Poziom audio (podgląd)** controls for comparing all four variants. Audio levels are simulated only in preview. Use **Zakończ** to quit; shutdown does not wait for a renderer animation. The standalone web preview has been removed.

`npm run test:desktop` checks the single window, positioning, all audio variants, reduced motion, pause, visibility, snapshots, restoration, safe text rendering, copying, images, export, pinning, errors, drafting and native close. It runs without microphone or Codex calls and mocks clipboard writes. Captures are retained under `.app-data/test-results/desktop-<id>/`.

The desktop profile and Chromium cache live under `%LOCALAPPDATA%\VoiceLine\electron\desktop` (cache under `session/`). Preview uses `.app-data/electron/preview`. Tests use disposable isolated profiles, so they can run alongside a production instance.

The installation and check sequence has also passed in a fresh local Windows copy.

Unit and integration files live in `tests/unit/` and `tests/integration/`;
the keyboard test is in `tests/native/`, with support code in `tests/helpers/`.
The Electron smoke lives in `tests/native/desktop-smoke.cjs`. The runner starts
the production host `electron/desktop-main.cjs` with `--smoke-test`, which passes its
windows and native adapters to the harness. The smoke also measures the production
history renderer against the captured earlier algorithm at 100, 1000 and 3000
exchanges, and saves `history-scale.json` beside the screenshots. Timing values
are observations; identity preservation, incremental creation and lazy previews
are asserted. `scripts/` contains launchers, the test runner,
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
them. Selected Electron modules and the preload are checked through
`tsconfig.desktop.json`, including the conversation, history, answer and image
renderers. Orb component and preview JavaScript remain outside that gradual migration.

### Application and development commands

| Command | Purpose |
| --- | --- |
| `start` | Desktop voice application. |
| `start:cli` | Terminal voice application. |
| `start:debug` | Desktop application with service and overlay diagnostics. |
| `preview:desktop` | Electron visual preview with sample conversation; no voice services. |
| `diagnose:keys` | Passive keyboard-only observer; no microphone, STT or Codex startup. |
| `diagnose:devices` | List DirectShow devices using configured FFmpeg. |
| `bench:stt` | Compare local Whisper timings for a supplied WAV. |

`npm run probe:imagegen` and `npm run probe:image-history` are explicit experiments,
excluded from `check`, unit and integration groups. They use real Codex connections
and keep artifacts under `.app-data/`. The ImageGen probe inspects account and
provider capabilities by default; `--generate`, `--integrated` and `--automatic`
request real image generation and may consume account/API quota. The history probe
requires an existing generated-image source and realtime API credentials; it creates
test history and session metadata without inference. Neither probe is a default test.

## Components

- `src/application-runtime.ts`: shared composition root for configuration, services, optional microphone and keyboard hook. `src/worker-main.ts` hosts it over Node IPC; `src/cli-main.ts` hosts it in the terminal. `src/main.ts` preserves older launch commands and `--debug-keys`.
- `src/application-controller.ts`: injected voice engine, optional recorder, clock and event sink; owns conversation operations, cancellation, reset, previous, history maintenance and shutdown. Text, recognition and playback initialize independently. Synchronous command admission returns an operation ID or rejection reason separately from asynchronous completion. Responses wait for the previous provider call and audio cleanup; stale callbacks cannot publish after reset or cancel.
- `src/application-input.ts`: shared Copilot tap/hold and keyboard-shortcut adapter. It translates physical input to controller operations and presentation intents; the controller knows neither physical keys nor desktop/CLI modes.
- `src/cli.ts`: terminal presentation, editable prompt, multiline input, history, export and service restart. It consumes the same authoritative events as the desktop and preserves draft text during asynchronous updates.
- `src/worker-host.ts`, `src/worker-validation.cjs` and `electron/engine-supervisor.cjs`: correlated IPC requests and admission acknowledgements, with bounded waits and rejection of pending requests on disconnect or restart. Electron clears a submitted draft only after worker acceptance; it does not synthesize operation states locally.
- `src/app-config.ts`: one immutable configuration snapshot for the selected services, passed by the factory to Codex, Whisper, recording and playback. Application hosts isolate audio-setting errors to their affected capabilities; strict diagnostic/factory loading still rejects invalid settings. LOCAL-only settings are not validated in realtime mode.
- `src/conversation-contract.ts` and `src/application-contract.ts`: neutral service interfaces, reply/history types, application command validation, service health and operation snapshot fields. Backend exports remain compatible adapters.
- `src/desktop-contract.ts` and `src/desktop-validation.cjs`: preload API, requests/events and runtime validation of renderer requests and worker snapshots. `electron/desktop-worker.cjs` dispatches validated events; `desktop-conversation.cjs` presents authoritative completed/pending exchanges; `desktop-windows.cjs` applies native geometry and window lifecycle.
- `src/answer-format.js`, `src/app-data.cjs`, `src/image-files.cjs` and `src/conversation-export.cjs`: shared formatting, data-root resolution, validated image access and portable conversation export, independent of Electron. Renderer/host imports retain thin compatibility adapters.
- `src/keyboard/bridge.ps1`: a small Win32 low-level keyboard hook bridge. It emits physical DOWN and UP events as JSON lines. `src/keyboard/copilot-key.ts` reads them in Node.
- `src/audio/recorder.ts`: FFmpeg opens the microphone at startup and streams 16 kHz mono PCM. Samples are kept only while Copilot is held; release writes a WAV immediately. This keeps the microphone in use while the app runs, even between utterances. Set `FFMPEG_BIN` to the real executable if your `ffmpeg.exe` on `PATH` is a launcher such as Chocolatey's shim. When `FFPLAY_BIN` is unset, playback prefers the real `ffplay.exe` beside that configured FFmpeg. This allows Copilot interruption to terminate the actual player instead of leaving it running behind a launcher. An explicit `FFPLAY_BIN` must also point to the actual executable.
- `src/stt/transcriber.ts`: local whisper.cpp server loaded once at startup. The model stays in memory between utterances; `STT_MODE=cli` in `.env` restores the old per-utterance CLI mode for troubleshooting.
- `src/codex-app-server.ts`: keeps [Codex app-server](https://learn.chatgpt.com/docs/app-server) running, reads saved history, resumes conversations, and sends each question as a structured-output turn. See the backend settings above for model and reasoning configuration.
- `src/codex.ts`: shared Polish assistant instructions and the optional `CODEX_MODE=cli` answer backend, using `codex exec` / `codex exec resume` and an app-server connection for history.
- `src/conversation-session.ts` and `src/conversation-history.ts`: session metadata, two-minute expiry, previous-conversation restoration, and paginated Codex history loading.
- `src/speaker.ts`: prewarms a Windows SAPI voice when the app starts and keeps the PowerShell worker between answers. A new key press interrupts speech and starts a fresh worker while recording. Speaking rate defaults to `2` on SAPI's `-10` to `10` scale; set `TTS_RATE=0` in `.env` for the former pace.
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

### Intermittent image-generation failures

Direct requests such as `Wygeneruj obraz pingwina w 4 wariantach` now select
the image-generation path and `CODEX_IMAGE_MODEL` in LOCAL, for both typed
messages and recognized speech. The requested number of variants is preserved.

Requests such as `Możesz wygenerować obraz z kamieniami?` may return an empty
answer (`Codex returned an incomplete voice reply`) or claim success without
generating an image. This remains unresolved. Use `/image <description>` as a
workaround to select the explicit image-generation path.

### Other limitations

- The keyboard hook suppresses only the configured `COPILOT_VK` while the voice application runs. Some keyboards may emit a different shortcut or may not expose a held F23 event; check `npm.cmd run diagnose:keys` first and configure the virtual key your keyboard reports.
- Windows SAPI voice quality depends on installed voices. Piper requires a separate executable and voice download; neither is bundled in Git.
- Microphone, local model, and signed-in Codex CLI are required for the full LOCAL voice loop. Text input works without the microphone and speech services. This repository does not bundle an STT model or download one automatically.
