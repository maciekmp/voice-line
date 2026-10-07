# ChatGPT Button (Windows prototype)

Hold the Copilot key to record. Release it to transcribe locally, clean the transcript with Codex CLI, ask Codex in a persistent conversation, and hear the reply through Windows SAPI or local Piper TTS. Press the key again while the reply is playing to interrupt it. `npm start` runs the voice loop together with an Electron conversation panel and desktop orb, without an `OPENAI_API_KEY` or paid API integration. `npm run start:cli` runs the terminal-only loop.

## Requirements

- Windows 11, Node.js 22.18+, PowerShell 5.1, FFmpeg with DirectShow input.
- A working microphone visible to FFmpeg.
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) `whisper-cli.exe` and a multilingual GGML model such as `ggml-small.bin`. The English-only `.en` models cannot transcribe Polish. `WHISPER_BIN` can point to the executable if it is not on `PATH`.
- [Codex CLI](https://learn.chatgpt.com/docs/non-interactive-mode), signed in with `codex.cmd login`. The prototype uses `codex exec` and `codex exec resume` with the signed-in account. It does not use an API key.
- A Polish Windows SAPI voice for the default TTS mode, or Piper and FFplay for local neural speech. The app selects an installed Polish SAPI voice automatically. To choose a specific installed voice, set `CHATGPT_BUTTON_VOICE` in `.env` to part of its name, for example `CHATGPT_BUTTON_VOICE=Paulina`. List SAPI voices with `powershell -NoProfile -Command "$v=New-Object -ComObject SAPI.SpVoice; $v.GetVoices() | ForEach-Object { $_.GetDescription() }"`.

## Configure and run

```powershell
npm.cmd run keys
```

Hold and release Copilot. Read the `vk` of its DOWN and UP events. F23 is `134`, but use what your machine actually reports. If the key emits several events, choose the virtual key that stays down for the entire hold.

```powershell
npm.cmd run devices
```

Set the exact DirectShow audio device name from the output. FFmpeg returns a nonzero code after listing devices; that is normal. Copy `.env.example` to `.env` and edit the four values. Node loads `.env` automatically when you run `npm start` or `npm run debug`; no shell exports are needed. `.env` is ignored by Git. Missing or invalid setup is reported in the panel with a restart action; detailed service diagnostics remain in the terminal.

```powershell
npm.cmd start
```

In Git Bash, run `npm start` instead.

To inspect recognition and speech output, run `npm.cmd run debug` instead of `npm.cmd start` (in Git Bash, `npm run debug`). Both modes print the cleaned question and the exact AI answer sent to TTS. Debug mode additionally prints the raw transcription, audio levels, timing measurements, and Codex thread ID. `Ctrl+Shift+N` starts a new conversation; `Ctrl+C` exits. The Codex thread ID is stored in `.chatgpt-button-session.json` so a restart can resume it.

Only debug mode prints `[time]` measurements. Its main total is `Recording end to playback start`, measured from Copilot key release until the selected player reports active playback. The contiguous components are recording finalization, STT, Codex, and TTS startup to playback; they add up to that total apart from display rounding. Codex request acceptance and turn generation are nested details within the Codex component. Debug also reports playback duration and the full cycle. SAPI's audio queue status and FFplay's audio clock are approximate playback markers, not speaker-loopback measurements of the first audible sample. Console status messages and labels are in English; spoken question and answer text retains its original language.

### Try Piper TTS

Download the [Windows x64 Piper package](https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip) and a Polish voice's `.onnx` and `.onnx.json` files, for example [Gosia medium](https://huggingface.co/rhasspy/piper-voices/tree/main/pl/pl_PL/gosia/medium). Extract Piper, keep both voice files together, and set these values in `.env` (replace paths with your locations):

```dotenv
TTS_MODE=piper
PIPER_BIN=C:\path\to\piper\piper.exe
PIPER_MODEL=C:\path\to\pl_PL-gosia-medium.onnx
```

FFplay must be available on `PATH`, or set `FFPLAY_BIN` to its executable. The app pipes Piper's 16-bit mono PCM into FFplay as it is synthesized and reads the sample rate from the voice JSON. Piper runs locally without an API key. Switch back with `TTS_MODE=sapi`. On this machine, the trial files are under `.chatgpt-button/piper/` and are ignored by Git.

To compare Whisper CPU thread counts on exactly the same speech, add `SAVE_AUDIO=1` to `.env`, record one question, and use the printed WAV path with `npm run bench-stt -- "C:\path\to\recording.wav"`. The script loads the configured model with 4 and 8 threads and transcribes the WAV twice per setting. Compare the second run and its text; model loading is shown separately. Set `WHISPER_THREADS` in `.env` to the faster value, then remove `SAVE_AUDIO=1` when finished. The current setting is `WHISPER_THREADS=8`: on one recorded Polish question, 8 threads took 5.08 s and 4.99 s versus 6.14 s and 6.30 s with 4 threads, with identical transcription. Results may vary with longer audio and system load.

## Blue orb visual prototype

Run `npm run preview:orb` and open http://127.0.0.1:4173 to preview a ChatGPT-inspired blue orb. The Polish demo switches between idle, listening, and speaking animations and includes a pause control. It is a standalone visual simulation with no microphone or voice-loop connection, no new dependencies, and reduced-motion support.

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
short delay. Press the orb to open text chat; press it again to return to the
compact latest-exchange view, preserving the draft. Press Escape to dismiss it.
Window focus changes do not close the conversation.
The dark hover popup shows the latest question and answer, with no answer-generation
status text. A short Copilot press (under 250 ms) shows the orb and a focused popup
containing only the text input, hiding earlier messages until the next question.
Holding Copilot for at least 250 ms records a voice question; audio is collected
from key-down to preserve its beginning, and a short tap discards it without transcription.
Clicking the orb or tray reveals the conversation and a text composer: Enter sends,
Shift+Enter adds a newline. Typed questions continue the same Codex conversation
and receive a text reply without speech playback. The composer has no send or cancel button.
Recording uses Copilot; **Nowa rozmowa** remains in the tray menu.
While the voice application runs, its keyboard hook consumes the configured
`COPILOT_VK` press and release, preventing the corresponding Windows action.
Other keys pass through. Exiting releases the hook, including after an unexpected
Node process exit. `npm run keys` only observes keys and does not suppress them;
the isolated orb preview does not install a keyboard hook.
Closing the panel hides it without stopping services; **Zakończ** in the tray
menu quits and shuts down the microphone, keyboard hook and voice workers.
The microphone remains active between questions, as in terminal mode; only
question recording retains samples. The transcript is not stored in the renderer.

The following `npm run orb` mode remains an isolated animation preview:

Run `npm run orb` to show the 45 px orb in a transparent, frameless, always-on-top window, 20 px from the bottom-right corner of the primary display's work area (above the taskbar). Its position updates when monitor/work-area settings change. The window does not take keyboard focus or appear in the taskbar.

Right-click the orb or its system-tray icon to choose a test state, pause animation, or select **Zakończ** to exit. This remains a separate visual prototype; it is not connected to the Copilot recording/TTS loop. It loads local files and shares the same `voice-orb` component with the browser preview. The renderer is sandboxed with Node integration disabled and a narrow IPC bridge for visual settings.

The desktop orb fades/slides in over 380 ms. Listening uses a slow breathing pulse; speaking combines a quicker pulse with irregular color mixing. **Zakończ** fades/slides the orb out over 240 ms before quitting; a timeout still allows quitting if the renderer stops responding. Reduced-motion settings disable these animations, and the pause control freezes the breathing/color animation. Restart `npm run orb` after changing the desktop files.

`npm run test:orb` checks positioning, transparency, WebGL, state/pause IPC, conversation snapshots, safe text rendering, error recovery labels, reset, keyboard focus, narrow layout, and orb visibility through a simulated voice cycle. It runs without microphone or Codex calls and saves captures under the ignored `.chatgpt-button/` directory. The first Electron launch may download its official runtime binary.

The desktop orb has its own profile and Chromium cache in `.chatgpt-button/electron/desktop/` (cache under `session/`). These paths are configured before Electron starts Chromium, avoiding the shared default Electron cache. Smoke tests use a separate profile per process so they can run while the desktop orb is open. After changing profile configuration, exit the orb via **Zakończ** and run `npm run orb` again.

## Type checking

`npm run test:overlay` exercises the overlay controller and native cursor tracker
with deterministic timers: next-question cycles, stale hide cancellation, surface
crossing and rapid reopening. `npm run test:orb` also sends mouse down/up through
Chromium and checks the normal visibility path and input-only popup.
`npm run test:copilot` verifies taps, holds, repeats, cancellation and delayed timers
without microphone or Codex calls. On Windows, `npm run test:keyboard` uses native
hooks and synthetic F24/F22 events to verify selective suppression, event delivery,
restoration after stop, and cleanup after the owning Node process dies.
It does not press the physical Copilot key or start voice services.
`npm run debug` prints `[overlay]`
mode/visibility changes and open requests without logging input text in those entries.

Install development dependencies and check all TypeScript files in `src/` and `scripts/`:

```powershell
npm.cmd install
npm.cmd run typecheck
```

The check runs TypeScript in strict mode without generating JavaScript. Node's type stripping only removes types when running the app; it does not check them. Run `npm run typecheck` before committing and as a check in CI.

## Components

- `src/keyboard/bridge.ps1`: a small Win32 low-level keyboard hook bridge. It emits physical DOWN and UP events as JSON lines. `src/keyboard/copilot-key.ts` reads them in Node.
- `src/audio/recorder.ts`: FFmpeg opens the microphone at startup and streams 16 kHz mono PCM. Samples are kept only while Copilot is held; release writes a WAV immediately. This keeps the microphone in use while the app runs, even between utterances. Set `FFMPEG_BIN` to the real executable if your `ffmpeg.exe` on `PATH` is a launcher such as Chocolatey's shim.
- `src/stt/transcriber.ts`: local whisper.cpp server loaded once at startup. The model stays in memory between utterances; `STT_MODE=cli` in `.env` restores the old per-utterance CLI mode for troubleshooting.
- `src/codex-app-server.ts`: keeps [Codex app-server](https://learn.chatgpt.com/docs/app-server) running, resumes the saved conversation, and sends each question as a structured-output turn. Set `CODEX_MODEL=gpt-6-luna` in `.env` for a faster model suited to short questions; omit it to use Codex's `config.toml` model. This setting also applies to resumed conversations and the `CODEX_MODE=cli` fallback. Turns use low reasoning effort by default; set `CODEX_EFFORT=medium` for more complex answers.
- `src/speaker.ts`: prewarms a Windows SAPI voice when the app starts and keeps the PowerShell worker between answers. A new key press interrupts speech and starts a fresh worker while recording. Speaking rate defaults to `2` on SAPI's `-10` to `10` scale; set `CHATGPT_BUTTON_TTS_RATE=0` in `.env` for the former pace.
- `src/piper-speaker.ts`: optional local Piper voice streamed to FFplay. Each utterance starts a Piper process; a new key press stops both Piper and FFplay.

The answer layer currently waits for the full Codex reply before TTS. To inspect a bad transcription, add `SAVE_AUDIO=1` to `.env`; the terminal prints the saved WAV path. Remove the option afterward to avoid accumulating recordings. `codex exec --json` supplies streamed events for a later sentence-level speech pipeline.

Debug mode also prints captured WAV duration and sound levels (RMS and peak in dBFS). Compare WAV duration with the key-hold time to spot missing audio. Codex timing is split into request acceptance and turn completion. The Whisper server is bound to `127.0.0.1` and loads the model once.

## Known limitations

- The keyboard hook suppresses only the configured `COPILOT_VK` while the voice application runs. Some keyboards may emit a different shortcut or may not expose a held F23 event; check `npm.cmd run keys` first and configure the virtual key your keyboard reports.
- Windows SAPI voice quality depends on installed voices. Piper requires a separate executable and voice download; neither is bundled in Git.
- Microphone, local model, and signed-in Codex CLI are required for the full voice loop. This repository does not bundle an STT model or download one automatically.
