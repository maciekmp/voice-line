# Publication readiness review

Reviewed on **9 November 2026** in the existing Windows checkout, starting from
application commit `0549748`, on `chore/publication-readiness`. No repository was
cloned, no changes were pushed, and repository visibility was not changed.
No `AGENTS.md` was present in the repository or its ancestor directories.
The owner's existing `BACKLOG.md` edits and untracked `scripts/promo/` were kept
outside these changes. Original screenshots, videos and local runtime data were
preserved.

## Changes and review findings

- **Process cancellation:** a pre-cancelled `collect()` could miss a later spawn
  error and terminate the worker with an unhandled `ENOENT`. Error listeners now
  exist before cancellation. Cancellation also takes precedence over Windows
  Node 22's secondary `kill EINVAL` when a spawn has failed.
- **Windows command execution:** the old `.cmd` fallback used `shell: true`,
  allowing shell metacharacters in arguments to be reinterpreted. Launches now
  use a recognized Codex npm entry point or a native executable without a shell.
  Unsupported batch wrappers fail with an actionable error. An explicit shim
  path cannot silently select another Codex installation from `PATH`.
- Seven subprocess regression tests cover cancellation, missing executables,
  stdout/stderr/exit status, literal arguments, npm shims and unsupported wrappers.
- Configuration is validated by the existing immutable configuration layer.
  Electron uses isolated, sandboxed renderers, restricted navigation and validated
  IPC. This source review did not establish an exploitable renderer issue; it is
  not a complete penetration test.
- Private `projectRoot` values in `premium-audit.json` and
  `refactor-review-audit.json` now use `.`. Their historical values remain in Git.
  Ignore rules now also cover logs, raw PCM, crash dumps, credential files,
  session variants and SQLite data. No existing file was removed.
- README now provides setup, requirements, architecture, data handling and
  limitations, with detailed references and selected existing screenshots/video.
  [Media provenance and review limits](media/README.md) accompany the copies.

The shell decision follows the warning in the
[Node.js child-process documentation](https://nodejs.org/api/child_process.html)
about passing arguments through a shell. The Electron review used its
[security checklist](https://www.electronjs.org/docs/latest/tutorial/security/).

## Verification performed

Host: Windows, Node **26.13.0**, npm **11.20.0**. Minimum-version checks also used
an isolated official Node **22.18.0** executable, verified against its published
SHA-256 checksum. The installed Node and existing root `node_modules` were not
replaced.

| Check | Result and boundary |
| --- | --- |
| Clean locked dependency installation | PASS: `npm ci` in an isolated directory with copies of the two package manifests; Electron binary download disabled. |
| `npm run check`, Node 26.13.0 | PASS: both no-emit TypeScript checks and **416/416** unit tests; no skips. |
| Equivalent typecheck and unit commands, Node 22.18.0 | PASS: both no-emit checks and **416/416** unit tests; no skips. |
| `npm run test:integration` | PASS: speaker worker, storage wire and realtime wire; local simulated providers/dummy credentials, installed Codex and FFplay. Final run had no `DEP0190` shell warning. |
| `npm run test:desktop` | PASS: real Electron windows with fixture services, including images, clipboard, screen selector, history and reduced-motion checks. Captures retained in `.app-data/test-results/desktop-Y95Tee/`. |
| `npm run test:keyboard` | PASS: **2/2**, native hook suppression/restoration and cleanup when its owner exits; synthetic events, not the physical Copilot key. |
| `npm audit --json` | PASS: **0 reported vulnerabilities** across 37 dependency entries at review time, including development dependencies. This does not prove absence of vulnerabilities. |
| Lockfile source/integrity review | All 37 dependency entries use npm registry URLs and have integrity hashes; installed direct dependencies match the lockfile. No dependency upgrade was necessary for a reported advisory. |
| Workflow and Dependabot YAML | Parsed without errors, warnings or duplicate keys; triggers, matrix, SHA pins and permissions reviewed. |
| Selected documentation media | Original/copy hashes matched; FFprobe metadata checked and full MP4 audio/video decode passed. Visual/privacy review was sampled; see the media notes. |
| Build / installer | **Not available:** no build, bundler or installer script exists. The app runs source directly. Typecheck and Electron smoke are separate validations, not a packaged-release build. |

Initial sandbox attempts could not reach the npm advisory endpoint, write desktop
captures or inject native keyboard events. Those checks were rerun successfully
with the necessary local/network permissions. The first minimum-Node test exposed
the cancellation issue described above; the final suite passed after its fix.

Not exercised: live model inference, real ImageGen, paid realtime API requests,
physical Copilot hardware, microphone-to-Whisper recognition quality, real SAPI
speech, Piper voice quality, a signed installer, or an updater. No passing result
is claimed for these scenarios.

## CI

Windows CI installs locked dependencies and runs typecheck/unit tests on
**22.18.0** (the declared minimum) and **26.x**. The latter was the current LTS
line at review time; see the [Node release table](https://nodejs.org/en/about/previous-releases).
It also runs `npm audit` on 26.x. Dependency installation intentionally skips
the Electron binary; CI does not run the native desktop/keyboard or external-tool
integration suites.

`actions/checkout` and `actions/setup-node` are pinned to verified release commits
([checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1),
[setup-node v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0)).
The workflow retains `contents: read` and disables persisted checkout credentials.
Weekly [Dependabot configuration](../.github/dependabot.yml) covers npm and GitHub
Actions; it does not enable automatic merging.

These workflow edits were validated locally. **The updated workflow has not been
run on GitHub**, because this work was not pushed.

## Remaining publication decisions and limits

1. **Historical privacy:** the [history/security review](SECURITY-REVIEW.md)
   found no confirmed secret with its bounded pattern checks, but historical
   commits retain a Windows profile path and identifying author/committer email.
   Decide whether those disclosures are acceptable before publication. History
   was not rewritten. Remote-only refs, Actions logs/artifacts and release
   attachments were not inspected.
2. **Licensing and media:** no project license has been selected. Review the
   chosen license, generated artwork and Piper voice attribution/redistribution
   before a public release. A full listening/frame-by-frame privacy review of
   the selected film and any other material chosen for release remains pending.
3. **Live acceptance testing:** perform the real Windows voice workflow with the
   intended keyboard, microphone, speech model, voices and account. Realtime
   protocol/model support is experimental and version dependent.
4. **One writer per data root:** Electron and the terminal share an in-process
   storage coordinator only. Run one host per `APP_DATA_DIR`, or use separate
   roots; there is no cross-process transaction lock.
5. **Account trust boundary:** read-only Codex filesystem settings and assistant
   instructions do not disable every configured tool or MCP integration. LOCAL
   speech still sends transcripts/context/images online. Review account tools
   and readable local history, retained audio, exports and debug output before
   handling sensitive content.
6. **Distribution:** source publication and a packaged Windows release are
   different milestones. Signing, installer/update tooling and installer testing
   are absent. The private repository should remain private until the owner makes
   a separate publication decision.
