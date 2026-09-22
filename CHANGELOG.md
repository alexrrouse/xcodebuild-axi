# Changelog

Notable changes to `xcodebuild-axi`. Versions follow
[semver](https://semver.org/); the format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- **A half-finished `-showdestinations` is no longer reported as a scheme with
  no simulators.** Enumerating simulators and devices is a separate step from
  listing a scheme's platforms, and it intermittently does not happen — most
  reproducibly while another xcodebuild is finishing on the same machine. The
  output then ends after the `My Mac` / `Any Mac` block with nothing saying
  anything went wrong, and `--device "iPhone 17 Pro"` failed with
  `Scheme 'X' has no destination named 'iPhone 17 Pro'` and
  `available: My Mac, Any DriverKit Host, Any Mac` — for a scheme that lists it,
  as the same command run a second later shows. That is the worst shape a wrong
  answer can take, because the caller stops looking. An answer naming no
  simulator and no physical device, or one from a probe that exited non-zero, is
  now treated as unfinished and the probe is retried once. Seen in the wild as a
  red PR gate on two of seven Swift packages, a different two each run.

- **A destination that is listed but ineligible says so.** xcodebuild puts a
  simulator whose runtime is missing, or a device that is not connected, under
  its own heading; matching only the eligible rows turned that into
  "has no destination named …", which sends the reader to check the spelling of
  a name that was right.

- **`destinations` no longer prints rows an agent cannot tell apart.**
  xcodebuild lists macOS once per arch and once per variant, so one Mac came
  back as four byte-identical `My Mac,macOS,""` rows — the arch and the
  variant that distinguish them were never parsed, and `--device` takes a
  name, so they were four ways of typing the same thing. They collapse to one
  row, and the variants are named in `help[]` with the `--destination`
  spelling that actually reaches them, which costs nothing on a scheme that
  has none. A 23-row list for a plain Swift package came down to 17.

- **Generic destinations no longer leak out of a Swift package.** Placeholders
  were filtered by an id ending in `placeholder`, which is how a _project_
  spells them; a package omits `id` entirely, so "Any Mac" and "Any DriverKit
  Host" were listed as if they were runnable and were eligible for
  `pickDefault` to choose. An absent id now counts as a placeholder too.

- **`export` no longer leaves a temp directory behind on every run.** The
  options plist it generates for you was written to a fresh `mkdtemp`
  directory that nothing ever removed. It now lands beside the log and the
  result bundle as `<archive>-ExportOptions.plist`, which is also where you
  would look for it when a signing choice comes out wrong.

### Notes

- `build`, `analyze` and `archive` report the destination they resolved rather
  than re-reading it from the result bundle the way `test` does. `AGENTS.md`
  claimed the readback was universal; the udid already pins which device ran,
  so the only real difference is that the platform is not named.

- `tsconfig.json` turns on `noUnusedLocals`, `noUnusedParameters` and
  `exactOptionalPropertyTypes`. The three things they found are fixed. Note
  that `test/` is still outside the typechecked set.

## [0.1.14] - 2026-09-22

### Added

- **`sim apps <device> <bundle-id>` reports one app in full**, which is
  `simctl appinfo`. The list stops at the bundle; this adds the data container
  a test writes into, the App Groups it shares, and whether the app is
  first-party, hidden, removable or an app clip. Same subcommand rather than a
  new one, because the list is where you are when you want it.

  Paths come back out of `appinfo` as `file://` URLs with percent-escapes —
  `iOS%2026.5.simruntime` — and are decoded to something a shell will take.
  The four flags print as `0` and `1` and survive `plutil` as the _strings_
  `"0"` and `"1"`, so all three spellings are read.

- **`sim pasteboard <device> [text]` reads and writes the pasteboard.** With
  text it copies, without it pastes. Two simctl subcommands (`pbcopy`,
  `pbpaste`) become one, because they are the same question asked in two
  directions and the separate names only make sense standing in a shell that
  already has both. `pbcopy` takes its input on stdin and nowhere else, so
  `simctl()` grew an optional stdin.

### Notes

- **`simctl install_app_data` does not work on Xcode 27** and stays declined.
  It was going to be wrapped in this release. Every package shape was tried —
  with and without `AppDataInfo.plist`, with `bundleID` / `CFBundleIdentifier`
  / `BundleID` as its key, with and without the container's own
  `.com.apple.mobile_container_manager.metadata.plist`, against a first-party
  and a user app, on a booted device and a freshly created one, from `/tmp`
  and from a home directory — and all of them fail the same way:
  `com.apple.containermanager` code 55, "Could not get the existing data
  container location for the app". The one shape that behaves differently is a
  wrong bundle id, which says so. Wrapping a subcommand that cannot succeed
  would be a command that only ever reports someone else's bug.

## [0.1.13] - 2026-09-21

### Added

- **`sim` seeds the fixtures a test needs and says where the app's files
  went.** `location`, `media` and `container`.

  `sim location "iPhone 17 Pro" 37.7749,-122.4194` puts the device somewhere;
  two or more pairs move it between them (`--speed` sets how fast), a name
  runs one of simctl's own scenarios, and no argument lists them — simctl
  offers no way to read the current location back, so the list is the only
  useful thing a bare call can say. A scenario name is matched
  case-insensitively against that list, because simctl's own answer to a near
  miss is "Could not find scenario".

  `sim media "iPhone 17 Pro" receipt.png` adds photos, live photos, videos and
  vCard contacts to the library. A file that is not there is refused before
  simctl is called; a file it refuses comes back as
  `receipt.heic — File type unsupported` rather than as the two-paragraph
  "Multiple errors were returned; see stderr" simctl prints.

  `sim container "iPhone 17 Pro"` answers where the app's files are with both
  paths at once — the installed bundle and the data directory a test writes
  into — because asking for one and then needing the other is two calls.
  `groups` lists the App Group containers, and any `group.` identifier works
  as well.

- **`build --install-src` copies a project's sources out.** The last
  xcodebuild action left, which takes the headline number to **100% of the 161
  leaves `xcodebuild -help` documents**.

  It was declined for a while because it writes outside
  `~/Library/Caches/xcodebuild-axi`, which nothing else here does. So it
  doesn't: the copy lands in this project's cache directory, and `--src-root`
  puts it somewhere else only with `--yes`, the way `migrate --format` works.
  A destination that already exists is refused rather than emptied — deleting
  a directory the caller named is not this tool's call.

  Three things about `installsrc` that its own help does not say, all verified
  against a real project: it **cannot run against a workspace** (it rejects
  `-scheme`, and a workspace refuses to act without one — so the `.xcodeproj`
  beside the workspace is used), it **refuses a destination that exists**, and
  it **copies the whole project directory**, DerivedData included. A 271 MB
  checkout came out as 258 MB across 5,104 files. The report says so, because
  "installsrc" reads like a source export and is a packaging step.

## [0.1.12] - 2026-09-21

### Added

- **`sim` sets up the state a UI test needs.** `privacy`, `push`,
  `status-bar` and `ui` — the last four simctl subcommands worth wrapping.

  `sim privacy "iPhone 17 Pro" grant photos` answers a permission prompt
  before it appears, which is the difference between a UI test that runs
  unattended and one that waits for a tap. The bundle id is optional here too,
  and `reset` is the one action that takes no app at all.

  `sim push "iPhone 17 Pro" --message "Your order shipped"` writes the `aps`
  dictionary simctl demands and sends it, rather than making the caller keep a
  JSON file around for one line of text. A payload path still works, in either
  order with the bundle id. simctl delivers a push addressed to an app that is
  not installed and exits 0 — indistinguishable from a notification the app
  ignored — so the app is checked first and the silence becomes a sentence.

  `sim status-bar "iPhone 17 Pro" pin` freezes the clock at 9:41 with full
  signal and a full battery, so two screenshots differ only where the app
  does; `--time`, `--battery` and `--bars` override one piece at a time, and
  `clear` hands the status bar back. Read back, simctl reports its overrides
  as enum ordinals (`Battery State: 2`) and prints the words only inside its
  own `--help`; every value was checked against what it accepts, so the
  report reads in the same vocabulary the flags are written in.

  `sim ui "iPhone 17 Pro"` reports appearance, contrast and content size
  together, and `sim ui "iPhone 17 Pro" dark` is shorthand for setting the
  one of the three anyone asks for.

  That closes the coverage map: every leaf of xcodebuild, `xcresulttool`,
  `xccov` and `simctl` is now either reached by a command or declined on the
  record, with nothing left marked missing.

- **`sim` can run the app a build just produced.** Five simctl subcommands:
  `sim apps`, `install`, `launch`, `terminate` and `uninstall`.

  The app is optional in all four mutations. Without one, it is worked out
  from the project in the current directory — `-showBuildSettings` against the
  simulator's own destination answers both the `.app` path and the bundle id,
  and answers them for the right platform, which a hand-typed DerivedData path
  routinely does not. That resolution is most of the point: `build`, then
  `sim install "iPhone 17 Pro"`, then `sim launch "iPhone 17 Pro"`, with
  nothing pasted between the steps.

  The mutations are idempotent where simctl's are not: terminating an app that
  is not running and uninstalling one that is not installed are the state
  being asked for, so both are a no-op at exit 0. `sim apps` filters out the
  four dozen apps Apple ships — a typical device answers with 46 apps of which
  two are the developer's — and `--system` puts them back.

  `simctl listapps` prints an old-style NeXTSTEP plist rather than JSON, and
  offers no `-j`; it goes through `plutil` to become readable.

- **`sim` makes devices, unmakes them, and shows what one looks like.**
  `create`, `delete`, `screenshot`, `video` and `open`.

  `sim create "Test iPhone" "iPhone 17 Pro"` takes the model by the name
  `sim list` prints rather than by the
  `com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro` identifier simctl
  documents, and an unknown model comes back with the models that nearly
  match. `--runtime` picks the OS.

  `sim delete <name>` removes one and `--unavailable` removes every device
  whose runtime is gone, which is the safe form of reclaiming disk. Deleting
  _everything_ needs `--yes` on top of `--all`: a simulator is gigabytes of
  state and recreating it is not the same device, so it gets the same guard
  `migrate --format` has.

  `sim screenshot` and `sim video` write to `~/Library/Caches` and report the
  path and size. `simctl io recordVideo` records until it is sent SIGINT,
  which is a contract for a person at a terminal — an agent cannot press
  Control-C inside its own subprocess — so `--seconds` sets the length and the
  interrupt is this tool's job. The clock starts when simctl says
  `Recording started` rather than at spawn, so a slow start does not eat the
  recording.

  `sim open <url>` is how a deep link gets tested.

## [0.1.11] - 2026-09-21

### Added

- **`result --export <what>` gets files out of a bundle**: `attachments`,
  `diagnostics`, `metrics`, or `evaluations`. A UI test's screenshots, the
  diagnostics report `test --diagnostics` collects, and the CSVs behind a
  performance measurement were all in the bundle and reachable only by shelling
  out to `xcresulttool`.

  It writes under `~/Library/Caches/xcodebuild-axi/exports/` by default, or
  wherever `--to` says — never into the working tree, so asking what is in a CI
  artifact cannot dirty the checkout it sits in. `--test`, `--filter '*.png'`
  and `--failures` narrow what comes out, and each is **refused** where it does
  not apply rather than ignored: a diagnostics report covers the whole run, so
  `--test` beside it would answer a different question than the one asked.

  The report is what landed and where, with each exported file tied back to the
  test that produced it — a screenshot's filename is a UUID, and the manifest
  is the only thing that makes it findable. `xcresulttool` narrates an
  attachment export with one "Skipped export for <test>: no matching
  attachments" per test, which is dropped.

- **`result --against <baseline.xcresult>`** answers the question CI actually
  asks — not "did this run fail" but "did it fail in a way the last one did
  not". It reports the counts on both sides and their direction
  (`failures: 0 → 1 (+1 -0)`), then the tests that newly fail, the ones that
  now pass, the ones added and removed, and any new warning. A failure the
  baseline did not have is listed first, because it is the only part of a
  comparison that stops a merge.

  Two bundles with nothing in common — a build against a test run — get an
  explicit answer saying so. `xcresulttool` prints a bare `null` there, which
  is otherwise indistinguishable from a clean comparison.

- **`result <a> <b> [...] --merge`** combines the bundles of a sharded test run
  into one, which is the only way that run gets a single verdict. The merged
  bundle is read back and reported from, rather than described from its
  inputs. It lands under `~/Library/Caches` unless `--to` says otherwise, and a
  `--to` that already exists is refused rather than written over — the bundle
  under our own cache directory is ours to clear, one the caller named is not.

  With these two, **`xcresulttool` coverage is 81% of its leaves** and every
  remaining one is deprecated by Xcode or superseded here.

- **`coverage` sees everything `xccov` sees.** Five leaves, and the command's
  path argument now also takes an `.xccovreport` or an `.xccovarchive`:

  - `--functions <file>` is per-function coverage, which is where an uncovered
    branch finally gets a name. A file at 60% says a test is missing; it does
    not say which one.
  - `--lines <file>` is how many times each line ran, read out of the archive
    rather than the report. Consecutive lines that never ran collapse into one
    range — a 400-line file was 400 rows to find the eight that matter.
  - `--against <path>` answers "did coverage drop" from two bundles this tool
    wrote, reporting which way it moved overall and then per file, worst
    first.
  - `--merge` combines the coverage of a sharded run. `xccov merge` takes
    report/archive **pairs** rather than result bundles, so each bundle is
    unpacked with `xcresulttool export coverage` first — that two-step is the
    reason merging coverage across shards is something people give up on.

  With them, **`xccov` coverage is 100%** and companion coverage overall is
  43.7%.

### Fixed

- `xccov`'s refusals are no longer wrapped in NSError. A bad path came back as
  `Error: Error Domain=XCCovErrorDomain Code=0 "Failed to load result bundle"
UserInfo={NSLocalizedDescription=Failed to load result bundle,
NSUnderlyingError=0x… {…}}` — 400 characters around a five-word answer that
  was already in there.

## [0.1.10] - 2026-09-21

### Added

- **`result` reads the rest of what is in an `.xcresult`.** Seven modes, each
  its own question, none of which had an answer short of shelling out to
  `xcresulttool` and parsing JSON:

  - `--tests` lists every test the run recorded, failures first, with the
    identifier `--only` and `--activities --test` take.
  - `--activities --test <id>` prints the step-by-step trail of one test,
    indented by depth — what a UI test actually did before it failed.
  - `--insights` reports Xcode's own diagnosis of the run.
  - `--metrics` reports the performance measurements an `XCTMetric` test took,
    which `test --perf-diagnostics` collects and nothing could read back.
  - `--log [build|action|console]` reports the stored log as the timed tree it
    is: the slowest sections of a build, ranked, without rebuilding it.
  - `--available` says what the bundle holds — test results, coverage,
    diagnostics, which logs — so a read that would fail can be skipped rather
    than attempted.
  - `--metadata` reports the bundle's own format version, storage backend and
    compression.

  That takes `xcresulttool` coverage from 19% to 52.4% of its leaves, and the
  companion tools as a whole from 18.3% to 28.2%.

- **The export options plist is fully covered.** `export` gained a flag for
  each of the twelve keys that had none, so nothing about a distribution
  requires authoring XML any more:

  `--profile <id>=<name>`, `--certificate`, `--installer-certificate`,
  `--distribution-bundle-id`, `--keep-swift-symbols`, `--internal-only`,
  `--app-store-info`, `--icloud-env`, `--thinning`, `--manifest <key>=<url>`,
  `--odr-base-url`, `--no-embed-odr`.

  The ones that change whether a release works at all: `--profile` and
  `--certificate` are manual signing, which until now could be _asked for_
  with `--signing-style manual` and not completed — so the flag existed and
  the export it produced could not be signed as intended. `--internal-only`
  marks a TestFlight build as not for external distribution, which is what a
  PR build wants. `--manifest` is over-the-web distribution, and it is refused
  unless all three of its URLs are present, because a partial manifest exports
  without an error and produces a link that cannot install.

  Two spellings are handled rather than passed on: Xcode writes its named
  thinning options with angle brackets (`<none>`), and the Xcode 26 method
  names (`app-store`, `ad-hoc`, `development`) still work and are reported as
  the current name they mean.

- `info --sdk <name>` reports one SDK in full — path, platform path, platform,
  and both versions. That was `xcodebuild -version -sdk <name> <infoitem>`,
  which answers one field per invocation and only if you already know the
  field names. A build script that needs the SDK path, or an agent asked which
  build of the SDK it compiled against, had to shell out for it.

  With it, **every leaf of xcodebuild's own surface that this tool wraps is
  covered**: 160 of 161, and the one left is `installsrc`, which is declined
  on purpose and says so.

### Changed

- The flags that shape the generated options plist are now **refused**
  alongside `--options` rather than silently ignored. `--upload` already was;
  `--team`, `--signing-style` and the ten new ones were not, so a release could
  pass `--team` beside a hand-written plist and get a build signed by whatever
  the plist said.

### Fixed

- `xcresulttool`'s own explanation of a failed read is now the error message.
  It writes `Error: …` on stderr and exits non-zero; the reason was thrown away
  and replaced with a guess ("the bundle may be from an incompatible Xcode
  version"), so `--log console` on a bundle with no console log was reported as
  a version problem rather than as the absent log it is. The guess is only
  offered now when `xcresulttool` gave no reason of its own.

## [0.1.9] - 2026-09-21

### Added

- **Reach is 100%.** Every option xcodebuild accepts on a command is now
  reachable from that command, all 328 pairs, where the last release reached
  95.7%.

  - `clean` takes the same subject and scoping flags a build does: `--target`,
    `--all-targets`, `--destination`, `--device`, `--destination-timeout`,
    `--sdk`, `--arch`, `--toolchain`, `--xcconfig`, `--artifacts-dir` and
    `--log-level`, on top of the three it had. A clean is scoped by the same
    things a build is, and a `clean` that cannot say _which_ products to remove
    is a command an agent has to leave for the raw tool.
  - `tests --only` and `--skip` constrain the enumeration itself, so the answer
    is the list `test` would run with the same flags rather than a list this
    tool filtered afterwards. `--filter` still does the latter, and the help now
    says which is which.
  - `packages --resolve --derived-data <path>` puts the resolved checkouts
    where CI can cache them. xcodebuild takes `-derivedDataPath` here only
    alongside a scheme, so one is resolved up front rather than letting the
    refusal reach the caller.

- `settings` reaches the rest of what `-showBuildSettings` accepts:
  `--target`, `--all-targets`, `--arch`, `--toolchain`, `--xcconfig`,
  `--derived-data`, `--destination-timeout`, and `--setting KEY=VALUE`.

  Seven of those were the last reach gaps on a read-only command, and each one
  changes the answer rather than decorating it. `--target` and `--all-targets`
  ask a project that has no scheme for the target; `--setting` and `--xcconfig`
  answer "what would this be if I overrode that", which is the question
  `-showBuildSettings` exists for; `--derived-data` matters because every build
  path hangs off it, so the default answer describes a directory CI does not
  use.

- A failing test now reports **where** it failed. The failures table gained
  `file` and `line` columns, in `test` and in `result` alike.

  A test-results summary carries a name, a target and a message, and no source
  location at all — so until now a failing assertion came back as text an agent
  had to go and search the repository for. The location lives one drill-down
  away, in `xcresulttool get test-results test-details`, which is read once per
  failure actually being printed.

  These line numbers are one-based, unlike the zero-based ones in a build
  diagnostic's `sourceURL`; both are now documented where the code applies
  them, because an off-by-one here points at the line after the failure.

### Fixed

- Reports on a target-mode run said `scheme: all targets`, which names
  something that does not exist. Every command in the build family now reports
  `targets:` when targets were what was asked for, and the run's log and
  `.xcresult` are named `all-targets-…` rather than with a space in the path.

- A failure xcodebuild refused outright reported `xcodebuild encountered an
error (70)` and nothing else. That string is what the result bundle records
  when nothing was built, and the transcript fallback only ran when the bundle
  listed _no_ errors — so a bundle with one useless error row suppressed the
  one explanation available. A bundle carrying only that row is now treated as
  the empty answer it is.

- A Swift package asked to build with no destination now says so in its own
  terms. xcodebuild's refusal points at `-showdestinations`, which is not
  something this tool asks anyone to run.

- `settings` no longer reports a **refusal** as an answer. xcodebuild rejects
  some combinations — `-derivedDataPath` without a scheme is one — by exiting
  non-zero and printing an empty JSON document, which parsed cleanly and came
  back as every key `unset`. That reads exactly like a correct answer about a
  target that has no such setting. The exit code is now checked and
  xcodebuild's own one-line reason is reported.

- A scheme that resolves no targets at all says so, instead of reporting every
  key as `unset`. A Swift package's scheme is the common case: it answers
  `-showBuildSettings` with an empty list and exit 0, so `--key SWIFT_VERSION`
  came back as "not set" for a package where it plainly is.

- A rerun hint after `--all-targets` said `--target all targets`, which is not
  a command that runs. The selection now carries its own spelling rather than
  having one guessed from its label.

## [0.1.8] - 2026-09-21

### Added

- `xcframework` takes `--archive`, `--debug-symbols` and
  `--allow-internal-distribution`, which is the other half of
  `-create-xcframework`. The workflow it was missing is the usual one: archive
  once per platform, then bundle the slices by name out of those archives.
  Without `--archive` the only way in was a path to a built product, which is
  not what an archive-based build has.

  `--debug-symbols` matters more than it looks. Every `.xcframework` this tool
  produced until now shipped without dSYMs, so nothing built from one could be
  symbolicated — a crash report from a binary distributed this way was
  addresses and nothing else.

- `--headers` and `--debug-symbols` now attach to the `--framework` or
  `--library` they follow, the way xcodebuild reads them positionally. They
  used to be paired by index, so headers given after the second library were
  applied to the first.

- Coverage is now measured along four axes instead of one, and `src/surface.ts`
  declares all four. The old number asked "does any command reach this
  option?", answered 100%, and hid every gap that has been found since — so it
  now also asks which commands reach it, what the options _behind_ an option
  are, and how much of the companion tools is wrapped.

  - **Reach** counts one pair per command an option applies to. An option
    declares the surface it belongs to, and every command in that surface must
    be recorded as reached, declined with a reason, or missing; silence fails
    the test suite. 93.6% of 328 pairs today, with 21 open.
  - **Leaves** counts switches rather than options: the 18 keys of
    `-exportOptionsPlist`, the 8 arguments of `-create-xcframework`, and the
    second forms that `-help` mentions only inside a usage line, all of which
    used to ride free on the one option that names them. 89.4% of 160.
  - **Companion tools** — `xcresulttool`, `xccov`, `simctl` — are classified
    for the first time, separately from xcodebuild's own number. 16.9% of 71.

  The claims are checked against the commands themselves rather than trusted:
  every command exports its flag list, `COMMAND_FLAGS` collects them, and
  `test/surface.test.ts` fails if the map says `settings --target` while
  `settings` would reject it.

- The README's coverage section grew a **Still open** table — every known gap,
  what it costs, and the command it will land on. It is generated, so it
  shrinks as the gaps close rather than going stale.

## [0.1.7] - 2026-09-21

### Fixed

- `export --artifacts-dir <path>` — the flag `build`, `archive` and `test`
  gained in 0.1.5, on the one command a release pipeline cannot do without.
  Its log went to the tool's cache regardless, so a failed upload left its
  transcript exactly where CI's artifact step does not look. The command that
  talks to App Store Connect was the worst one to leave behind.

## [0.1.6] - 2026-09-21

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

[unreleased]: https://github.com/alexrrouse/xcodebuild-axi/compare/v0.1.14...HEAD
[0.1.14]: https://github.com/alexrrouse/xcodebuild-axi/compare/v0.1.13...v0.1.14
[0.1.13]: https://github.com/alexrrouse/xcodebuild-axi/compare/v0.1.12...v0.1.13
[0.1.12]: https://github.com/alexrrouse/xcodebuild-axi/compare/v0.1.11...v0.1.12
[0.1.11]: https://github.com/alexrrouse/xcodebuild-axi/compare/v0.1.10...v0.1.11
[0.1.10]: https://github.com/alexrrouse/xcodebuild-axi/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/alexrrouse/xcodebuild-axi/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/alexrrouse/xcodebuild-axi/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/alexrrouse/xcodebuild-axi/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/alexrrouse/xcodebuild-axi/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/alexrrouse/xcodebuild-axi/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/alexrrouse/xcodebuild-axi/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/alexrrouse/xcodebuild-axi/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/alexrrouse/xcodebuild-axi/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/alexrrouse/xcodebuild-axi/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/alexrrouse/xcodebuild-axi/releases/tag/v0.1.0
