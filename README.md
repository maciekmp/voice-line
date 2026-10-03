# ChatGPT Button (Windows prototype)

Hold the Copilot key to record. Release it to transcribe locally, clean the transcript with Codex CLI, ask Codex in a persistent conversation, and hear the reply through Windows SAPI or local Piper TTS. Press the key again while the reply is playing to interrupt it. No GUI, Electron, `OPENAI_API_KEY`, or paid API integration is used.

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

Set the exact DirectShow audio device name from the output. FFmpeg returns a nonzero code after listing devices; that is normal. Copy `.env.example` to `.env` and edit the four values. Node loads `.env` automatically when you run `npm start` or `npm run debug`; no shell exports are needed. `.env` is ignored by Git.

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

## Type checking

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

- The keyboard hook observes global keys but does not suppress the normal Windows Copilot action. Some keyboards may emit only a synthetic shortcut or may not expose a held F23 event; check `npm.cmd run keys` first.
- Windows SAPI voice quality depends on installed voices. Piper requires a separate executable and voice download; neither is bundled in Git.
- Microphone, local model, and signed-in Codex CLI are required for the full voice loop. This repository does not bundle an STT model or download one automatically.
