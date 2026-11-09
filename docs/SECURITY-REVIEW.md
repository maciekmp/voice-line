# Repository data and history review

Reviewed on 2026-11-09 against application commit `0549748` on
`chore/publication-readiness`. This report records that local review checkpoint.
The owner subsequently authorized publication on 2026-11-09; the repository is
now public with its history retained. The scan below is bounded, not a guarantee
that every possible disclosure was detected.

## Scope and method

- Inspected the 192 files tracked at the starting commit, `.gitignore`, historical
  paths, Git refs and reflogs. Ordinary branch/remote/tag history contained 36
  commits and 950 reachable objects.
- Scanned **all 1,465 objects present in the local Git object database**, including
  internal Codex snapshots, reflog history and unreachable objects: 39 commit
  objects, 381 trees and 1,045 blobs (30,315,719 bytes). Of the blobs, 1,032 were
  text and 13 were binary. No blob was skipped for size.
- Used read-only `git cat-file` access and pattern checks for private keys,
  OpenAI/GitHub/AWS/Slack/Google credentials, JWTs, credential-bearing URLs,
  generic credential assignments, Windows profile paths, email addresses and
  private-network URLs. Candidate assignments were classified as application
  references, environment restoration, test fixtures or documentation. Output
  contained categories, paths, object IDs and line numbers, without credential
  values.
- Checked ignore behavior for local configuration, runtime data, generated output
  and the archived prototype. No history was rewritten and no materials were
  deleted. The existing changes in `BACKLOG.md` and `scripts/promo/` were preserved.

The counts describe the starting local object database, not subsequent changes
or a fresh remote scan. The internal `refs/codex/turn-diffs/...` snapshot includes
the otherwise untracked promotional source and two PNG assets; it is separate
from the application branch history. Ten further PNG artwork objects occur only
in local unreachable trees. The ordinary application history contains no audio,
video, screenshot, log, database or conversation-dump files; its only path matching
the sensitive-file inventory is the intentionally public configuration template,
`.env.example`. The application tray icon is also tracked.

## Findings

| Finding | Evidence | Publication consequence |
| --- | --- | --- |
| No confirmed credential found by these checks | No matches for the high-confidence credential/key patterns; generic assignment candidates were code, fixtures and documentation | This is evidence from a bounded scan, not a guarantee that no secret exists. No credential revocation was performed. |
| Personal machine path in tracked audit reports | At the starting commit, `premium-audit.json:4` and `refactor-review-audit.json:4` contained the same private `projectRoot` value | Both working copies now use `.`. Old commits still retain the original path. |
| The private path remains in history | Introduced in `premium-audit.json` by `d3808f8`, and in `refactor-review-audit.json` by `586990c` | The owner accepted publication with the historical Windows profile identifier retained. A working-tree edit does not remove it from Git history. |
| Identifying commit metadata | One distinct non-noreply author/committer email in application history | The owner accepted publication with the existing author/committer metadata retained. Values are intentionally omitted here. |
| Private local data exists outside tracked history | `.env`, `.app-data/`, `.chatgpt-button/`, prototype session files and `output/` are ignored | Keep these local. Do not force-add them or distribute the entire working directory as a release archive. Select documentation media explicitly. |

`.env` and archived authentication/session files were not printed or copied into
the review. Their ignored status was checked without exposing their contents.
There was no confirmed committed secret requiring a history rewrite in the
reviewed text. The owner accepted the historical privacy disclosures above;
that decision does not broaden the scope of the scan.

## Handling documentation media

Keep original screenshots and videos in place. Documentation should use explicit
copies of selected assets, with their provenance recorded under `docs/media/`.
Generated folders contain more than the selected documentation assets and must
remain ignored. The owner confirmed review of the selected documentation media
and approved their publication on 2026-11-09. New media and third-party
model/artwork attribution and redistribution conditions require separate review.
A text-pattern scan cannot establish that spoken content or pixels contain no
personal information.

## Limits and future checks

This was a local repository and object-database review. Remote-only refs, GitHub
Actions logs/artifacts, issues, release attachments, caches and other clones were
not inspected. No credential was tested against a service. Binary image contents
were inventoried, not OCR-scanned; ignored recordings were not transcribed or
auditioned as part of this history scan. Encoded, encrypted, unusual or short
credentials can evade pattern matching.

For future releases, repeat the scan against the exact proposed commit and
selected media, review any new identifying metadata, and check GitHub-hosted
artifacts separately. Runtime, dependency, CI and test results are recorded
separately in the [readiness review](READINESS.md).
