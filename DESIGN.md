---
version: alpha
name: Voice Line
description: Dyskretny asystent głosowy Windows z kulką i czytelną odpowiedzią.
colors:
  primary: '#d4c6b6'
  background: '#242220'
  surface: '#302d29'
  text: '#eee9e2'
  muted: '#b8afa5'
  border: '#49433d'
  danger: '#ffaaaa'
  scrollbar: '#766b60'
typography:
  sans:
    fontFamily: "'Segoe UI', system-ui, sans-serif"
rounded:
  DEFAULT: '10px'
spacing:
  panel: '12px'
components:
  button: {}
  voice-orb: {}
  status: {}
---

# Voice Line

## Product and visual intent

A Polish-language Windows voice tool, grounded in README.md and the existing
Copilot recording loop. The blue flowing orb is the recognizable signature.
Keep everything around it quiet: warm brown-grey surfaces, left-aligned 12 px text, native
Windows typography, no decorative motion or additional icon vocabulary.
No Japan-market scope is established.

## Runtime ownership

Model B: `electron/conversation.css` owns the panel's semantic CSS variables.
Frontmatter mirrors their values: colors map to `--color-*`, `rounded.DEFAULT`
to `--radius-control`, `spacing.panel` to `--space`, and typography to
`--font-body`. Scrollbar hover uses the muted token. `preview/voice-orb.js`
and `orb-renderer.js` remain the single visual orb primitive for browser,
desktop indicator. The conversation popup does not duplicate the orb. The transparent desktop shell has
its own geometry; it does not adopt the panel background.

## Layout and states

The desktop orb shows a small LOCAL or API label below it, reflecting the engine
selected at startup. LOCAL means local speech recognition and synthesis; Codex
still generates the answer. API means Codex realtime. The label has no action,
uses the existing surface/text colors and Segoe UI, and disappears with the orb.
The native shell is 64 by 80 px; the orb keeps its original position and hit area.

380 px wide popup with height measured from its content and capped at 500 px, anchored 8 px above
the desktop orb and constrained to the display work area. Question and answer
have no visible labels; semantic accessible names remain. The document owns scrolling;
long answers and enlarged text grow naturally, with no competing inner scroller.
Hover shows only the latest question and answer; answer generation has no status text.
Tapping Copilot for less than 250 ms opens a focused input-only popup and shows
the orb, even while idle. The transcript and history stay hidden in this mode;
submitting or starting a voice question reveals chat. A hold of at least 250 ms
starts voice recording; samples are collected from key-down, then discarded on a tap.
Click smoothly grows the native window upward over 220 ms while revealing a
sticky text composer with a matching upward slide and fade. No scrollbar is
shown during expansion; short content fits without scrolling. Clicking the orb
again collapses to peek, hiding the composer and history while preserving the draft.
The native window shrinks smoothly, including during playback. Long content
scrolls only when it exceeds the display's available height. The composer is
focused on opening. Reduced motion reveals it immediately. The composer
fills the entire bottom strip between two faint dividers (#36312d), with no
input frame or send button. Enter sends; accessible input help describes the
shortcut. Keyboard focus subtly changes the input background without a frame;
forced colors use a system outline. There is no cancel button in the popup.
Dismissal waits 180 ms after hiding the native surface before resetting the renderer
to peek mode. Reopening cancels that pending reset and restores its cached
content height before the next hover, while preserving the draft. The isolated Electron
preview uses a sample question and answer instead of a preview notice. Enter submits;
Shift+Enter adds a newline, and IME confirmation never submits. Text messages use
the existing Codex thread without speech playback. Blank and duplicate submits
are blocked; failed sends preserve the draft.
Recording and reset remain available through Copilot and the tray menu.
Controls have stable height, visible focus, pointer feedback
and disabled states. Error text includes a recovery instruction. Color is never
the sole state indicator: transcript text and the tray identify the current operation.

## Behavior owners

| Capability | Canonical owner | Source | Verification |
| --- | --- | --- | --- |
| Voice lifecycle | src/application-controller.ts; src/main.ts adapters | Injected controller for Copilot/text, cancellation, reset, previous and shutdown | typecheck; controller public API tests; Electron snapshots |
| State fan-out and visibility | electron/orb-main.cjs | User request: hide until listening, hide after speech | `npm run test:desktop` |
| Overlay behavior | electron/overlay-controller.cjs | hidden/peek/chat/compose; one exit timer; new recording cancels stale hides | `npm test -- test-overlay.cjs`; `npm run test:desktop` |
| Copilot gestures | src/keyboard/copilot-gesture.ts | tap opens input; hold records; repeat and cancellation handling | `npm test -- test-copilot.ts`; typecheck |
| Keyboard delivery | src/keyboard/bridge.ps1; src/keyboard/copilot-key.ts | configured key consumed while voice app runs; other keys pass; parent-exit cleanup | `npm run test:keyboard` |
| Hover detection | electron/overlay-pointer.cjs | Native cursor and current window bounds, sampled every 50 ms | `npm test -- test-overlay.cjs`; `npm run test:desktop` |
| Feedback | electron/conversation.js | Lifecycle IPC snapshots | `npm run test:desktop` |
| Code answers | electron/answer-format.js; electron/answer-renderer.js | Shared parsing for latest reply, history and speech | `npm test -- test-answers.js`; `npm run test:desktop` |
| Scrollbar | electron/conversation.css | Global semantic tokens | static audit; runtime inspection |
| Voice visual | preview/voice-orb.js | Existing browser preview | `npm run test:desktop` |

## Motion and platform

Desktop speech uses measured 40 ms PCM RMS windows for microphone and both TTS
engines. The shared orb scales from 1 to 1.18 with a fast attack and gentle release;
silence returns it to its base size. Its 54 px hit target stays fixed. Audio-level
IPC updates only the orb, never conversation layout or visibility. Reduced motion
disables scaling and pausing freezes it. SAPI synthesizes to memory before playback
so its envelope matches the played audio; no extra audio file is retained.

The orb enters and exits gently; it is hidden during idle and startup and remains
visible through transcription, answer generation and playback. Interrupted or
failed cycles also hide it. While transcribing, thinking and preparing speech,
the desktop orb has a rotating blue ring: clockwise at one turn per second during
transcription, counterclockwise at two turns per second while preparing the answer
and speech. Speech accelerates
the shared cloud flow fourfold, with a smooth transition between speeds.
Reduced motion suppresses transitions, breathing, ring rotation and cloud motion;
the pause control freezes both the orb and its ring.
The tray and window menus are native platform surfaces. Renderer Node access is
disabled; a sandboxed preload exposes only explicit commands and state events.
The orb remains visible after playback while the pointer is over either the orb
or popup, including a one-second grace period; both hide after leaving them.
During every active voice state, leaving both surfaces may close the popup after
one second, but never hides the orb. Escape also dismisses only the popup while
work is active. If the exit timer has already expired, completion hides the orb;
otherwise the remaining grace period or hover keeps it visible. Starting voice
or text work cancels an idle exit timer. Verification flows are maintained in
`VERIFICATION-FLOWS.md`.
The desktop orb does not steal focus. Hover opens the conversation popup without
focus; a one-second exit delay allows crossing into it. Starting a new recording
keeps the visible popup's size stable. Answer text suppresses the status label.
Primary mouse press toggles chat and peek before mouse-up; keyboard activation
of the orb does the same, while tray activation always opens chat. All use the
same controller. Hover never takes focus; native activation is enabled
for mouse presses. Escape dismisses explicitly and clears pinning. The popup has
a 24 px icon-only pin button fixed 4 px from the top-right corner in every mode,
outside document flow, without adding height or changing content/composer spacing.
The Lucide pin rotates from diagonal to upright when pinned; Polish accessible
Przypnij popup/Odepnij popup names, tooltips and pressed state describe the action.
The overlay controller owns pinning: it cancels automatic departure hiding and
keeps the popup and orb visible when switching applications. Unpinning restores
the one-second departure delay. Pinning lasts until unpinned or dismissed.
The adjacent 24 px Lucide undo button restores the previous Codex conversation
after reset or context expiry, including exchanges read from Codex history.
It shares the pin control's style and fixed positioning, 32 px from the right.
Its Polish accessible name is Wróć do poprzedniej rozmowy. It is disabled while
work is active, services are unavailable, or no previous nonempty thread exists.
A thread is nonempty after at least one successful answer. Returning
renews the two-minute context window; a subsequent return can switch back to the
conversation just left. The session owns thread selection; Electron presents
the worker's authoritative completed/pending snapshot and keeps no undo archive. Each mode's
session file stores current/previous conversation IDs and timestamps. Startup and undo read
app-owned committed files, importing older realtime Codex history when needed, then publish restored context.
Paginated history loads all turn and item pages. Empty history disables undo;
failed reads or cancelled returns do not switch the selected thread.
Focus/blur does not change mode
or independently schedule hiding. One controller owns visibility and mode;
voice snapshots do not reactivate windows or replace chat with peek. Starting
a new recording cancels the previous hide timeout. Drafts survive dismissal.
The keyboard hook consumes only the configured Copilot key's press and release
while the voice app runs, keeping the default Windows action from launching.
The diagnostic keys command remains passive. Closing or losing the owning Node
process releases suppression; the isolated orb preview installs no hook.
It starts hidden, has no taskbar
entry and keeps the voice application running when dismissed.

## Content and retention

All owned UI copy is Polish; transcript and reply retain their original language.
Answers support fenced Markdown code blocks and inline code. Code uses native
Windows monospace fonts and existing surface/border tokens. Fenced blocks preserve
whitespace, scroll horizontally and expose a keyboard-accessible Kopiuj action
with inline success or recovery feedback. Code padding is 6 px; the 28 px copy
button uses a 14 px Lucide copy icon with a Polish accessible name and tooltip.
Blocks have no language header; copy sits in the top-right corner with reserved
space beside the code. Scrollbars are thin, rounded and use transparent tracks;
the same minimal treatment applies to the document and code scrollers.
Copy uses the preload's copyCode command and main-process Electron clipboard,
so hover-only popups can copy without document focus. Only the conversation
window may invoke this text-only command. Verification: `npm test -- test-clipboard.cjs`; `npm run test:desktop`.
Successful copy swaps the icon for a checkmark for 1.5 seconds, with a screen-reader
announcement and no visible message below code. Repeated clicks restart the timer;
copy failures restore the copy icon and show recovery text below the code.
Model output is always inserted as text,
never HTML. Speech reads the prose and inline code, skipping fenced blocks; a
code-only reply announces that the code is available in the conversation window.
Hover displays only the latest exchange. Chat displays previous exchanges above
it and supports document scrolling, with the composer flush to the window bottom.
Exchanges are kept in main-process memory and in the application's private Codex
history under `%LOCALAPPDATA%\ChatGPTButton` (override: `CHATGPT_BUTTON_DATA_DIR`).
LOCAL and realtime ImageGen use the existing Codex account. Only realtime audio
uses a separate Codex home for its API-key login. Versioned session metadata
holds current/previous application IDs, provider mappings, revisions and receipts.
All modes save committed exchanges in app-owned versioned JSON files;
startup and undo load those files. Older realtime conversations without a local
file import available Codex history once. Two-minute context expiry is
independent of 24-hour history retention. Startup, requests and idle maintenance
delete registered expired threads through Codex, retry failures, and remove unused
image artifacts; active requests remain protected. The worker publishes the
remaining completed history after purge. Updates preserve readers' scroll position unless already at
the bottom. No transcript is added to renderer persistent storage.

The history renderer keys rows by conversation/exchange ID and revision, preserving
existing DOM and copy/focus state when a reply is appended. Unchanged conversation
revision and history length skip history work. Only the current conversation's
rows are retained; reset, prune and conversation switches dispose obsolete rows.
Historical PNG previews load near the viewport and release their base64 source
when offscreen. A shared LRU preview cache retains at most 24 entries and 16 MiB
of conservatively counted string data; oversized images are displayed without
being cached. Concurrent requests for the same hash share one read, and failed
reads/decodes can be retried. Latest-image preview remains eager. Native smoke
checks these rules and writes renderer-only timing observations to history-scale.json.

`conversation-context.ts` owns the shared history budget for LOCAL ephemeral and
realtime audio prompts: a chronological suffix of at most 32 complete exchanges,
whose serialized UTF-8 JSON fits 32 KiB. An oversized newest pair keeps its
beginning/end with a visible truncation marker; older history is not summarized
or mutated. The current question and base instructions are excluded from this
history-only byte budget. Stored history and undo remain complete.

The native tray/orb menu owns Zapisz rozmowę… beside Nowa rozmowa. It is unavailable
without a completed reply, while work is active or while another save is pending.
A native OS save dialog chooses a Markdown file; cancel has no effect. Export
captures the selected completed conversation and embeds image pixels so it survives
cleanup. Native localized result dialogs confirm saving or describe recovery.
No new popup controls, geometry or visual tokens are introduced. Retention applies
only to app-owned private history; manually saved exports have no expiry.
Verification: `npm test -- test-app-storage.ts`, `npm run test:integration -- test-storage-wire.ts`
and real Electron `npm run test:desktop`.
Optional SAVE_AUDIO behavior remains documented in README.md.

Generated PNGs use the shared `electron/image-renderer.js` in the latest exchange
and history. Previews fit the conversation width, preserve the image aspect ratio,
and use existing surface and control tokens. Zapisz obraz is an icon-only 24 px
Lucide save button, 4 px inside the image's top-right corner. It reuses popup-action
geometry and uses the background token at 75% opacity (90% on hover), with the text
token for contrast over images. A Polish accessible name and tooltip identify it.
It retains existing focus and disabled states; inline Polish status announces save
success or recoverable errors. Generuję obraz… is the pending state. Missing files
show recovery text and disable saving. A native OS save dialog owns the destination.
Renderer IPC accepts only SHA-256 image IDs, never arbitrary file paths. Artifacts
remain under the private app data directory; conversation/task links contain metadata
only, and ImageGen message content is restored from app-owned files. Reset hides artifacts
without deleting them. Verification: `npm test -- test-images.ts` and the real Electron `npm run test:desktop`.
