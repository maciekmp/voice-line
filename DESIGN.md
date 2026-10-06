---
version: alpha
name: Voice Line
description: Dyskretny asystent głosowy Windows z kulką i czytelną odpowiedzią.
colors:
  primary: '#2457d6'
  background: '#f6f8fc'
  surface: '#ffffff'
  text: '#172746'
  muted: '#53627b'
  border: '#d4ddec'
  danger: '#a12932'
  scrollbar: '#8695ae'
typography:
  sans:
    fontFamily: "'Segoe UI', system-ui, sans-serif"
rounded:
  DEFAULT: '10px'
spacing:
  panel: '20px'
components:
  button: {}
  voice-orb: {}
  status: {}
---

# Voice Line

## Product and visual intent

A Polish-language Windows voice tool, grounded in README.md and the existing
Copilot recording loop. The blue flowing orb is the recognizable signature.
Keep everything around it quiet: pale blue surfaces, left-aligned text, native
Windows typography, no decorative motion or additional icon vocabulary.
No Japan-market scope is established.

## Runtime ownership

Model B: `electron/conversation.css` owns the panel's semantic CSS variables.
Frontmatter mirrors their values: colors map to `--color-*`, `rounded.DEFAULT`
to `--radius-control`, `spacing.panel` to `--space`, and typography to
`--font-body`. Scrollbar hover uses the muted token. `preview/voice-orb.js`
and `orb-renderer.js` remain the single visual orb primitive for browser,
desktop indicator and conversation panel. The transparent desktop shell has
its own geometry; it does not adopt the panel background.

## Layout and states

440 × 620 initial panel, minimum 340 × 420. The document owns scrolling;
long answers and enlarged text grow naturally, with no competing inner scroller.
Presence precedes the question and answer. Recording and cancellation controls
follow the answer. Controls have stable height, visible focus, pointer feedback
and disabled states. Error text includes a recovery instruction. Color is never
the sole state indicator: panel text and orb tooltip name the current operation.

## Behavior owners

| Capability | Canonical owner | Source | Verification |
| --- | --- | --- | --- |
| Voice lifecycle | src/main.ts | Existing Copilot loop | typecheck; Electron snapshots |
| State fan-out and visibility | electron/orb-main.cjs | User request: hide until listening, hide after speech | test:orb |
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
The desktop orb does not steal focus. The panel opens on initial launch and from
the tray; closing it hides the panel while the voice application keeps running.

## Content and retention

All owned UI copy is Polish; transcript and reply retain their original language.
Only the latest question and reply are displayed and kept in process memory.
Codex conversation persistence and optional SAVE_AUDIO behavior remain as
documented in README.md. New conversation clears the displayed exchange and
resets Codex context. No transcript is added to renderer persistent storage.
