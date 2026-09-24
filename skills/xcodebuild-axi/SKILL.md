---
name: xcodebuild-axi
description: >
  Build, test, and inspect Xcode projects without reading xcodebuild's output.
  Use for any iOS/macOS build, test run, scheme or destination lookup, build
  setting read, or .xcresult inspection — raw xcodebuild prints hundreds of
  kilobytes to say what this prints in a few lines.
---

# xcodebuild-axi

Agent-ergonomic wrapper around xcodebuild. Prefer it over raw `xcodebuild` for any build / test / inspect of an Xcode project.

Run it with no arguments first — it reports the project in front of you, its
schemes, and how the last run went.

```sh
npx -y xcodebuild-axi
```

## Commands

```
usage: xcodebuild-axi [command] [flags]
commands[24]:
  (none)=dashboard
  build, run, test, tests, clean, analyze, archive, export
  schemes, destinations, testplans, settings, packages, info
  result, coverage, sim, platforms, setup
  localize, xcframework, find, migrate
flags[2]:
  --help, -v/-V/--version
env[2]:
  XCODEBUILD_BIN  override the wrapped xcodebuild binary
  DEVELOPER_DIR   select an Xcode, as xcodebuild itself reads it
exit:
  0 success, 1 the build or tests failed, 2 usage error
examples:
  xcodebuild-axi
  xcodebuild-axi build --scheme MyApp
  xcodebuild-axi run --scheme MyApp --device "iPhone 17 Pro"
  xcodebuild-axi test --scheme MyApp --device "iPhone 17 Pro" --coverage
  xcodebuild-axi settings --key PRODUCT_BUNDLE_IDENTIFIER
  xcodebuild-axi setup hooks
```

Every command takes `--help` with its own flags and examples. The CLI's own
output is the authority on everything below the top level; prefer asking it
over guessing.

## What to reach for

- Building or testing: `build` and `test` report only what failed, with
  `file,line,col`. The full transcript is written to a log whose path they
  print, so detail is one read away and never the default.
- Picking a device: pass `--device "iPhone 17 Pro"`, or nothing at all to get
  a booted simulator, else the newest. Do not hand-write a `-destination`
  specifier.
- Seeing the app: `run` builds, installs and launches it on a simulator in
  one call; then `sim screenshot`, `sim logs`, `sim open <url>`.
- Reading a previous run: `result <path.xcresult>`, which re-reads without
  rebuilding.
- Build settings: `settings --key NAME`, not a full dump.

## Before dropping back to xcodebuild or simctl

Don't guess that something is missing. Type what you would have typed —
`xcodebuild-axi -showBuildSettings`, `xcodebuild-axi simctl io booted
screenshot`, a whole `xcodebuild … test` line — and it answers with the
command that does it here. When something really is not wrapped, the answer
says so and prints the exact raw command to run instead. Fall back only then.

## Exit codes

`0` success, `1` the build or tests failed, `2` usage error. A failed build
still prints its full report to stdout.
