# Changelog

Notable changes to `xcodebuild-axi`. Versions follow
[semver](https://semver.org/); the format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.2] - 2026-09-21

### Fixed

- The no-argument home view reported a **build** as a passing test run. Found
  by installing 0.1.1 globally and pointing it at a real workspace, where the
  last run rendered as `Test - MyApp on unknown — 0 passed`.

  `xcresulttool` answers the test-shaped query for any bundle, so a build comes
  back as `{title: "Test - X", totalTestCount: 0, result: "unknown"}` rather
  than as nothing, and the guard tested for `undefined` when the count is `0`.
  Since this line is what a session-start hook puts in front of an agent, it
  was the one thing in the tool most likely to be believed and least likely to
  be checked. The bundle's own name records which command wrote it, so that is
  now the signal; a run that recorded no tests says so instead of showing a
  zero verdict.

## [0.1.1] - 2026-09-21

No code changes. The published files are byte-identical to 0.1.0.

### Changed

- Released through npm trusted publishing, so this version carries a
  **provenance attestation** linking the tarball to the workflow run and commit
  that built it. 0.1.0 was published by hand and cannot have one: neither a
  scoped token nor a trusted publisher can be configured for a package that
  does not exist yet.

## [0.1.0] - 2026-09-21

First release.

### Added

- **`build`, `test`, `tests`, `clean`, `analyze`, `archive`, `export`** — run an
  action and report from the `.xcresult` bundle rather than the transcript.
  Diagnostics carry `file,line,col`; the full log is streamed to a file and
  never read into memory.
- **`schemes`, `destinations`, `testplans`, `settings`, `packages`, `info`** —
  read-only queries that answer one question each.
- **`result`, `coverage`** — re-read a previous run's bundle without rebuilding.
- **`sim`, `platforms`** — inspect and boot simulators, list runtimes, and drive
  platform downloads.
- **`localize`, `xcframework`, `find`, `migrate`** — XLIFF import/export,
  `.xcframework` assembly, toolchain lookup, and project-format conversion.
- **`setup hooks`** — session-start hooks for Claude Code, Codex, and OpenCode,
  plus a bundled skill for agents that read the skill format.
- Destinations resolve to a simulator **udid** before the run, so a duplicated
  device name cannot silently send a run to the wrong runtime, and the reported
  destination is read back out of the result bundle.
- 100% of the 117 options `xcodebuild -help` lists are covered, declared in
  `src/surface.ts` and checked against the installed Xcode in CI.

[unreleased]: https://github.com/alexrrouse/xcodebuild-axi/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/alexrrouse/xcodebuild-axi/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/alexrrouse/xcodebuild-axi/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/alexrrouse/xcodebuild-axi/releases/tag/v0.1.0
