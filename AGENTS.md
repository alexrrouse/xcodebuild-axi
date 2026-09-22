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
measured 549 KB, and a full verify run of the same repo 2.5 MB.

`src/xcresult.ts` owns every read. Two things there are easy to get wrong:

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

## xcodebuild failures that produce no usable bundle

When xcodebuild dies _before_ it builds anything — an unknown scheme, an
unmatched destination, a missing signing team — the result bundle it writes
records only `"xcodebuild encountered an error (65)"` with
`status: notRequested`. The transcript is the only witness.

Both `build` and `test` therefore fall back to `mapXcodebuildError()` on the
transcript tail whenever the bundle reports a failure with zero errors. Do not
remove that fallback believing the bundle is always sufficient; it is not.

## Sharp edges in xcodebuild itself

- **It refuses to overwrite a result bundle.** A second run against the same
  path dies with `error: Existing file at -resultBundlePath` before running
  anything. `runBuild` clears the bundle first — the bundle is our artifact,
  not the user's.
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
  iPhone over an iPad on a tie.

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
`npm run coverage`. The help text's own `flags[N]:` count is checked by
`test/help.test.ts`, so a forgotten count fails the suite rather than shipping
a TOON array that lies about its length.

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

## Exit codes

`0` success, `1` the build or tests failed, `2` usage error. A failed build is
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
