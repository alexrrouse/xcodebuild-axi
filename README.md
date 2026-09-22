<h1 align="center">xcodebuild-axi</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/xcodebuild-axi"><img alt="npm" src="https://img.shields.io/npm/v/xcodebuild-axi?style=flat-square" /></a>
  <a href="https://axi.md/"><img alt="AXI" src="https://img.shields.io/badge/AXI-compliant-blue?style=flat-square" /></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS-lightgrey?style=flat-square" />
  <!-- coverage-badge:start --><img alt="xcodebuild coverage" src="https://img.shields.io/badge/xcodebuild_coverage-91.3%25-brightgreen?style=flat-square" /><!-- coverage-badge:end -->
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
$ xcodebuild-axi test --scheme MyApp --device "iPhone 17 Pro"
test: passed
scheme: MyApp
destination: iPhone 17 Pro · iOS Simulator 26.5
tests: 767 passed / 0 failed / 0 skipped
duration: 15m34s
log: ~/Library/Caches/xcodebuild-axi/MyApps-1a2b3c4d/MyApp-iPhone-17-Pro-test.log
result: ~/Library/Caches/xcodebuild-axi/MyApps-1a2b3c4d/MyApp-iPhone-17-Pro-test.xcresult
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

Every number below is produced by `npm run benchmark`, which asks raw
`xcodebuild` and `xcodebuild-axi` the same question against a real 12-scheme
iOS workspace with 16 local Swift packages, and tokenizes both answers.

<!-- benchmark:start -->

| Question                                | `xcodebuild`   | `xcodebuild-axi` | Saved      |
| --------------------------------------- | -------------- | ---------------- | ---------- |
| what can I build?                       | 498 tok        | 97 tok           | **80.52%** |
| what can I run it on?                   | 1,720 tok      | 339 tok          | **80.29%** |
| what is the bundle id?                  | 12,221 tok     | 21 tok           | **99.83%** |
| which targets have index settings?      | 61,850 tok     | 42 tok           | **99.93%** |
| which SDKs are installed?               | 244 tok        | 70 tok           | **71.31%** |
| which test plans does this scheme have? | 445 tok        | 42 tok           | **90.56%** |
| **all 6 together**                      | **76,978 tok** | **611 tok**      | **99.21%** |

Token counts are GPT-4o BPE via `gpt-tokenizer` — Anthropic's tokenizer is not public, so this is a stand-in, and the ratios are what matter rather than the absolute numbers. Both stdout and stderr are counted, because that is what an agent running the command in a shell actually reads. Measured by `npm run benchmark` against one app of a real multi-scheme iOS workspace on 2026-09-21.

<!-- benchmark:end -->

Those are the read-only commands, and they win anyway, because xcodebuild
reprints its invocation, `Resolve Package Graph`, and the full resolved package
list on _every_ call — about 1.2 KB of identical preamble in front of a
349-byte answer.

The `build` and `test` rows are where the margin is widest and are not in the
table above: they drive a cold build per side and want a quiet machine. Add
them with

```sh
npm run benchmark -- --project ~/YourApp --scheme YourScheme --only build --resume --write
npm run benchmark -- --project ~/YourApp --scheme YourScheme --only test  --resume --write
```

For scale in the meantime: one `build` of the scheme above wrote a **4.7 MB**
transcript to its log, and a `test` run of another app in the same workspace
wrote **432 KB**. Both are reported in well under 400 bytes.

Reproduce any of it yourself:

```sh
npm run benchmark -- --project ~/YourApp --scheme YourScheme          # everything
npm run benchmark -- --project ~/YourApp --scheme YourScheme --quick  # skip build and test
```

Builds and tests get a separate derived-data directory per side, wiped before
each run, so neither side gets an incremental-build advantage over the other.
Every scenario is checkpointed as it finishes, so `--resume` picks up whatever
already ran.

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
workspace: MyApps
scheme_count: 12
schemes[12]: Analytics,Checkout,DesignSystem,Feed,MyApp,MyApp-Widget,...
last: Test - Checkout on iPhone 17 Pro · iOS Simulator 26.5 — 89 passed (4m ago)
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
| `migrate`      | Report the project file format, and convert it to a newer one     |
| `setup`        | Install session-start hooks for Claude Code, Codex, and OpenCode  |

Every command takes `--help`.

## How much of xcodebuild

<!-- coverage:start -->

**Coverage: 91.3% of the 160 leaves `xcodebuild` documents** — every option, build action, export options key, `-create-xcframework` argument, and the second forms that only a usage line mentions.

A leaf is one switch you could type. Counting options alone says 100% (117/117), which was true and hid every gap below: an option is one thing, and `-exportOptionsPlist` alone opens eighteen more.

| Surface                                                | Leaves  | Covered         |
| ------------------------------------------------------ | ------- | --------------- |
| `xcodebuild -help` options                             | 117     | 117 (100%)      |
| build actions                                          | 10      | 9 (90%)         |
| second forms (`-version <infoitem>`, `-license check`) | 7       | 6 (85.7%)       |
| `-exportOptionsPlist` keys                             | 18      | 6 (33.3%)       |
| `-create-xcframework` options                          | 8       | 8 (100%)        |
| **total**                                              | **160** | **146 (91.3%)** |

**Reach: 93.6%** of the 328 command-and-option pairs. The same options, counted once per command xcodebuild accepts them on — because `-target` exposed on `build` and missing from `settings` is not covered for anyone asking `settings`. 21 pairs are open.

108 options map to an `xcodebuild-axi` flag. The other 9 are reachable without one:

| Option                          | How                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `-json`                         | every read-only query asks for JSON, then reports TOON                          |
| `-project`                      | set from the .xcodeproj found in the working directory                          |
| `-skipMacroValidation`          | macro trust is an interactive prompt in disguise, and an agent cannot answer it |
| `-test-enumeration-format`      | always json, so `tests` can parse it                                            |
| `-test-enumeration-output-path` | written to the tool's cache and read back, never printed                        |
| `-test-enumeration-style`       | always flat; `tests` does its own grouping by target and suite                  |
| `-workspace`                    | set from the .xcworkspace found in the working directory                        |
| `-help`                         | `xcodebuild-axi --help`, which answers it in a fraction of the tokens           |
| `-usage`                        | `xcodebuild-axi <command> --help`, per command rather than all 117 at once      |

The one action left out is `installsrc` — it copies sources into `SRCROOT` as root, which is a packaging step rather than anything an agent loop needs.

### Companion tools

`xcresulttool`, `xccov` and `simctl` are not xcodebuild, so they are not in the number above — but this tool wraps all three, and an agent that has to shell out to one directly has dropped back down. **18.3% of 71 leaves**, counted the same way:

| Tool           | Leaves | Covered   |
| -------------- | ------ | --------- |
| `xcresulttool` | 21     | 4 (19%)   |
| `xccov`        | 9      | 4 (44.4%) |
| `simctl`       | 41     | 5 (12.2%) |

### Still open

65 leaves are known gaps rather than decisions — each one a reason someone would still reach for the raw tool:

| Leaf                                                        | Unreachable from | What that costs                                                                               |
| ----------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------- |
| `-alltargets`                                               | `settings`       | resolves a scheme only, so target-mode projects cannot be asked                               |
| `-alltargets`                                               | `clean`          | `clean` takes three flags today and xcodebuild accepts this one on a clean action             |
| `-arch`                                                     | `settings`       | architecture-dependent settings cannot be asked for one arch                                  |
| `-arch`                                                     | `clean`          | `clean` takes three flags today and xcodebuild accepts this one on a clean action             |
| `-derivedDataPath`                                          | `settings`       | BUILT_PRODUCTS_DIR cannot be asked for the derived data a CI job uses                         |
| `-derivedDataPath`                                          | `packages`       | resolved packages land in derived data, which cannot be redirected                            |
| `-destination`                                              | `clean`          | `clean` takes three flags today and xcodebuild accepts this one on a clean action             |
| `-destination-timeout`                                      | `settings`       | resolves a device by name with no say over the wait                                           |
| `-destination-timeout`                                      | `clean`          | `clean` takes three flags today and xcodebuild accepts this one on a clean action             |
| `-only-testing`                                             | `tests`          | enumeration cannot be constrained the way the run that follows it is                          |
| `-sdk`                                                      | `clean`          | `clean` takes three flags today and xcodebuild accepts this one on a clean action             |
| `-skip-testing`                                             | `tests`          | enumeration cannot be constrained the way the run that follows it is                          |
| `-target`                                                   | `settings`       | resolves a scheme only, so target-mode projects cannot be asked                               |
| `-target`                                                   | `clean`          | `clean` takes three flags today and xcodebuild accepts this one on a clean action             |
| `-toolchain`                                                | `settings`       | settings cannot be resolved against a toolchain                                               |
| `-toolchain`                                                | `clean`          | `clean` takes three flags today and xcodebuild accepts this one on a clean action             |
| `-xcconfig`                                                 | `settings`       | the overrides an xcconfig applies cannot be resolved before a build                           |
| `-xcconfig`                                                 | `clean`          | `clean` takes three flags today and xcodebuild accepts this one on a clean action             |
| `-resultBundlePath`                                         | `clean`          | writes a result bundle the caller cannot redirect                                             |
| `-quiet`                                                    | `clean`          | the clean log cannot be quieted                                                               |
| `-verbose`                                                  | `clean`          | the clean log cannot be made verbose                                                          |
| `-version -sdk <name> <infoitem>`                           | `info`           | `info --sdks` lists canonical names; an SDK's Path or ProductBuildVersion cannot be asked for |
| `provisioningProfiles` (export options)                     | `export`         | manual signing can be asked for but not completed — the profile per executable has no flag    |
| `signingCertificate` (export options)                       | `export`         | manual signing cannot name the certificate to sign with                                       |
| `installerSigningCertificate` (export options)              | `export`         | a macOS installer package cannot name its signing certificate                                 |
| `thinning` (export options)                                 | `export`         | non-App Store exports cannot be thinned for a device variant                                  |
| `stripSwiftSymbols` (export options)                        | `export`         | Swift symbols are always stripped, with no way to keep them                                   |
| `testFlightInternalTestingOnly` (export options)            | `export`         | a build cannot be marked internal-only, which is what a PR build wants                        |
| `distributionBundleIdentifier` (export options)             | `export`         | an archive with several apps cannot pick which one to export                                  |
| `generateAppStoreInformation` (export options)              | `export`         | App Store information cannot be generated for an upload                                       |
| `iCloudContainerEnvironment` (export options)               | `export`         | a CloudKit app cannot choose the Development or Production container                          |
| `manifest` (export options)                                 | `export`         | an over-the-web distribution manifest cannot be written                                       |
| `embedOnDemandResourcesAssetPacksInBundle` (export options) | `export`         | on-demand resource asset packs cannot be embedded for testing                                 |
| `onDemandResourcesAssetPacksBaseURL` (export options)       | `export`         | on-demand resource asset packs cannot be pointed at a host                                    |
| `xcresulttool get test-results tests`                       | `result`         | the full test tree of a finished run cannot be listed                                         |
| `xcresulttool get test-results activities`                  | `result`         | the step-by-step activity trail of a failing test cannot be read                              |
| `xcresulttool get test-results insights`                    | `result`         | Xcode's own diagnosis of a run is left on the floor                                           |
| `xcresulttool get test-results metrics`                     | `result`         | `test --perf-diagnostics` collects performance metrics nothing can read back                  |
| `xcresulttool get log`                                      | `result`         | the build log inside the bundle is reachable only as the raw transcript file                  |
| `xcresulttool get content-availability`                     | `result`         | whether a bundle even has coverage or test results is found out by failing to read it         |
| `xcresulttool export diagnostics`                           | `result`         | `test --diagnostics` collects a diagnostics report that cannot be extracted                   |
| `xcresulttool export attachments`                           | `result`         | UI test screenshots and attachments cannot be got out of the bundle                           |
| `xcresulttool export metrics`                               | `result`         | performance measurements cannot be exported as CSV                                            |
| `xcresulttool export evaluations`                           | `result`         | evaluation attachments cannot be exported                                                     |
| `xcresulttool compare`                                      | `result`         | two runs cannot be diffed, which is the question CI asks most                                 |
| `xcresulttool merge`                                        | `result`         | the bundles of a sharded test run cannot be combined                                          |
| `xcresulttool metadata`                                     | `result`         | a bundle's own metadata cannot be read                                                        |
| `xccov view --report --functions-for-file`                  | `coverage`       | coverage stops at the file, so the uncovered function has no name                             |
| `xccov view --archive`                                      | `coverage`       | a standalone .xccovarchive cannot be read, only a result bundle                               |
| `xccov view --file`                                         | `coverage`       | the per-line coverage of one file cannot be printed                                           |
| `xccov diff`                                                | `coverage`       | 'did coverage drop' cannot be answered from two bundles this tool wrote                       |
| `xccov merge`                                               | `coverage`       | the coverage of a sharded run cannot be combined                                              |
| `simctl install`                                            | `sim`            | a built .app cannot be put on the simulator it was built for                                  |
| `simctl launch`                                             | `sim`            | the app a build just produced cannot be run                                                   |
| `simctl terminate`                                          | `?`              | a running app cannot be stopped                                                               |
| `simctl uninstall`                                          | `?`              | an installed app cannot be removed                                                            |
| `simctl listapps`                                           | `sim`            | what is installed on a simulator cannot be listed                                             |
| `simctl create`                                             | `?`              | a missing device cannot be created                                                            |
| `simctl delete`                                             | `sim`            | stale devices cannot be reclaimed, and they cost gigabytes                                    |
| `simctl io`                                                 | `sim`            | a screenshot of a failing UI cannot be taken                                                  |
| `simctl openurl`                                            | `sim`            | a deep link cannot be opened, which is how deep links are tested                              |
| `simctl privacy`                                            | `sim`            | a permission prompt cannot be granted ahead of a UI test                                      |
| `simctl push`                                               | `sim`            | a push notification cannot be simulated                                                       |
| `simctl status_bar`                                         | `sim`            | the status bar cannot be pinned, which screenshot tests need                                  |
| `simctl ui`                                                 | `sim`            | dark mode and content size cannot be set for a test run                                       |

The denominator is read from `xcodebuild -help` rather than hand-maintained, and this table is written against **Xcode 27.0** — the option list moves between releases. `npm run coverage:check` fails on that Xcode if an option here is unclassified or has been dropped, and reports the difference without failing on any other.

<!-- coverage:end -->

### Destinations you do not have to spell

The `-destination` specifier is the thing agents most reliably get wrong
against raw `xcodebuild`, and a miss costs a whole failed invocation. Pass a
name, or pass nothing:

```sh
xcodebuild-axi test --scheme MyApp --device "iPhone 17 Pro"   # matched for you
xcodebuild-axi test --scheme MyApp                            # newest simulator
xcodebuild-axi test --scheme MyApp --destination "platform=iOS Simulator,id=…"
```

Names are resolved to a simulator **udid** before the run, because two runtimes
routinely publish the same device name and a name-based specifier silently
picks whichever xcodebuild sees first. The reported destination is the one the
run actually landed on, read back out of the result bundle.

### Reading a run again

`build` and `test` both print the bundle they wrote, so nothing needs re-running
to be re-read:

```sh
xcodebuild-axi result ~/Library/Caches/xcodebuild-axi/MyApps-1a2b3c4d/MyApp-test.xcresult --failures --full
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
npx skills add alexrrouse/xcodebuild-axi --skill xcodebuild-axi
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

## Development

```sh
npm install
npm run dev -- destinations --scheme MyApp   # run from source
npm test
```

Everything CI checks, in order:

```sh
npm run format:check && npm run lint && npx tsc --noEmit && npm test
npm run build && npm run build:skill -- --check && npm run coverage:check
```

Three committed files are generated and fail CI when stale: the skill
(`npm run build:skill`, from the CLI's own help text), the coverage table
(`npm run coverage`, from `src/surface.ts`), and the benchmark table
(`npm run benchmark -- --write`). Regenerate rather than editing them.

Adding a flag means three edits — the command, `src/surface.ts`, and
`npm run coverage` — and the `flags[N]:` count in a help block is asserted by
`test/help.test.ts`, so a forgotten count fails the suite.

Examples in help text, tests, and this README use a fictional project
vocabulary (`MyApp`, `MyApps`, `MyApps-1a2b3c4d`); see `AGENTS.md`.

## Built on

[AXI](https://axi.md/) — the design standard for agent-facing CLIs — via
[`axi-sdk-js`](https://www.npmjs.com/package/axi-sdk-js).

## License

MIT
