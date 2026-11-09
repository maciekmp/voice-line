---
version: alpha
name: Voice Line
description: Dyskretny asystent głosowy Windows z panelem rozmowy i wskaźnikiem audio.
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
Copilot recording loop. The conversation panel is the only desktop surface.
Keep audio feedback quiet: warm brown-grey surfaces, left-aligned 12 px text, native
Windows typography, no decorative motion or additional icon vocabulary.
No Japan-market scope is established.

## Runtime ownership

Model B: `electron/conversation.css` owns the panel's semantic CSS variables.
Frontmatter mirrors their values: colors map to `--color-*`, `rounded.DEFAULT`
to `--radius-control`, `spacing.panel` to `--space`, and typography to
`--font-body`. Scrollbar hover uses the muted token. `electron/audio-indicator.js`
owns the shared audio envelope, state, visibility and motion policy. Separate modules in
`electron/audio-effects/` implement bars, mini orb, edge glow and bottom waves through
the same `update(frame)` / `dispose()` interface. `electron/voice-orb.js` and `orb-renderer.js`
provide the reusable mini orb with a static CSS fallback. There is no separate orb window or web preview.

## Copilot: kontrakt interakcji

Stan pracy i widok są niezależne. Popup jest jedynym oknem interfejsu.

| Tryb | Zawartość | Krótki Copilot przy gotowej aplikacji |
| --- | --- | --- |
| hidden | Panel ukryty | compose |
| compose | Samo pole, ewentualnie status lub błąd | chat |
| peek | Najnowsza tura/status, bez pola | compact |
| compact | Najnowsza tura i pole | chat |
| chat | Cała rozmowa i pole | compact |

Wciśnięcie Copilota natychmiast przerywa pracę. Tap (<250 ms) odrzuca audio;
hold (>=250 ms) pokazuje peek, zachowuje szkic i nagrywa od key-down.
Puszczenie po hold wysyła nagranie. Repeats nie uruchamiają kolejnych działań.
Tray otwiera chat; mini orb jest wyłącznie wskaźnikiem, bez akcji kliknięcia.

Przed rzeczywistym rozpoczęciem playbacku przerwanie usuwa bieżącą turę
z historii, zapisu i kontekstu. Tap czyści szkic i zachowuje zakres chat/compact;
z peek dodaje pole w compact, z hidden otwiera compose. Nie przełącza dodatkowo
widoków. Po rozpoczęciu playbacku tura zostaje: LOCAL zachowuje pełną odpowiedź,
API otrzymany fragment z oznaczeniem „Odpowiedź przerwana”. Tap także czyści szkic.
Następne pytanie jest kontynuacją. Sam hold nie czyści szkicu.

Wysłanie tekstu pokazuje compact; odpowiedź tekstowa nie uruchamia odczytu.
Enter wysyła, Shift+Enter dodaje linię, IME nie wysyła. Błędne wysłanie zachowuje
szkic. Podczas startu/awarii tap otwiera pole ze statusem, wysyłanie jest zablokowane;
hold pokazuje stan bez nagrywania. Gotowość w trakcie gestu nie rozpoczyna nagrania.

Escape ukrywa panel, usuwa pin i fokus, zachowuje szkic i nie przerywa pracy.
Aktualizacje tej samej pracy nie otwierają interfejsu. Nowe pytanie lub jawne otwarcie
może go pokazać. Hover nie otwiera ukrytego interfejsu.

Po zakończeniu lub przerwaniu aktywnej pracy działa jeden timer 5 sekund.
Jeśli przy jego wygaśnięciu jest hover, fokus pola lub pin, okno zostaje do jawnego
zamknięcia albo następnej pracy. Unhover, blur i unpin nie uruchamiają timera.
Nowa praca unieważnia stary timer. Błędy pozostają do zamknięcia lub kolejnej akcji.

Wycofanie korzysta z checkpointu danej operacji; spóźniony commit jest odrzucany.
Po korekcie trwałe localContextIds kierują kolejne żądania do świeżego wątku
z kontekstem zachowanych lokalnych tur. Mapowanie dostawcy i rejestr retencji
zmieniają się atomowo; stare wątki pozostają zarejestrowane do czyszczenia.

## Layout and states

Popup pozostaje szeroki na 380 px, maksymalnie 500 px, 20 px od prawej i dolnej
krawędzi obszaru roboczego głównego monitora. Rośnie w górę i mieści się w dostępnym obszarze.
Stały pasek wysokości 32 px zawiera wskaźnik, LOCAL/API i dotychczasowe kontrolki.
Tray przełącza słupki, mini orb 24 px, poświatę krawędzi i delikatne fale u dołu panelu. Domyślnie słupki,
przy braku poprawnego zapisu. Menu „Efekty wizualne” zawiera cztery warianty bez grupowania.
Wybór zapisuje się automatycznie w desktop-settings.json i wraca po restarcie; preview ma osobny plik.
Zmiana wariantu nie zmienia rozmowy, szkicu, fokusu ani widoczności.
Reakcja audio działa tylko w listening/speaking; zmiana stanu i ukrycie zerują poziom.
Nagrywanie używa bufora DirectShow 40 ms i okien pomiaru 20 ms. Ciche poziomy mikrofonu
są wzmacniane tylko wizualnie; wzrost działa natychmiast, wygaszanie ma stałą 50 ms.
Orb i fale korzystają z tej samej obwiedni bez dodatkowego wygładzania. Próbki nagrania
i okna pomiaru odczytu (40 ms) pozostają bez zmian.
Pause i reduced motion zatrzymują ruch. Zmiana wariantu zwalnia zasoby mini orba.
LOCAL/API jest etykietą silnika bez akcji; do poznania trybu pozostaje ukryta.
Wszystkie widoki korzystają ze wspólnych tokenów.
Sticky composer nie ma przycisków wysyłania i anulowania. Status i błąd są
dostępne także w compose. Reduced motion wyłącza animację rozszerzania 220 ms.
Ukrycie resetuje renderer po schowaniu natywnego okna, zachowując szkic.

## Przyciski pomocnicze

Dla pomocniczych akcji w panelu preferuj przyciski ikonowe bez widocznego tekstu,
spójne z kontrolkami podglądu obrazu. Korzystaj z istniejącego stylu `popup-action`
i lokalnych ikon Lucide. Akcje załączników mają przycisk 24 px z ikoną 14 px.

- Dodawanie obrazu: ikona `image-plus`.
- Zaznaczanie fragmentu ekranu: ikona `scan`.
- Usuwanie załącznika przy polu wiadomości: ikona `x` (×) po prawej stronie,
  zamiast tekstowego przycisku „Usuń”.

Ikony dodawania obrazu i zaznaczania ekranu umieszczaj pionowo, jedna pod drugą,
wewnątrz prawej części pola tekstowego. Pole ma co najmniej 70 px wysokości,
aby oba przyciski mieściły się w jego granicach. Zarezerwuj dla nich miejsce
w paddingu pola, aby tekst, także wielowierszowy, nie wchodził pod przyciski.

Wybór pliku i wklejanie obrazu zachowują widoczny panel oraz szkic. Podczas
dodawania obrazu blokuj ikony akcji, bez widocznego napisu „Dodaję obraz…”.
Status operacji pozostaje dostępny dla czytników ekranu. Panel ukrywaj tylko
na czas zaznaczania ekranu, a następnie przywracaj rozmowę.

Każdy przycisk ikonowy ma polską etykietę `aria-label` i podpowiedź `title`.
SVG jest dekoracyjne (`aria-hidden="true"`, `focusable="false"`). Zachowuj
widoczny fokus klawiatury oraz stany hover i disabled.

## Behavior owners

| Capability | Canonical owner | Source | Verification |
| --- | --- | --- | --- |
| Voice lifecycle | src/application-controller.ts; src/main.ts adapters | Injected controller for Copilot/text, cancellation, reset, previous and shutdown | typecheck; controller public API tests; Electron snapshots |
| State fan-out and visibility | electron/desktop-main.cjs | User request: hide until listening, hide after speech | `npm run test:desktop` |
| Overlay behavior | electron/overlay-controller.cjs | hidden/peek/compose/compact/chat; one 5-second completion timer | `npm test -- test-overlay.cjs`; `npm run test:desktop` |
| Copilot gestures | src/keyboard/copilot-gesture.ts | tap opens input; hold records; repeat and cancellation handling | `npm test -- test-copilot.ts`; typecheck |
| Keyboard delivery | src/keyboard/bridge.ps1; src/keyboard/copilot-key.ts | configured key consumed while voice app runs; other keys pass; parent-exit cleanup | `npm run test:keyboard` |
| Hover detection | electron/overlay-pointer.cjs | Native cursor and current window bounds, sampled every 50 ms | `npm test -- test-overlay.cjs`; `npm run test:desktop` |
| Feedback | electron/conversation.js | Lifecycle IPC snapshots | `npm run test:desktop` |
| Code answers | electron/answer-format.js; electron/answer-renderer.js | Shared parsing for latest reply, history and speech | `npm test -- test-answers.js`; `npm run test:desktop` |
| Scrollbar | electron/conversation.css | Global semantic tokens | static audit; runtime inspection |
| Voice visual | electron/voice-orb.js | Panel audio feedback | `npm run test:desktop` |

## Motion and platform

Desktop speech uses measured 40 ms PCM RMS windows for microphone and both TTS
engines. The shared orb lifts quiet syllables with a bounded nonlinear envelope,
scales from 1 to 1.2 with a 48/s attack and 12/s release, and follows scale changes
with a 40 ms transition. Audio activity also accelerates and bends its cloud flow;
silence returns it to its base size. Its 54 px hit target stays fixed. Audio-level
IPC updates only the orb, never conversation layout or visibility. Reduced motion
disables scaling and pausing freezes it. SAPI synthesizes to memory before playback
so its envelope matches the played audio; no extra audio file is retained.

Orb i popup mają wspólną widoczność zgodną z kontraktem. Pin pozostaje
przyciskiem 24 px z nazwami Przypnij popup/Odepnij popup. Hover nie przejmuje fokusu.

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
Focus/blur nie zmienia widoku ani nie uruchamia timera. Hook konsumuje tylko
skonfigurowany Copilot. Zamknięcie procesu zwalnia hook; preview go nie instaluje.
Aplikacja działa po ukryciu powierzchni i nie ma wpisu na pasku zadań.

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
The voice view displays only the latest exchange. Chat displays previous exchanges above
it and supports document scrolling, with the composer flush to the window bottom.
Exchanges are kept in main-process memory and in the application's private Codex
history under `%LOCALAPPDATA%\VoiceLine` (override: `APP_DATA_DIR`).
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
