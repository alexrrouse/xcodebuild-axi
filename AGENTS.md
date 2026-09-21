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
  `failureText`, and `testIdentifierString`. Per-failure source locations need
  `xcresulttool get test-results test-details`, which is a drill-down, not
  something the summary can provide.

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
- **Simulator names are not unique.** Two runtimes routinely publish an
  "iPhone 17 Pro", and a `name=`-based destination silently resolves to
  whichever xcodebuild sees first. `src/destination.ts` always resolves to a
  udid, and the reported destination is read back out of the bundle so a pass
  is never attributed to the wrong OS.
- **A cross-platform Swift package is eligible for every platform it
  supports.** Sorting those by OS version alone lands on whichever carries the
  highest number — a watchOS build for a package nobody was thinking about
  watchOS for, observed on a plain SPM target. `pickDefault` ranks platform
  first (iOS, then tvOS, visionOS, watchOS), then OS version, then prefers an
  iPhone over an iPad on a tie.

## Coverage of xcodebuild's surface is declared, not guessed

`src/surface.ts` classifies every option `xcodebuild -help` prints as
`exposed` (an `xcodebuild-axi` flag reaches it), `always` (the tool sets it for
you), `superseded` (answered better by something this tool already does — only
`-help` and `-usage`), or `n/a` (deliberately not wrapped, with the reason
stated). All 117 are currently covered; `installsrc` is the one build action
left out.
`scripts/coverage.ts` reads the denominator from the installed
`xcodebuild -help`, computes the percentage, and rewrites the README section
between the `<!-- coverage:start -->` markers.

`npm run coverage:check` fails three ways, and CI runs it: a stale README, an
option this xcodebuild lists that the map has never classified (a new Xcode
shipped one), and an option the map still claims that xcodebuild has dropped.
`n/a` options stay in the denominator on purpose — declining to wrap something
should cost the number something.

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
