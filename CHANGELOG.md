# Changelog

Notable changes to `xcodebuild-axi`. Versions follow
[semver](https://semver.org/); the format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- `export --upload` writes `destination: upload` into the generated options
  plist, so a CI ship can hand the build to App Store Connect instead of
  writing an `.ipa` nobody collects. Without it, `--method` could only ever
  produce a file on disk and every uploading pipeline had to author the XML by
  hand — which is the side quest `--method` exists to remove.
- `export --no-manage-version` sets `manageAppVersionAndBuildNumber` to
  `false`. Xcode's default is to re-pick the build number at upload, which
  discards a number set at archive time and, with it, any way to tell which
  commit a build came from.
- `export --no-upload-symbols` reaches `uploadSymbols`, which the plist builder
  already supported and no flag could set.

### Fixed

- A successful upload no longer reports `products: 0 files written to …`. An
  upload leaves nothing on disk by design, so the warning meant for a silently
  wrong options plist was calling a delivered build a broken export. It now
  says the build was sent — and it decides by reading the plist back rather
  than by trusting the flag, so a hand-written `--options` plist that uploads
  is reported correctly too.

## [0.1.5] - 2026-09-21

### Added

- `--artifacts-dir <path>` on the build family (`build`, `test`, `analyze`,
  `archive`, `tests`), choosing where a run's log and `.xcresult` land. The
  default is unchanged.

  CI could not collect either one. `artifactDir()` is hardcoded under
  `~/Library/Caches/xcodebuild-axi/`, which is right for an interactive agent
  and wrong for a workflow that ends in
  `upload-artifact: path: build/` -- point such a job at this tool and a red run
  silently uploads nothing, losing the one output worth reading. A relative path
  resolves against the working directory, so `--artifacts-dir build/` means the
  checked-out workspace.

### Changed

- `-resultBundlePath` moves from "reachable without a flag" to **exposed** in
  the coverage table. The reasoning it carried still holds -- the tool writes
  the bundle and reads its report back -- it just no longer insists on choosing
  the location.

## [0.1.4] - 2026-09-21

### Added

- `settings` takes `--device`, `--destination` and `--sdk`. Build settings are
  destination-dependent, and without one xcodebuild resolves against the
  default _device_ SDK -- so `BUILT_PRODUCTS_DIR` came back under
  `Debug-iphoneos` while `build` and `test` default to a simulator. There was
  no flag to ask otherwise, which made `settings` the wrong way to locate a
  simulator `.app`, silently.

### Changed

- `settings` reports `platform:` alongside the scheme, so an answer always
  names the destination it is for. The default is unchanged -- still the
  device SDK -- but it no longer looks like the simulator one.

### Fixed

- `result` reported a **build** bundle as a test run: `result: unknown`,
  `title: Test - MyApp`, `0 passed / 0 failed`, on an `unknown` destination.
  This is the same misread 0.1.2 fixed in the home view, in the second place it
  lives -- and 0.1.2 made it easier to reach rather than harder, because the
  home view now prints `see \`xcodebuild-axi result <path>\`` and that command
  then gave the wrong answer.

  `home.ts` discriminates on the name `runLabel` gave the bundle, which `result`
  cannot do: it takes an arbitrary path, and its own help offers
  `build/MyApp.xcresult`. So `result` gates the verdict path on the bundle
  having actually recorded tests, and reports anything else from
  `build-results`, which carries the real `actionTitle`, `status` and
  `destination`. A build now reads `result: succeeded`, `title: Build "MyApp"`,
  with the device it landed on.

## [0.1.3] - 2026-09-21

### Fixed

- `setup hooks` installed a session-start hook with a **10 second timeout**,
  which is not long enough. The home view runs `xcodebuild -list`, and against
  a workspace with 16 local Swift packages that resolves the package graph on a
  cold run: measured 10.9s cold, then 2.9s and 1.4s warm. Cold is exactly the
  case a session start hits, so the hook would be killed before it produced
  anything — silently, with no error to notice. The timeout is now 30s, which
  is a ceiling rather than a cost: a warm run still returns in a second or two.

  Re-run `xcodebuild-axi setup hooks` to repair an already-installed hook; it
  updates the existing entry in place rather than adding a second one.

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

[unreleased]: https://github.com/alexrrouse/xcodebuild-axi/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/alexrrouse/xcodebuild-axi/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/alexrrouse/xcodebuild-axi/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/alexrrouse/xcodebuild-axi/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/alexrrouse/xcodebuild-axi/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/alexrrouse/xcodebuild-axi/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/alexrrouse/xcodebuild-axi/releases/tag/v0.1.0
