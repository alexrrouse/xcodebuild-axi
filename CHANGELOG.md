# Changelog

Notable changes to `xcodebuild-axi`. Versions follow
[semver](https://semver.org/); the format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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

[unreleased]: https://github.com/alexrrouse/xcodebuild-axi/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/alexrrouse/xcodebuild-axi/releases/tag/v0.1.0
