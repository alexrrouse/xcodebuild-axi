<h1 align="center">xcodebuild-axi</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/xcodebuild-axi"><img alt="npm" src="https://img.shields.io/npm/v/xcodebuild-axi?style=flat-square" /></a>
  <a href="https://axi.md/"><img alt="AXI" src="https://img.shields.io/badge/AXI-compliant-blue?style=flat-square" /></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS-lightgrey?style=flat-square" />
  <!-- coverage-badge:start --><img alt="xcodebuild coverage" src="https://img.shields.io/badge/xcodebuild_coverage-93.2%25-brightgreen?style=flat-square" /><!-- coverage-badge:end -->
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green?style=flat-square" />
</p>

<h3 align="center">A passing test run should not cost 549 KB of context.</h3>

`xcodebuild` tells an agent everything and therefore nothing. One passing test
run of a single app in a real iOS workspace prints **549,290 bytes across 6,595
lines** — 767 of which say a test passed, and none of which say anything went
wrong. A full verify run of the same repo prints 2.5 MB. An agent that has to
read that to learn one number pays for it on every change, several times over.

`xcodebuild-axi` runs the same build and reports the answer.

```sh
$ xcodebuild-axi test --scheme Futures --device "iPhone 17 Pro"
test: passed
scheme: Futures
destination: iPhone 17 Pro · iOS Simulator 26.5
tests: 767 passed / 0 failed / 0 skipped
duration: 15m34s
log: ~/Library/Caches/xcodebuild-axi/Apps-1a2b3c4d/Futures-iPhone-17-Pro-test.log
result: ~/Library/Caches/xcodebuild-axi/Apps-1a2b3c4d/Futures-iPhone-17-Pro-test.xcresult
```

The whole transcript still lands in `log`, so nothing is lost — it just stops
being the default answer.

## Why it can be this small

The transcript is not the best record of a build. The `.xcresult` bundle
xcodebuild writes alongside it is: a few KB of JSON carrying pass/fail counts,
the device the run actually landed on, and every diagnostic with a precise
source location. `xcodebuild-axi` streams the transcript straight to a log file
it never reads into memory, then reports from the bundle.

That also makes it more accurate than grepping. A failed build reports the real
error with the real line:

```sh
$ xcodebuild-axi build --scheme Probe
build: failed
scheme: Probe
destination: My Mac · macOS 26.6.1
duration: 4.6s
errors[1]{file,line,col,type,message}:
  Sources/Probe/Probe.swift,2,25,swift,Cannot convert value of type 'String' to specified type 'Int'
log: ~/Library/Caches/xcodebuild-axi/Probe-9f8e7d6c/Probe-My-Mac-build.log
```

21,636 bytes of transcript, one line of answer.

## Measured

Against a real 12-scheme iOS workspace with 16 local Swift packages:

| Command                          | Raw `xcodebuild` | `xcodebuild-axi` |  Saved |
| -------------------------------- | ---------------: | ---------------: | -----: |
| `test` (one app, one simulator)  |        549,290 B |           ~250 B | 99.95% |
| `test` (larger app)              |      1,300,084 B |           ~250 B | 99.98% |
| `build` (failing, small package) |         21,636 B |           ~350 B |  98.4% |
| `settings --key A,B,C`           |         40,944 B |            178 B |  99.6% |
| `destinations`                   |          4,816 B |           ~900 B |    81% |
| `schemes`                        |          1,565 B |           ~490 B |    69% |

Even the read-only commands win, because xcodebuild reprints its invocation,
`Resolve Package Graph`, and the full resolved package list on _every_ call —
about 1.2 KB of identical preamble in front of a 349-byte answer.

## Install

```sh
npm install -g xcodebuild-axi
```

Or run it without installing:

```sh
npx -y xcodebuild-axi
```

Requires macOS with Xcode installed, and Node 20+.

## Commands

Running it with no arguments shows the project in front of you, not a manual:

```sh
$ xcodebuild-axi
bin: ~/.local/bin/xcodebuild-axi
description: Agent-ergonomic wrapper around xcodebuild.
workspace: Apps
scheme_count: 12
schemes[12]: Accrue,Apps-Workspace,FiveDice,Futures,Futures-WidgetExtension,Ration,...
last: Test - Ration on iPhone 17 Pro · iOS Simulator 26.5 — 89 passed (4m ago)
help[2]:
  Run `xcodebuild-axi build --scheme <name>` to build
  Run `xcodebuild-axi test --scheme <name>` to run tests
```

| Command        | What it does                                                      |
| -------------- | ----------------------------------------------------------------- |
| _(none)_       | Dashboard: what is here, what can be built, how the last run went |
| `build`        | Build a scheme; report only errors, with `file,line,col`          |
| `test`         | Run tests; report counts and only the failures                    |
| `tests`        | Enumerate the tests a scheme defines, without running them        |
| `clean`        | Clean a scheme's build products                                   |
| `analyze`      | Run the static analyzer; report only what it found                |
| `archive`      | Archive a scheme and report the archive's bundle id and version   |
| `export`       | Export an archive, writing the export options plist for you       |
| `schemes`      | List the schemes in the workspace or project                      |
| `destinations` | List the destinations a scheme can actually run on                |
| `testplans`    | List a scheme's test plans                                        |
| `settings`     | Read named build settings instead of dumping all 400              |
| `packages`     | Read the pinned Swift package versions; resolve them on request   |
| `info`         | Xcode version, SDKs, and what this tool is pointed at             |
| `result`       | Re-read a previous run's `.xcresult` without rebuilding           |
| `coverage`     | Code coverage from a result bundle, per target or per file        |
| `sim`          | Boot, shut down, and inspect simulators                           |
| `platforms`    | Installed runtimes, and the downloads that add more               |
| `localize`     | Export and import XLIFF localization catalogs                     |
| `xcframework`  | Bundle built frameworks or libraries into an `.xcframework`       |
| `find`         | Resolve an executable or library to its toolchain path            |
| `setup`        | Install session-start hooks for Claude Code, Codex, and OpenCode  |

Every command takes `--help`.

## How much of xcodebuild

<!-- coverage:start -->

**Coverage: 93.2% of `xcodebuild` — 109 of its 117 options and 9 of its 10 build actions.**

101 options map to an `xcodebuild-axi` flag; 8 more the tool always sets for you, so there is nothing to pass. The remaining 8 are deliberately not wrapped:

| Option                 | Why not                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `-convert-project`     | rewrites project files in place — an editor operation, not a build                                                         |
| `-help`                | `xcodebuild-axi --help` answers the same question in a fraction of the tokens                                              |
| `-license`             | an interactive sudo prompt, which an AXI must never issue                                                                  |
| `-quiet`               | verbosity is not a knob here: the full transcript always goes to a log and the summary always comes from the result bundle |
| `-resultBundleVersion` | the tool owns the bundle and pins the version its reader understands                                                       |
| `-resultStreamPath`    | a live NSSecureCoding event stream has no agent-readable consumer                                                          |
| `-usage`               | same as -help                                                                                                              |
| `-verbose`             | same as -quiet                                                                                                             |

The denominator is read from the `xcodebuild -help` on the machine running `npm run coverage`, and CI fails if a new Xcode adds an option this table has never classified.

<!-- coverage:end -->

### Destinations you do not have to spell

The `-destination` specifier is the thing agents most reliably get wrong
against raw `xcodebuild`, and a miss costs a whole failed invocation. Pass a
name, or pass nothing:

```sh
xcodebuild-axi test --scheme Tides --device "iPhone 17 Pro"   # matched for you
xcodebuild-axi test --scheme Tides                            # newest simulator
xcodebuild-axi test --scheme Tides --destination "platform=iOS Simulator,id=…"
```

Names are resolved to a simulator **udid** before the run, because two runtimes
routinely publish the same device name and a name-based specifier silently
picks whichever xcodebuild sees first. The reported destination is the one the
run actually landed on, read back out of the result bundle.

### Reading a run again

`build` and `test` both print the bundle they wrote, so nothing needs re-running
to be re-read:

```sh
xcodebuild-axi result ~/Library/Caches/xcodebuild-axi/Apps-1a2b3c4d/Tides-test.xcresult --failures --full
```

## Ambient context

Two ways to get this in front of an agent before it reaches for raw
`xcodebuild`. You only need one.

**Session hooks** — the project's schemes and last run become context at the
start of every session:

```sh
xcodebuild-axi setup hooks              # your home directory
xcodebuild-axi setup hooks --project    # just this repository
xcodebuild-axi setup hooks --status     # report, writing nothing
```

Covers Claude Code, Codex, and OpenCode. Installs are idempotent and repair a
stale path.

**A skill** — loads on demand instead of on every session, and works in any
agent that reads the skill format:

```sh
npx skills add arouse/xcodebuild-axi --skill xcodebuild-axi
```

## Conventions

- **Output is [TOON](https://toonformat.dev/)** on stdout, ~40% cheaper than the
  equivalent JSON.
- **Errors are data.** They go to stdout in the same shape as an answer, with a
  `code` and a `help[]` that names the command that fixes it.
- **Exit codes**: `0` success, `1` the build or tests failed, `2` usage error.
  A failed build still prints its full report — the exit code is for your `&&`,
  the report is for the agent.
- **Unknown flags fail loudly**, by name, with the valid set listed inline. A
  silently dropped filter is worse than an error.
- **Nothing is written to your repository.** Logs and result bundles live under
  `~/Library/Caches/xcodebuild-axi/`, keyed by project path.
- **No interactive prompts, ever.** Code signing is off by default so simulator
  builds need no team; pass `--sign` when you mean it.

## Environment

| Variable         | Effect                                           |
| ---------------- | ------------------------------------------------ |
| `XCODEBUILD_BIN` | Override the wrapped `xcodebuild` binary         |
| `DEVELOPER_DIR`  | Select an Xcode, as `xcodebuild` itself reads it |

## Built on

[AXI](https://axi.md/) — the design standard for agent-facing CLIs — via
[`axi-sdk-js`](https://www.npmjs.com/package/axi-sdk-js).

## License

MIT
