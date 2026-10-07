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

380 px wide popup with height measured from its content, anchored 8 px above
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
| Voice lifecycle | src/main.ts | Existing Copilot loop | typecheck; Electron snapshots |
| State fan-out and visibility | electron/orb-main.cjs | User request: hide until listening, hide after speech | test:orb |
| Overlay behavior | electron/overlay-controller.cjs | hidden/peek/chat/compose; one exit timer; new recording cancels stale hides | test:overlay; test:orb |
| Copilot gestures | src/keyboard/copilot-gesture.ts | tap opens input; hold records; repeat and cancellation handling | test:copilot; typecheck |
| Keyboard delivery | src/keyboard/bridge.ps1; src/keyboard/copilot-key.ts | configured key consumed while voice app runs; other keys pass; parent-exit cleanup | test:keyboard |
| Hover detection | electron/overlay-pointer.cjs | Native cursor and current window bounds, sampled every 50 ms | test:overlay; test:orb |
| Feedback | electron/conversation.js | Lifecycle IPC snapshots | test:orb |
| Scrollbar | electron/conversation.css | Global semantic tokens | static audit; runtime inspection |
| Voice visual | preview/voice-orb.js | Existing browser preview | test:orb |

## Motion and platform

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
The desktop orb does not steal focus. Hover opens the conversation popup without
focus; a one-second exit delay allows crossing into it. Starting a new recording
keeps the visible popup's size stable. Answer text suppresses the status label.
Primary mouse press toggles chat and peek before mouse-up; keyboard activation
of the orb does the same, while tray activation always opens chat. All use the
same controller. Hover never takes focus; native activation is enabled
for mouse presses. Escape dismisses explicitly. Focus/blur does not change mode
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
Hover displays only the latest exchange. Chat displays previous exchanges above
it and supports document scrolling, with the composer flush to the window bottom.
Exchanges collected during the current app run are kept in main-process memory;
they survive popup dismissal and clear on New conversation. Earlier Codex thread
messages from previous app runs are not loaded by this view. Updates keep readers
at their scroll position unless they were already at the bottom.
Codex conversation persistence and optional SAVE_AUDIO behavior remain as
documented in README.md. New conversation clears the displayed exchange and
resets Codex context. No transcript is added to renderer persistent storage.
