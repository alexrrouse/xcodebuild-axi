# Project agent memory

Durable, project-intrinsic notes for this repository: the xcodebuild behaviors
this tool exists to paper over, and the decisions that are not obvious from the
code. Add to it as real work turns up new sharp edges.

## What this tool is

An [AXI](https://axi.md/) — an agent-facing CLI built to the ten principles in
`kunchenguid/axi`'s `SKILL.md`. Output is TOON on stdout, errors are data, and
the no-argument view shows live state rather than help text. When changing
output shape, re-read those principles first; several non-obvious choices here
(capped lists with explicit totals, `help[]` on lists and mutations but not on
detail views, exit code 2 reserved for usage errors) come straight from them.

Built on `axi-sdk-js`, which owns top-level dispatch, `--help`/`--version`,
TOON serialization, EPIPE handling, the `update` built-in, and hook
installation for Claude Code, Codex, and OpenCode. `src/cli.ts` registers no
`update` command of its own and gets one for free. The SDK also injects the
`bin:` and `description:` header into the home view at runtime, so
`commands/home.ts` must not print them itself.

## Working on this repo

```sh
npm run format:check && npm run lint && npx tsc --noEmit && npm test
npm run build && npm run build:skill -- --check && npm run coverage:check
```

That is what CI runs, in that order. `npm run dev -- <args>` runs the CLI from
source without building.

**Three files are generated and must never be hand-edited**, because CI
compares them against a fresh render and fails on a mismatch:

- `skills/xcodebuild-axi/SKILL.md` — from `DESCRIPTION` and `TOP_HELP` in
  `src/cli.ts`, via `npm run build:skill`.
- The `<!-- coverage:* -->` sections of `README.md` — from `src/surface.ts`,
  via `npm run coverage`.
- The `<!-- benchmark:* -->` section of `README.md` — from a real run, via
  `npm run benchmark -- ... --write`.

Editing a command's help text therefore means regenerating the skill in the
same commit.

## Releasing

Tag-triggered, because the commit history here is prose rather than
conventional commits and the version is a judgment call rather than something
to derive. To cut a release:

```sh
npm version patch|minor|major   # writes package.json and the tag together
git push --follow-tags
```

`.github/workflows/release.yml` then re-runs every CI check, refuses a tag that
disagrees with `package.json`, packs the tarball and runs the binary out of it,
publishes to npm with provenance, and opens the GitHub release. Update the
`## [Unreleased]` section of `CHANGELOG.md` before tagging — nothing generates
it.

Publishing uses **npm trusted publishing**, not a token. There is no
`NPM_TOKEN` secret and there should not be one: the alternative was a granular
token with "bypass 2FA" ticked, which npm's own UI warns against for CI. npm
authenticates the workflow over OIDC instead, which is why `id-token: write` is
declared — that permission is the whole credential.

Two things that are easy to get wrong here:

- **It needs npm >= 11.5.1**, and the macos-15 image's Node 22 ships 10.9.8.
  An older npm does not recognize the OIDC environment, falls back to looking
  for a registry token, and fails. The workflow upgrades npm before `npm ci`.
- **Provenance is automatic** under trusted publishing. Passing `--provenance`
  is unnecessary; npm generates the attestation either way.

The trusted publisher is configured on npmjs.com against the organization
`alexrrouse`, the repository `xcodebuild-axi`, and the workflow filename
`release.yml`. **Renaming `release.yml` breaks publishing** until that field is
updated to match.

0.1.0 predates this and was published by hand, so it carries no provenance
attestation — a granular token cannot be scoped to a package that does not
exist yet, which is the bootstrap problem trusted publishing cannot solve
either.

`src/version.ts` reads the version out of `package.json` at runtime instead of
hardcoding it, so `--version` cannot drift from the published version. That
lookup walks up from the module's own directory, which differs between `tsx`
and the installed layout — the release workflow installs the tarball and checks
`--version` against the tag for exactly that reason.

## Examples never name a real project

This repository is public; the projects it was built against are not. Every
scheme, workspace, target, and path in help text, tests, and the README uses a
fixed fictional vocabulary — `MyApp` for a scheme, `MyApps` for a workspace,
`MyAppTests/CheckoutTests` for a test identifier, `MyApps-1a2b3c4d` for a cache
directory. Reach for those rather than inventing a new name per file, and never
paste a real one in while debugging against a real workspace.

Measured numbers are the exception and are kept exactly as observed — a byte
count or a token ratio identifies nothing. Describe their source by shape ("a
12-scheme workspace with 16 local packages"), not by name. `scripts/benchmark.ts`
takes `--project` and `--scheme` at runtime and deliberately keeps both out of
the README section it writes, so pointing it at a real app cannot leak one.

## The result bundle is the source of truth, not the transcript

Every build and test runs with `-resultBundlePath` and reports from the bundle
via `xcresulttool`, never by grepping the log. The transcript is streamed
straight to a file and never read into memory — a single passing test run
measured 549 KB, and a full verify run of the same repo 2.5 MB. The one
exception is a diagnostic inside a macro expansion, below: the bundle still
decides which diagnostics there are, and the log is streamed a line at a time
only to say where one of them was written.

`src/xcresult.ts` owns every read. Things there that are easy to get wrong:

- **`sourceURL` line and column numbers are zero-based.** A diagnostic at
  `StartingLineNumber=165` is on line 166 as any editor counts it. Verified
  against a real build. Sending an agent to the wrong line is worse than
  sending it nowhere, so the `+1` lives in `parseSourceURL` and nowhere else.
- **`TestFailure` carries no `sourceURL`** — only `testName`, `targetName`,
  `failureText`, and `testIdentifierString`. Per-failure source locations come
  from `xcresulttool get test-results test-details --test-id <identifier>`,
  one read per failing test, so `failureRows()` looks up only the failures it
  is about to print.
- **`test-details` line numbers are one-based**, which is the opposite of the
  `sourceURL` fragment above. Verified against a real failing assertion: an
  `XCTAssertEqual` written on line 10 comes back as `lineNumber: 10`. Adding
  the `+1` that `parseSourceURL` needs would land the agent one line past every
  test failure, so `failureLocation()` deliberately applies no offset.
  Within a test's node tree the deepest `sourceLocation` wins — a
  "Source Code Reference" child points at the assertion, its parent at the test
  case that ran it.
- **A diagnostic inside a macro expansion is recorded against the expansion.**
  Every compile error in an `#expect` or `#require` has this shape: the
  bundle's `sourceURL` is a temporary
  `swift-generated-sources/@__swiftmacro_…swift` file, usually gone by the
  time anyone reads it, at a position inside it — and the bundle has nothing
  else, in either schema. `src/macro.ts` puts it back where it was written:
  - **The mangled name gives the file name and the macro's start.**
    `@__swiftmacro_10MyAppTests0024CheckoutTestsswift_ynAHffMX6_4_…` is the
    module, then the file name in Swift's punycode (the `00` marks it; `.`
    and `+` cannot appear in a symbol, so every file name is encoded), then
    `MX6_4_` — `N_` meaning N + 1, so line 7, column 5, the `#` of `#expect`.
    Decode the punycode properly: `Cart+Checkout.swift` comes out as
    `CartCheckoutswift_mjFCfEb`, which no "put the dot back" shortcut restores.
  - **The transcript gives the directory.** The error is followed by
    `` `- <path>:L:C: note: expanded code originates here`` — but that
    location is the macro's _end_, one column past its closing parenthesis and
    on its last line, so only the path is taken from it. Its message is
    lowercased and may end in a ` [#Group]` the bundle's does not carry.
  - **Two identical mistakes in one file** are two transcript entries with the
    same message at the same position in their expansions; the one at or
    nearest below the macro's line is its own.
  - **Without a log** — `result` on a bundle moved away from its `.log` — the
    row says the bare file name at the right line. That is a new shape for the
    `file` column, and still better than the temporary path. An attached
    macro's name (`…fMp_`) carries no position, so it takes the transcript's
    origin or stays as it was.
  - **Dedupe runs after relocation.** One file compiled into two targets
    expands into two differently named files, and is one mistake.

## xcodebuild failures that produce no usable bundle

When xcodebuild dies _before_ it builds anything — an unknown scheme, an
unmatched destination, a missing signing team — the result bundle it writes
records only `"xcodebuild encountered an error (65)"` with
`status: notRequested`. The transcript is the only witness.

Both `build` and `test` therefore fall back to `mapXcodebuildError()` on the
transcript tail whenever the bundle reports a failure with zero errors. Do not
remove that fallback believing the bundle is always sufficient; it is not.

The bundle's `status` is not trustworthy the other way round either. On Xcode
27 a destination that matched nothing leaves a bundle that says `succeeded`
beside `errorCount: 1` and the error that failed the build. `buildStatus` in
`src/xcresult.ts` lets errors outrank the status, and every reader of a build
verdict — `result`, the home view — goes through it.

A test run whose build failed also records an Uncategorized "Testing
cancelled because the build failed." row, _before_ the error that failed it.
It restates the verdict, so `meaningfulErrors` drops it — and the generic
exit-code row — whenever a real cause is there, and keeps them when nothing
else is. A bundle holding only restatements (`isRestatement`) counts as
unexplained: the transcript is mapped and its tail shown, the home view
points at the log, and `testsNeverRan` still reads it as a build that
failed. The cause can be one no compiler reported: a build database locked
by another build on the same DerivedData, or a source file renamed without
regenerating the project, both of which only surfaced in the transcript's
`Testing failed:` block before 0.3.0.

## Sharp edges in xcodebuild itself

- **It refuses to overwrite a result bundle.** A second run against the same
  path dies with `error: Existing file at -resultBundlePath` before running
  anything. `runBuild` used to clear the bundle first, which is how one run
  deleted another's (see "Where artifacts go"); now every run claims a path
  nobody has used, so there is nothing to clear.
- **The preamble is unconditional.** Every invocation, including read-only
  ones, reprints the command line, `Resolve Package Graph`, and the full
  resolved package list. In a workspace with 16 local packages that is ~1.2 KB
  in front of a 349-byte answer. `stripPreamble()` removes it; `-list -json`
  avoids it entirely, which is why `src/scheme.ts` uses the JSON form.
- **A Swift package has no container to pass.** xcodebuild synthesizes an
  implicit workspace from `Package.swift` in the _working directory_, so the
  runner must never `cd` away from the caller's directory.
- **`-skipMacroValidation` is not optional unattended.** Macro validation is an
  interactive trust prompt in disguise and fails the build outright without it.
- **`-enumerate-tests` needs the `test` action.** With only
  `build-for-testing` it writes no enumeration file and exits zero, so
  `src/commands/tests.ts` passes `test` and stops before running anything.
- **`-resolvePackageDependencies` needs a scheme against a workspace.** It
  fails with "If you specify a workspace then you must also specify a scheme"
  only after loading the whole workspace, so `packages --resolve` resolves one
  up front.
- **`-showBuildSettings` answers an impossible question with `[]`, not an
  error.** A Swift package's scheme resolves no targets through xcodebuild at
  all, and a project scheme with nothing buildable for the resolved platform
  does the same — exit 0, empty JSON array. Reading keys out of that reports
  every one of them as unset, which is the same answer as a key that really is
  unset, so `settings` tells the two apart before it looks for keys.
- **A rejected flag combination also prints an empty JSON document.**
  `-derivedDataPath` without `-scheme`, `-testProductsPath` or `-xctestrun` is
  the one that turned up: it exits non-zero, complains on stderr, and still
  emits parseable stdout. Any command reading `runMetadata` output has to check
  `exitCode` first; the payload alone cannot distinguish a refusal from a
  result.
- **`-showBuildSettingsForIndex` is a different query, not a variant.** It
  returns `{target: {sourceFile: {indexSettings}}}` — the compiler invocation
  per source file, including the entire Swift driver command line. Measured
  216 KB on a 12-scheme workspace, so `settings --for-index` reports the shape
  and requires `--file` to print one file's settings.
- **`-find-library` searches the toolchain's `usr/lib`, not the SDK.** Passing
  `libz.tbd -sdk iphoneos` fails; passing `libLTO.dylib` works.
- **Platform and component operations need `sudo` for some components.** They
  also download gigabytes, so `platforms` streams them to a log like a build
  rather than buffering.
- **`-resultStreamPath` refuses a file that does not already exist.** An odd
  contract to hand to a caller, so `--stream` creates the file first.
- **`-license check` is the non-interactive half of `-license`.** Bare
  `-license` pages the agreement and then asks for sudo; `check` exits 0 when
  the license is accepted and prints nothing. `platforms license` uses `check`
  and never attempts the accept — that needs a terminal this tool does not have.
- **`-convert-project` validates the format before touching the project**, and
  the only place it prints the valid formats is inside that rejection. So
  `migrate` asks for an impossible format to read the list, which is safe.
- **`installsrc` is the one action a workspace cannot run.** It rejects
  `-scheme` outright ("Cannot use the installsrc action with -scheme") and a
  workspace refuses to act without one, so the only form that works is
  `-project`. It also refuses a destination that already exists, and copies
  the _whole_ project directory rather than its sources — a 271 MB checkout
  came out as 258 MB across 5,104 files, most of it DerivedData. It is a
  packaging step wearing a source export's name, and `build --install-src`
  says so in its report.
- **Generic destinations are spelled differently per container.** A project
  lists "Any Mac" with an id ending in `placeholder`; a Swift package lists it
  with no `id` field at all. So an `id.includes("placeholder")` filter passes
  every package's placeholders straight through — into the `destinations`
  list, and into `pickDefault`'s pool. `isPlaceholder` treats an absent id as
  the same thing.
- **macOS is listed once per arch and once per variant.** Four rows come back
  for one Mac — plain, `variant:Mac Catalyst`, `variant:DriverKit`,
  `variant:Designed for [iPad,iPhone]` — all sharing one udid, so
  `-destination` cannot tell them apart unless the caller passes `variant=`
  themselves. `destinations` collapses them to one row and names the variants
  in `help[]` instead, because four identical rows told the agent nothing it
  could act on. Note the variant value really does contain a comma, which is
  why `parseDestinationLine` splits on the next `key:` rather than on commas.
- **Simulator names are not unique.** Two runtimes routinely publish an
  "iPhone 17 Pro", and a `name=`-based destination silently resolves to
  whichever xcodebuild sees first. `src/destination.ts` always resolves to a
  udid, and `test` reads the destination back out of the result bundle, so a
  pass is never attributed to the wrong OS. `build`, `analyze` and `archive`
  report the destination they resolved rather than re-reading it — the udid
  already pins which device ran, so the only difference is that they do not
  name the platform the way the bundle does (`iPhone 17 · 26.5` against
  `iPhone 17 · iOS Simulator 26.5`).
- **A cross-platform Swift package is eligible for every platform it
  supports.** Sorting those by OS version alone lands on whichever carries the
  highest number — a watchOS build for a package nobody was thinking about
  watchOS for, observed on a plain SPM target. `pickDefault` ranks platform
  first (iOS, then tvOS, visionOS, watchOS), then OS version, then prefers an
  iPhone over an iPad on a tie. A booted simulator beats all of that — the
  agent almost certainly booted it on purpose — and a "Designed for
  [iPad,iPhone]" Mac is never picked by default: it needs signing, and landing
  on it silently turns a simulator run into a Mac one.
- **Xcode 27 renamed the `-showdestinations` headings.** 26 printed
  "Available destinations" and "Ineligible destinations"; 27 prints
  "Destinations compatible with" and "Destinations incompatible with", and
  each incompatible row carries an `error:` field giving the reason (usually a
  deployment target above every installed runtime). Recognizing only the old
  headings treated every incompatible simulator as eligible, so builds failed
  against a device that could never run them. `parseDestinationAnswer` knows
  both, and the reason reaches the agent through `destinations --all` and the
  refusal from `--device`.
- **`-showdestinations` sometimes answers with only the Mac rows** while
  another xcodebuild is running on the machine. That answer is not "this
  scheme has no simulators", so `probeDestinations` retries once and then says
  the answer was incomplete rather than quoting the Mac's ineligibility reason
  as if it were the scheme's.
- **Commands that only compile can target a placeholder.** With nothing
  runnable, `build`, `analyze`, `archive` and `clean` fall back to
  `generic/platform=<platform>` — the "Any iOS Simulator Device" row — instead
  of failing. `test` and `run` cannot, and say why.
- **`-collect-test-diagnostics` defaults to `on-failure`, which costs
  minutes.** One failing assertion made xcodebuild run `simctl diagnose` with a
  600-second timeout after the tests had finished; the same run with `never`
  took 8.7 seconds. `test` passes `never` unless `--diagnostics` asks for it.
- **`-enumerate-tests` reports a broken bundle inside its JSON, and exits
  zero.** The `errors` array holds the reason, nested inside several
  "(Underlying Error: …)" wrappers of which only the innermost says anything;
  `values` still lists the bundle, which counted as one test until `tests`
  checked for errors first.
- **`testIdentifierString` leaves out the test target**, and so does a tree
  node's `nodeIdentifier`, which suites do not carry at all. A failure reads
  `CheckoutTests/testFails()`, and `-only-testing` given that matches nothing.
  Joining `targetName` on the front guesses wrong whenever a class is named
  for its target: `MyAppUITests/testCheckout()` already starts with the
  target's name, so it was left alone and the rerun hint printed a selector
  that matched nothing. `testIdentifierURL` and `nodeIdentifierURL` spell every
  level — `test://com.apple.xcode/<container>/<Target>/<Suite>/<test>` — and
  `testIdentifierFromURL` is how any identifier gets derived. The old guess is
  only a fallback for a bundle without URLs.
- **`-only-testing` that matches nothing passes.** xcodebuild runs it as zero
  tests, prints `** TEST SUCCEEDED **` and exits 0 — alone, or beside
  selectors that did match, so one new suite not yet in its target vanished
  from a run reported as passed. `test` reads the result bundle's tree and
  fails the run for each `--only` no identifier in it matches (`testVerdict`),
  and a run of zero tests is never a pass. Matching is as strict as
  xcodebuild's, checked against it: exact, case-sensitive, no trailing slash,
  and a Swift Testing test only with its parentheses (`total()`,
  `discount(value:)`); an XCTest method is accepted with or without `()`.
  Things that are easy to get wrong:
  - **Only on a run that otherwise passed.** A crash or a timeout also leaves
    tests out of the tree, and calling their selectors misspelled sends the
    agent after the wrong problem.
  - **A `--skip` that overlaps a selector excuses it**, since skipping every
    test under it leaves it out of the tree too. `--skip` itself is not
    checked: a test skipped by filter is absent either way.
  - **An unrecognised URL shape is "cannot tell"**, not "nothing matched".
    Every bundle node's identifier must come out as its own name, or
    `treeIdentifiers` gives up and the report says the check did not happen —
    a mis-parse would otherwise fail every `--only` there is.

## Sharp edges in simctl

Learned while wrapping the last of it, and none of it in `simctl help`:

- **The status bar reads back as enum ordinals.** `status_bar <udid> list`
  answers `Battery State: 2`, `WiFi Mode: 3`, `DataNetworkType: 11`; the words
  those correspond to appear only in the flag documentation. `STATUS_WORDS` in
  `src/commands/sim.ts` maps every value simctl accepts, checked by setting
  each one and reading it back.
- **A push to an app that is not installed succeeds.** `simctl push` exits 0
  and delivers nothing, which is indistinguishable from a notification the app
  ignored, so `sim push` checks `listapps` first.
- **There is no way to read the current simulated location.** `location list`
  lists the scenarios and nothing reports where the device is, which is why a
  bare `sim location` lists rather than reports.
- **`addmedia` explains a rejected file and then buries it.** The useful line
  is `Failed to import '<path>', error [...]: <reason>`, followed by
  "Multiple errors were returned; see stderr" — which is where the reader
  already is.
- **`get_app_container` exits 2 for an app that is not installed**, with an
  NSPOSIXErrorDomain "No such file or directory" that never names the app.
- **Failures come wrapped in framing, and the reason is not on the first
  line.** "An error was encountered processing the command", "Underlying
  error", "Unable to Install" and timestamped `xcodebuild[pid:tid]` lines come
  first. `failureReason` in `src/simctl.ts` skips them; every `sim` refusal
  goes through it.
- **A launched app's `print()` never reaches `--stdout` without
  `NSUnbufferedIO=YES`.** The output sits in a buffer until the process exits.
  `run` passes it as `SIMCTL_CHILD_NSUnbufferedIO` — every `SIMCTL_CHILD_`
  variable reaches the app with the prefix removed, which is also how `--env`
  works. The console file must be somewhere the app can write, so it goes in
  the cache directory; `/tmp` silently stays empty.
- **`log show` filtered on the process returns mostly the system's lines.**
  `process == "MyApp"` includes every framework logging inside the app's
  process. `senderImagePath CONTAINS "/MyApp.app/"` returns only lines the
  app's own binary wrote, which is what `sim logs` asks for unless `--system`
  is passed.
- **"Merged" build settings list every target in the scheme.** Taking the
  first one found a share extension or a test bundle as often as the app, so
  `parseAppSettings` picks the target whose `PRODUCT_TYPE` is an application.

## Wrong guesses are answered, not refused

An agent that has used `xcodebuild` or `simctl` before will type their
spelling first: `xcodebuild-axi -showsdks`, `xcodebuild-axi xcodebuild -scheme
MyApp test`, `xcodebuild-axi simctl io booted screenshot`. If that fails with
"unknown command" the agent concludes the tool cannot do it and drops back to
raw `xcodebuild` for the rest of the session. So `src/redirect.ts` runs before
the SDK's dispatch and translates the guess into this tool's command — and
when a switch really is not wrapped, prints the exact raw command to run
instead, so a fallback is a decision rather than a reflex.

The translation is driven by `src/surface.ts`: an option's `via` is the flag
it maps to, and an `n/a` leaf's reason is what the error says. A new flag
therefore becomes reachable from its xcodebuild spelling without touching the
redirect layer. Plain-word guesses (`screenshot`, `logs`, `install`) live in
`VERB_ALIASES`, and take precedence over xcodebuild's action names —
`install` means "put the app on the simulator" far more often than it means
xcodebuild's `install` action.

A guess can mix spellings — `build-for-testing --scheme MyApp` is an
xcodebuild action followed by this tool's flags. A two-dash word is always
this tool's spelling, so the redirect passes it through with its value
rather than judging it unwrapped — but only onto a command that accepts it,
since suggesting a line that is then refused is worse than naming where the
flag lives. Which flags take a value comes from the command table `cli.ts`
passes in (`KnownFlags`), not from the next word's shape: a scheme can be
called `build`. And a flag guessed on the wrong command is answered in
`renamedFlag`: `test --build-only` points at `build --for-testing`, which is
how issue #42 asked for a feature that had existed since 0.1.0.

The SDK offers only a `renderUnknownCommand` hook and none for a leading
flag, which is why this happens in `main()` on raw argv rather than inside
the SDK.

## Coverage of xcodebuild's surface is declared, not guessed

`src/surface.ts` classifies every leaf of every surface this tool wraps. A
**leaf** is one switch someone could type: an option, a build action, a key of
`-exportOptionsPlist`, an argument of `-create-xcframework`, a subcommand of
`xcresulttool`. Each is `exposed` (an `xcodebuild-axi` flag reaches it),
`always` (the tool sets it for you), `superseded` (answered better by something
this tool already does), `missing` (a gap being paid down — `from` names the
command that will grow it), or `n/a` (deliberately not wrapped, with the reason
stated).

Coverage is asked along four axes, because for a long time it was asked along
the first one only and every miss landed on the other three:

1. **Options** — does any command reach it. This was the original number, and
   it has read 100% since before any of the gaps below were found.
2. **Reach** — does _every_ command xcodebuild accepts it on reach it. An
   exposed option declares a `surface` (`build`, `action`, `resolution`,
   `package`, `scheme`, `testing`), and every command in that surface must be
   listed as reached, `declined` with a reason, or `missing`. Silence fails the
   suite. `-target` on `build` but not on `settings` is the shape of every bug
   this axis exists to catch.
3. **Forms and sub-surfaces** — the options behind an option. `-help` prints
   `-exportOptionsPlist` as one line and never mentions its eighteen keys;
   `-create-xcframework`'s arguments live behind its own `-help`; some second
   forms (`-version <infoitem>`, `-runFirstLaunch -checkForNewerComponents`)
   appear only inside a usage line or a sentence.
4. **Companion tools** — `xcresulttool`, `xccov`, `simctl`. Not xcodebuild, so
   deliberately not in its headline number, but this tool wraps all three and
   an agent that shells out to one directly has dropped back down to raw tools.

`test/surface.test.ts` checks the map against the commands themselves: every
`via` must name a real command, and a flag that command's `FLAGS` actually
accepts and its `--help` actually documents. That is why each command exports
its flag list and `src/cli.ts` collects them into `COMMAND_FLAGS` — the map
cannot claim reach the CLI does not have.

`scripts/coverage.ts` reads the denominator from the installed
`xcodebuild -help`, computes every percentage, and rewrites the README section
between the `<!-- coverage:start -->` markers — including the **Still open**
table, which is the work plan: one row per known gap, what it costs, and the
command it lands on.

`npm run coverage:check` fails on a stale README anywhere, and CI runs it.
`n/a` and `missing` leaves stay in the denominator on purpose — declining to
wrap something, or not having got to it, should both cost the number something.

The other two failures — an option this xcodebuild lists that the map has never
classified, and an option the map claims that xcodebuild has dropped — are only
fatal on the Xcode named by `AUTHORED_AGAINST` in `src/surface.ts`. **The option
list is not stable across Xcode releases.** 26 listed `-dry-run` and
`-downloadAllPreviouslySelectedPlatforms`; 27 dropped both and added the
`platforms` and codesize families. A CI runner on a different Xcode therefore
disagrees with this map for reasons that are not a defect in it, and failing on
that would make the check impossible to keep green anywhere but one machine. On
any other version the differences are printed and the check passes.

So moving to a new Xcode is a deliberate step: run `npm run coverage` on it,
classify whatever it added, and bump `AUTHORED_AGAINST`. Until then the map
stays authoritative for the version it was actually read from.

Adding a flag therefore means three edits: the command, `src/surface.ts`, and
`npm run coverage`. A flag with no xcodebuild counterpart — `--full`,
`--max-errors`, `--live` — is how this tool shapes its own output, maps to no
leaf, and gets no `surface.ts` entry. The help text's own `flags[N]:` count is checked by
`test/help.test.ts`, so a forgotten count fails the suite rather than shipping
a TOON array that lies about its length.

## One run per simulator

Two runs installing onto one simulator kill each other's app — the second
`install` terminates the first run's test host mid-test, and both report the
other's damage as a failure of their own. `src/devicelock.ts` owns the lock.
Decisions that are not obvious from the code:

- **The key is the udid, and only a pinned one.** `lockKey` takes it from the
  resolved `id=`; a raw `--destination` naming only `name=` is not locked,
  because which runtime's device it lands on is xcodebuild's guess. macOS and
  generic placeholders lock nothing — a Mac is one shared machine, and a
  placeholder runs nothing.
- **Acquire is a hard link, not `O_EXCL` on the final name.** The record is
  written in full to a private file and linked into place, so exactly one
  racer wins and no reader sees half a lock. A stale lock is renamed aside and
  put back if what was renamed is not what was judged stale.
- **Staleness is pid plus start time.** A dead pid is stale; so is a live pid
  whose `ps -o lstart=` differs from the one recorded, which is pid reuse. A
  lock carrying only a `pid` — another tool's — is honoured while that pid
  lives. A lock that cannot be read at all (a directory, another user's file)
  is judged by its age like a half-written one, rather than failing every
  run. There are no signal handlers: `process.once("exit")` removes the
  lock, and a `kill -9` leaves one that the next run sees is stale.
- **Raw xcodebuild is caught by a `ps -axww` scan**, after acquiring. Only a
  `test`/`test-without-building` naming the udid counts — a build installs
  nothing — and our own descendants are excluded. `/usr/bin/xcodebuild` is a
  shim that execs the real binary as its child, so each contender shows up as
  a pair; it is reported once, as the outer pid. Without `-ww` the command
  line is truncated before the destination.
- **`run` holds the lock only across install and launch**, since the build
  touches no simulator, but checks it before building so a busy device is not
  discovered after a two-minute compile. With `--wait` it skips the check and
  queues at install instead.
- **A default pick that loses a race picks again.** The default destination
  skips held simulators, but two runs started together both see the same one
  free. `resolveLockedContext` re-resolves the loser without it, once per
  device, so it lands on a free simulator instead of being refused. A device
  named with `--device` or `--destination`, or one `--wait` was asked to queue
  for, is never swapped.
- **`sim` verbs check without holding.** `install`, `launch`, `terminate`,
  `erase` and the rest are one-shot and disturb a running app; `boot` does not
  and is not checked. Holding for a single `simctl` call would only race. The
  check runs inside each verb after its own validation, so a usage error is
  still answered first and the simulator is resolved once. `--all` forms check
  every device they would touch with a single `ps`; `erase --all` is not
  checked, since simctl erases only shut-down devices and a device under test
  is booted.
- **`tests` takes no lock.** Its `-enumerate-tests` run passes the `test`
  action, but its log shows no install, launch or boot — which is also why the
  `ps` scan ignores an xcodebuild carrying `-enumerate-tests`.
- **`XCODEBUILD_AXI_HELD_DEVICES`** is set while `test` holds a device, so an
  `xcodebuild-axi` call from a scheme's pre-action sees the lock as its own
  run's. That has to skip the `ps` scan as well as the lock file — the parent's
  xcodebuild is testing on that udid and is not our descendant — and has to
  keep the default pick from steering away from it.
- **The lock does not cover every contention.** The issue that asked for it
  also reported `settings --for-index` and `packages --resolve` colliding with
  a test run; neither touches a simulator, so no device lock would have
  stopped them. Nor does it keep two runs' artifacts apart: `test` releases
  the device before it reads its bundle, and a run queued with `--wait`
  starts in that gap. Per-run artifact names do that job, not the lock.

## `migrate` is the one command that edits tracked files

Everything else here writes only to `~/Library/Caches`. `migrate --format`
rewrites the `.pbxproj` in place, so it requires `--yes` on top of `--format`
and says so in both its help and its refusal. Do not relax that to a single
flag: an agent cannot undo it for the user, and the diff lands in their repo.

## Savings are measured, not asserted

`scripts/benchmark.ts` runs raw `xcodebuild` and `xcodebuild-axi` against the
same question in a real project and tokenizes both answers, then writes the
table into the README between the `<!-- benchmark:start -->` markers. Token
counts use GPT-4o BPE via `gpt-tokenizer`, since Anthropic's tokenizer is not
public — the ratios are the point, not the absolute numbers.

Two things keep it honest and must not be dropped:

- **Both stdout and stderr are counted**, because that is what an agent running
  the command in a shell actually reads.
- **Build and test scenarios get one derived-data directory per side, wiped
  first.** Otherwise whichever side runs second builds incrementally, prints a
  fraction of the output, and wins on something that has nothing to do with
  this tool.

It is deliberately not in CI: it needs a real project and takes minutes. Rerun
it with `--write` when output shapes change, and treat a scenario that barely
saves anything as a bug in that command rather than a fact about xcodebuild —
`info --sdks` was reprinting the whole toolchain header and saving 1.2%.

## Where artifacts go

`~/Library/Caches/xcodebuild-axi/<project-name>-<sha256(path)[0:8]>/`. Never
the repository: running this tool must not dirty a working tree or require a
`.gitignore` entry. The hash keys on the absolute project path so two checkouts
of the same repo do not collide. Both `build` and `test` print the absolute log
and bundle paths, so nothing is hidden by being out of the way.

`device-locks/` beside those directories is state, not an artifact: one file
per simulator currently in use, shared across every project on the machine
because the simulators are.

**Every run gets its own log and bundle**:
`<scheme>[-<device>]-<command>-<pid>[-<n>]`, e.g.
`MyApp-iPhone-17-Pro-26-5-test-4821.xcresult`. They used to be named for the
scheme, device and command alone, and a run that outlived its tests had its
bundle deleted and its log truncated by the next run of the same pair — then
reported that run's counts as its own, beside a `failed` verdict that was its
real one. `prepareRun` in `src/xcodebuild.ts` claims the stem by creating the
log with `wx`, so the claim is atomic even within one process; `-<n>` covers a
second run of one label there. Anything a run writes beside its log (`tests`'
enumeration JSON, `run`'s console) takes the same stem via `prepareAction`.

The pid is in the name, rather than a timestamp, because it does two jobs a
timestamp cannot. Two live processes never share one, so it is unique where
it matters; and it tells a finished run from a live one. Ordering is left to
mtime. A timestamp would also have cost every report ~14 tokens in the two
paths it prints; the pid costs ~3 each.

Without pruning the cache would grow a bundle per run for ever, so each run
starts by removing older finished runs of **its own label** (`pruneRuns` in
`src/bundles.ts`), taking their exports with them. Decisions in it that are
easy to undo:

- **A run whose process is alive is never touched**, since it may not have
  read its bundle yet. "Alive" is the pid _and_ `ps -o lstart=` predating the
  run's first file, as the device lock judges a holder — `kill(pid, 0)` alone
  kept a finished run for as long as whatever reused its pid lived.
- **The newest finished run with a bundle is kept**, so the path the last
  report printed still works while the next run goes — `result <previous>
--against <new>` depends on that. Only a bundle counts: a `run --no-build`
  leaves just a console and a run killed before xcodebuild started just an
  empty log, and either used to push the last real bundle out.
- **Per label**, so a build never removes the test bundle `result` falls back
  to.
- **Never in `--artifacts-dir`.** That directory is the caller's: a CI job
  that runs three test plans under one scheme and uploads at the end wants
  all three. Only the cache is housekept.
- **No "latest" symlink.** mtime already answers that, and a link ending in
  `.xcresult` would be listed twice.

`result` with no path reads the newest bundle in that directory, and the home
view reports on the same one; both go through `src/bundles.ts`. Recency is the
mtime. The name matters only for the kind: reads that mean nothing on a build
(`--export attachments`, `--tests`, …) take the newest _test_ bundle, and
`bundleKind` is the one place that parses the naming to decide that — it
strips the all-digit per-run suffix, then takes the command. The command is
the last hyphen-separated segment except for `build-for-testing`, the one
label with hyphens of its own, which is matched whole. Rename the
bundles and it has to change in the same commit. A run given
`--artifacts-dir` is invisible to the default by design — it is not in the
directory, and the refusal says so.

`--export`'s default directory is keyed on the bundle path, and `result`
clears it before writing, so exporting one bundle twice — or a bundle outside
the cache that was rewritten in place — does not count the last export's
screenshots as its own.

## stdout is the answer; stderr is for watching

A run that hangs never prints its report, and the report was the only place
the log path appeared — so a wedged test run was opaque for as long as it
hung (one real case: 83 minutes of silence until a CI cap killed it). Two
things answer that, both in `runBuild`, both on stderr:

- **The log path, once a run has gone 30 seconds** (`ANNOUNCE_AFTER_MS`).
  Not up front: it is ~30 tokens against a ~90-token passing report, on every
  quick incremental build in an agent's inner loop, and a run that finishes
  in under 30 seconds never needed a tail. Not TTY-gated either: agents never
  have a TTY, and they are who the line is for.
- **The transcript itself, under `--live`**, on every command that writes a
  log. It is a firehose — hundreds of KB for one test run — so it is for a
  background run or a human watching, never the foreground default.

stderr rather than the stdout the issue asked for, because stdout staying
byte-identical with and without `--live` is what keeps `$(…)` and a TOON
parser working; every agent shell and CI log captures both. Under `2>&1` a
long run shows `log:` twice, which is harmless.

Details in `watchRun` that are easy to undo by accident:

- **The tee ignores backpressure, but not without limit.** Piping into a slow
  stderr reader pauses the child's stdout, and xcodebuild then blocks on its
  own writes: watching the run would stall it. So chunks are queued instead,
  up to 8 MB (`PROGRESS_BACKLOG_BYTES`), and past that dropped with a line
  saying how many bytes were skipped — a hung run that loops on output would
  otherwise grow the process for as long as it hangs. The log misses nothing.
- **Chunks are passed on as bytes, never decoded.** A pipe read can end inside
  a multibyte character, and Swift diagnostics are full of curly quotes.
- **A failed stderr is stopped writing to, not thrown.** The SDK handles EPIPE
  on stdout only; `2>&1 | head` closing the reader would otherwise kill the
  process before the report. The listener that catches it stays attached
  while any write is still queued, including after the drain cap gives up.
- **`log:` is announced on `spawn`, not before.** A binary that never starts
  would otherwise point the agent at a log that is never written.
- **The report waits for the tee to drain**, capped at two seconds, and the
  transcript is finished with a newline — so under `2>&1` the report never
  starts mid-line.

## Exit codes

`0` success, `1` the build or tests failed, `2` usage error. A test run in
which nothing ran, or an `--only` matched nothing, is a failure too, whatever
xcodebuild exited with. A failed build is
not a tool error — the full report still goes to stdout — but the agent asked
for a build and did not get one, so `&&` chains and CI must stop. The non-zero
status is set on `process.exitCode` by the command, after the report is
rendered.

## Output shape gotchas

TOON quotes any scalar containing a comma, a colon, or a quote, and the quotes
cost more than the punctuation saved. So:

- Error messages use `'single quotes'` around names and an em dash instead of a
  colon.
- Lists of names are passed to `renderFields` as **arrays**, which TOON renders
  inline and unquoted (`schemes[12]: A,B,C`), rather than as a comma-joined
  string, which it would quote.
