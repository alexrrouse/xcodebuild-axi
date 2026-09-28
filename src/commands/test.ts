import { AxiError, mapXcodebuildError } from "../errors.js";
import {
  BUILD_FLAG_HELP,
  resolveLockedContext,
  runAction,
  SHARED_BUILD_FLAGS,
  SHARED_BUILD_VALUE_FLAGS,
  databaseLockHint,
  subjectField,
  type BuildContext,
} from "../action.js";
import {
  isGenericFailure,
  meaningfulErrors,
  readBuildResults,
  readTests,
  readTestSummary,
  testIdentifierFromURL,
  toDiagnostics,
  treeIdentifiers,
  describeDevice,
  type BuildResults,
  type TestDevice,
  type TestFailure,
  type TestSummary,
  type TestTree,
} from "../xcresult.js";
import { shellQuote } from "../redirect.js";
import { readCoverage, percent } from "../xccov.js";
import {
  acquireDevice,
  DEVICE_LOCK_FLAG_HELP,
  DEVICE_LOCK_FLAGS,
  DEVICE_LOCK_VALUE_FLAGS,
  deviceLockOptions,
  lockKey,
} from "../devicelock.js";
import { diagnosticsBlock, failureRows, transcriptTail } from "../report.js";
import type { BuildRun } from "../xcodebuild.js";
import {
  duration,
  renderFields,
  renderHelp,
  renderList,
  renderOutput,
  tildePath,
} from "../toon.js";
import {
  getFlag,
  getIntFlag,
  getListFlag,
  hasFlag,
  rejectUnknownFlags,
} from "../args.js";

export const TEST_HELP = `usage: xcodebuild-axi test [flags]
Runs a scheme's tests and reports the counts plus only the failures.
flags[70]:
${BUILD_FLAG_HELP}
  --test-plan <name>     test plan to run
  --only <id>            run only this Target/Class/method; repeatable or comma-separated; a miss fails
  --skip <id>            skip this test/class/target; repeatable or comma-separated
  --coverage             collect code coverage and report the overall percentage
  --without-building     test already-built products (test-without-building)
  --xctestrun <path>     test from an .xctestrun file instead of a scheme
  --parallel <n>         exact number of parallel test runners
  --no-parallel          disable parallel testing
  --iterations <n>       run the tests this many times
  --retry                retry failures, up to --iterations (default 3)
  --until-failure        repeat until something fails, up to --iterations (default 100)
  --language <iso639>    run in this language
  --region <iso3166>     run in this region
  --diagnostics          collect a sysdiagnose on failure (off by default — it adds minutes)
  --perf-diagnostics     collect performance traces and memgraphs for performance tests
  --relaunch             relaunch the process between repetitions
  --only-configuration <name>  run only this test configuration; repeatable
  --skip-configuration <name>  skip this test configuration; repeatable
  --max-workers <n>      cap on parallel test runners
  --max-sim-destinations <n>   cap on simulator destinations tested concurrently
  --max-device-destinations <n>  cap on device destinations tested concurrently
  --default-test-timeout <secs>  default per-test allowance when timeouts are on
  --test-products <path>  where to find the built test products
  --test-timeout <secs>  per-test execution allowance (default: 300, 0 disables)
  --max-failures <n>     failures to list before summarizing the rest (default: 20)
${DEVICE_LOCK_FLAG_HELP}
note:
  The simulator is locked for the run. A second test or run on it is refused
  with DEVICE_BUSY and the other run's pid, rather than overwriting its
  installs; --wait queues behind it instead. build never locks.
exit:
  0 all tests passed, 1 a test or the build failed, no test ran, an --only
  matched nothing, or the device is busy, 2 usage error
examples:
  xcodebuild-axi test
  xcodebuild-axi test --scheme MyApp --device "iPhone 17 Pro"
  xcodebuild-axi test --scheme MyApp --only MyAppTests/CheckoutTests
  xcodebuild-axi test --scheme MyApp --coverage
`;

export const TEST_FLAGS = [
  ...SHARED_BUILD_FLAGS,
  ...DEVICE_LOCK_FLAGS,
  "--test-plan",
  "--only",
  "--skip",
  "--coverage",
  "--without-building",
  "--xctestrun",
  "--parallel",
  "--no-parallel",
  "--iterations",
  "--retry",
  "--until-failure",
  "--language",
  "--region",
  "--diagnostics",
  "--perf-diagnostics",
  "--relaunch",
  "--only-configuration",
  "--skip-configuration",
  "--max-workers",
  "--max-sim-destinations",
  "--max-device-destinations",
  "--default-test-timeout",
  "--test-products",
  "--test-timeout",
  "--max-failures",
] as const;

const VALUE_FLAGS = [
  ...SHARED_BUILD_VALUE_FLAGS,
  ...DEVICE_LOCK_VALUE_FLAGS,
  "--test-plan",
  "--only",
  "--skip",
  "--xctestrun",
  "--parallel",
  "--iterations",
  "--language",
  "--region",
  "--only-configuration",
  "--skip-configuration",
  "--max-workers",
  "--max-sim-destinations",
  "--max-device-destinations",
  "--default-test-timeout",
  "--test-products",
  "--test-timeout",
  "--max-failures",
] as const;

export async function testCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "test", TEST_FLAGS, VALUE_FLAGS);

  if (hasFlag(args, "--retry") && hasFlag(args, "--until-failure")) {
    // xcodebuild rejects this combination itself, but only after building.
    throw new AxiError(
      "--retry and --until-failure cannot be used together",
      "VALIDATION_ERROR",
      [
        "--retry stops at the first success, --until-failure stops at the first failure",
      ],
    );
  }

  const withoutBuilding =
    hasFlag(args, "--without-building") ||
    getFlag(args, "--xctestrun") !== undefined;
  const lock = deviceLockOptions(args);
  const coverage = hasFlag(args, "--coverage");

  // Held from before xcodebuild starts until it exits: the build half does
  // not touch the device, but the install that follows it does, and xcodebuild
  // offers no point in between to take the lock at.
  const { context, claimed: release } = await resolveLockedContext(
    { args, command: "test", lock },
    async (context) => {
      const udid = lockKey(context.destinationSpecifier);
      if (!udid) return () => {};
      return acquireDevice({
        udid,
        meta: {
          device: context.destination ?? udid,
          command: "test",
          scheme: context.scheme,
          project: context.project.path,
        },
        options: lock,
      });
    },
  );

  let run: BuildRun;
  try {
    run = await runAction({
      context,
      command: "test",
      actions: [withoutBuilding ? "test-without-building" : "test"],
      extraArgs: testArgs(args, coverage),
    });
  } finally {
    release();
  }

  const summary = await readTestSummary(run.resultPath).catch(() => undefined);
  // Only worth the second xcresulttool call when the summary counted nothing.
  const build =
    summary?.totalTestCount === 0
      ? await readBuildResults(run.resultPath).catch(() => undefined)
      : undefined;

  if (!summary || testsNeverRan(summary, build)) {
    return renderTestsNeverRan(context, run);
  }

  // The tree is what `--only` is checked against, and the only place a run
  // of zero tests still names its device. Not worth a call otherwise.
  const only = getListFlag(args, "--only");
  const tree =
    only.length > 0 || summary.totalTestCount === 0
      ? await readTests(run.resultPath).catch(() => undefined)
      : undefined;

  return renderTestSummary({
    context,
    summary,
    tree,
    only,
    skip: getListFlag(args, "--skip"),
    run,
    maxFailures: getIntFlag(args, "--max-failures") ?? 20,
    full: context.full,
    coverage,
  });
}

function testArgs(args: string[], coverage: boolean): string[] {
  const testPlan = getFlag(args, "--test-plan");
  const xctestrun = getFlag(args, "--xctestrun");
  const timeout = getIntFlag(args, "--test-timeout") ?? 300;
  const iterations = getIntFlag(args, "--iterations");
  const parallel = getIntFlag(args, "--parallel");
  const language = getFlag(args, "--language");
  const region = getFlag(args, "--region");
  const maxWorkers = getIntFlag(args, "--max-workers");
  const maxSimDestinations = getIntFlag(args, "--max-sim-destinations");
  const maxDeviceDestinations = getIntFlag(args, "--max-device-destinations");
  const defaultTimeout = getIntFlag(args, "--default-test-timeout");
  const testProducts = getFlag(args, "--test-products");

  return [
    ...(xctestrun ? ["-xctestrun", xctestrun] : []),
    ...(testPlan ? ["-testPlan", testPlan] : []),
    ...getListFlag(args, "--only").flatMap((id) => ["-only-testing", id]),
    ...getListFlag(args, "--skip").flatMap((id) => ["-skip-testing", id]),
    ...(coverage ? ["-enableCodeCoverage", "YES"] : []),
    ...(parallel !== undefined
      ? [
          "-parallel-testing-enabled",
          "YES",
          "-parallel-testing-worker-count",
          String(parallel),
        ]
      : []),
    ...(hasFlag(args, "--no-parallel")
      ? ["-parallel-testing-enabled", "NO"]
      : []),
    ...(iterations !== undefined
      ? ["-test-iterations", String(iterations)]
      : []),
    ...(hasFlag(args, "--retry") ? ["-retry-tests-on-failure"] : []),
    ...(hasFlag(args, "--until-failure") ? ["-run-tests-until-failure"] : []),
    ...(language ? ["-testLanguage", language] : []),
    ...(region ? ["-testRegion", region] : []),
    // ⚠️ xcodebuild's own default is on-failure, not never: one failing
    // assertion starts a `simctl diagnose` with a ten-minute timeout, and the
    // report waits for it. So off unless asked for, which is what the flag
    // always claimed.
    "-collect-test-diagnostics",
    hasFlag(args, "--diagnostics") ? "on-failure" : "never",
    ...(hasFlag(args, "--perf-diagnostics")
      ? ["-enablePerformanceTestsDiagnostics", "YES"]
      : []),
    ...(hasFlag(args, "--relaunch")
      ? ["-test-repetition-relaunch-enabled", "YES"]
      : []),
    ...getListFlag(args, "--only-configuration").flatMap((name) => [
      "-only-test-configuration",
      name,
    ]),
    ...getListFlag(args, "--skip-configuration").flatMap((name) => [
      "-skip-test-configuration",
      name,
    ]),
    ...(maxWorkers !== undefined
      ? ["-maximum-parallel-testing-workers", String(maxWorkers)]
      : []),
    ...(maxSimDestinations !== undefined
      ? [
          "-maximum-concurrent-test-simulator-destinations",
          String(maxSimDestinations),
        ]
      : []),
    ...(maxDeviceDestinations !== undefined
      ? [
          "-maximum-concurrent-test-device-destinations",
          String(maxDeviceDestinations),
        ]
      : []),
    ...(defaultTimeout !== undefined
      ? ["-default-test-execution-time-allowance", String(defaultTimeout)]
      : []),
    ...(testProducts ? ["-testProductsPath", testProducts] : []),
    // A wedged test otherwise runs until the caller's own timeout kills it,
    // with nothing in the output saying which one hung.
    ...(timeout > 0
      ? [
          "-test-timeouts-enabled",
          "YES",
          "-maximum-test-execution-time-allowance",
          String(timeout),
        ]
      : []),
  ];
}

async function renderTestsNeverRan(
  context: BuildContext,
  run: BuildRun,
): Promise<string> {
  const results = await readBuildResults(run.resultPath).catch(() => undefined);
  const errors = toDiagnostics(meaningfulErrors(results?.errors));

  // The generic exit-code row alone is no diagnosis; the transcript may be.
  if (errors.every(isGenericFailure)) {
    const mapped = mapXcodebuildError(run.tail);
    if (mapped) {
      throw new AxiError(mapped.message, mapped.code, [
        ...mapped.suggestions,
        `full transcript: ${tildePath(run.logPath)}`,
      ]);
    }
  }

  const blocks = [
    renderFields({
      test: "failed",
      reason: "the build failed, so no test ran",
      ...subjectField(context),
      ...(context.destination ? { destination: context.destination } : {}),
      duration: duration(run.seconds),
    }),
  ];

  const errorBlock = diagnosticsBlock("errors", errors, context.maxErrors);
  if (errorBlock.block) {
    blocks.push(errorBlock.block);
  } else {
    const tail = transcriptTail(run.tail);
    if (tail) blocks.push(tail);
  }

  blocks.push(
    renderFields({
      log: tildePath(run.logPath),
      result: tildePath(run.resultPath),
    }),
  );
  const hints: string[] = [];
  if (errorBlock.hidden > 0) {
    hints.push(
      `Run \`xcodebuild-axi test --max-errors ${errors.length}\` to list all ${errors.length} errors`,
    );
  }
  const lockHint = databaseLockHint(errors);
  if (lockHint) hints.push(lockHint);
  if (hints.length > 0) blocks.push(renderHelp(hints));
  process.exitCode = 1;
  return renderOutput(blocks);
}

interface RenderTestSummaryOptions {
  context: BuildContext;
  summary: TestSummary;
  /** Read only when there are `--only` selectors to check, or nothing ran. */
  tree: TestTree | undefined;
  only: string[];
  skip: string[];
  run: BuildRun;
  maxFailures: number;
  full: boolean;
  coverage: boolean;
}

async function renderTestSummary(
  options: RenderTestSummaryOptions,
): Promise<string> {
  const { summary, run, context, tree, only, skip } = options;
  const failed = summary.failedTests ?? 0;
  const passed = summary.passedTests ?? 0;
  const skipped = summary.skippedTests ?? 0;
  const identifiers = tree ? treeIdentifiers(tree) : undefined;
  const verdict = testVerdict({
    exitCode: run.exitCode,
    summary,
    only,
    skip,
    identifiers,
  });
  const { succeeded, unmatched } = verdict;

  // Report the destination the run actually landed on, not the one requested:
  // a name-based specifier can resolve to a different runtime than expected,
  // and a pass on the wrong OS is a pass the agent should not trust.
  const device = landedDevice(summary, tree);
  const landed = device
    ? describeDevice(device)
    : (context.destination ?? "unknown");

  const coverageReport = options.coverage
    ? await readCoverage(run.resultPath).catch(() => undefined)
    : undefined;

  const blocks: string[] = [
    renderFields({
      test: succeeded ? "passed" : "failed",
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      ...subjectField(context),
      destination: landed,
      // Slash-separated, not comma-separated: TOON quotes any scalar
      // containing a comma, and the quotes cost more than the commas saved.
      tests: `${passed} passed / ${failed} failed / ${skipped} skipped`,
      ...(unmatched.length > 0 ? { unmatched } : {}),
      duration: duration(run.seconds),
      ...(coverageReport
        ? { coverage: percent(coverageReport.lineCoverage) }
        : {}),
    }),
  ];

  const failures = summary.testFailures ?? [];
  if (failures.length > 0) {
    const shown = await failureRows(run.resultPath, failures, {
      max: options.maxFailures,
      full: options.full,
    });
    blocks.push(
      renderList(
        failures.length > shown.length
          ? `failures (${shown.length} of ${failures.length})`
          : "failures",
        shown,
      ),
    );
  }

  const runtimeWarnings = summary.runtimeWarnings ?? [];
  if (runtimeWarnings.length > 0) {
    blocks.push(renderFields({ runtime_warnings: runtimeWarnings.length }));
  }

  blocks.push(
    renderFields({
      log: tildePath(run.logPath),
      result: tildePath(run.resultPath),
    }),
  );

  const hints: string[] = [];
  // xcodebuild runs a selector that matches nothing as zero tests, prints
  // TEST SUCCEEDED and exits 0 -- so the verdict above is the only place that
  // says so. The hint says how selectors are spelled, since a near miss is
  // the usual cause.
  if (unmatched.length > 0 || (verdict.ran === 0 && only.length > 0)) {
    hints.push(
      "--only is exact and case-sensitive — Target/Class/method, and a Swift Testing test keeps its parentheses, e.g. MyAppTests/CheckoutSuite/total()",
    );
  } else if (verdict.ran === 0) {
    hints.push(
      "No tests ran — check --skip, --test-plan and --only-configuration, and that the scheme's test action has tests",
    );
  }
  if (unmatched.length > 0 || verdict.ran === 0) {
    hints.push(
      `Run \`xcodebuild-axi tests ${context.subject.rerun}\` for the identifiers this scheme has`,
    );
  }
  if (verdict.checked === false) {
    hints.push(
      "The result bundle's test tree could not be read, so --only selectors were not checked against what ran",
    );
  }
  if (failures.length > 0) {
    const first = rerunIdentifier(failures[0]);
    if (first) {
      hints.push(
        `Run \`xcodebuild-axi test ${context.subject.rerun} --only ${shellQuote(first)}\` to re-run just this failure`,
      );
    }
    hints.push(
      `Run \`xcodebuild-axi result ${tildePath(run.resultPath)} --failures --full\` for untruncated failure text`,
    );
  }
  if (coverageReport) {
    hints.push(
      `Run \`xcodebuild-axi coverage ${tildePath(run.resultPath)} --below 50\` for the files that need tests`,
    );
  }
  blocks.push(renderHelp(hints));

  if (!succeeded) process.exitCode = 1;
  return renderOutput(blocks);
}

/**
 * Whether the tests under a run never started, so the report is the build's.
 *
 * No summary at all means the build failed or xcodebuild refused the
 * invocation. But a summary is not proof the tests ran: when a Swift
 * package's test target fails to compile, xcresulttool still answers with
 * `{title: "Test - X", totalTestCount: 0}` — the same shape `result` already
 * refuses to read as a test run. Reported as a summary, a compile error came
 * out as "0 passed / 0 failed" and a hint that an `--only` filter matched
 * nothing, on a run that had no filter. A real diagnostic in the build
 * results is what tells the two apart: a filter that matched nothing
 * compiles cleanly.
 */
export function testsNeverRan(
  summary: TestSummary | undefined,
  build: BuildResults | undefined,
): boolean {
  if (!summary || summary.totalTestCount === undefined) return true;
  if (summary.totalTestCount > 0) return false;
  return (build?.errors ?? []).some(
    (issue) => (issue.issueType ?? "").toLowerCase() !== "uncategorized",
  );
}

export interface TestVerdict {
  succeeded: boolean;
  reason?: string;
  /** `--only` selectors that matched no test in a run that otherwise passed. */
  unmatched: string[];
  /** How many tests the summary counted. */
  ran: number;
  /** False when `--only` should have been checked but there was no tree. */
  checked?: boolean;
}

/**
 * Whether a test run did what it was asked, and if not, why.
 *
 * A zero exit and no failures is not enough. xcodebuild runs an
 * `-only-testing` selector that matches nothing as zero tests, prints
 * TEST SUCCEEDED and exits 0 -- alone, or beside selectors that did match --
 * so a new suite not yet in its target, or a selector missing its class, came
 * back as a pass. Every selector is checked against the identifiers the
 * result bundle's tree says ran.
 *
 * Only on a run that otherwise passed. A crash or a timeout leaves tests that
 * never started out of the tree too, and naming their selectors as misses
 * would send the agent to fix a spelling that was right. A failed run is
 * already failed; a real miss surfaces on the run after the fix. With no tree
 * to check, nothing is claimed missing either: that would be a guess.
 */
export function testVerdict(input: {
  exitCode: number;
  summary: TestSummary;
  only: string[];
  skip?: string[];
  identifiers: string[] | undefined;
}): TestVerdict {
  const { summary, only, identifiers } = input;
  const failed = summary.failedTests ?? 0;
  // `testsNeverRan` has already turned away a summary without a count.
  const ran = summary.totalTestCount ?? 0;
  const otherwisePassed = input.exitCode === 0 && failed === 0;
  const check = only.length > 0 && otherwisePassed;
  const unmatched =
    check && identifiers
      ? unmatchedSelectors(only, identifiers, input.skip ?? [])
      : [];
  const succeeded = otherwisePassed && ran > 0 && unmatched.length === 0;

  // A reason only where the counts do not already explain the verdict: a
  // failed test is its own reason.
  const reason =
    ran === 0
      ? only.length > 0 && otherwisePassed
        ? "no --only selector matched a test"
        : "no tests ran"
      : unmatched.length > 0
        ? `${unmatched.length} --only selector${unmatched.length === 1 ? "" : "s"} matched no test`
        : undefined;
  return {
    succeeded,
    ...(reason ? { reason } : {}),
    unmatched,
    ran,
    ...(check && !identifiers ? { checked: false } : {}),
  };
}

/**
 * The `--only` selectors that match nothing a run's tree says ran, as typed.
 *
 * As strict as xcodebuild, checked against it: exact and case-sensitive, no
 * trailing slash, and a Swift Testing test only with its parentheses. The one
 * allowance is an XCTest method written with `()`, which xcodebuild accepts
 * and the tree spells without.
 *
 * A selector a `--skip` overlaps is left alone: skipping every test under it
 * also leaves it out of the tree, and that is not a misspelling.
 */
export function unmatchedSelectors(
  selectors: string[],
  identifiers: string[],
  skip: string[] = [],
): string[] {
  const ran = new Set(identifiers);
  const overlaps = (a: string, b: string) =>
    a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  return selectors.filter(
    (selector) =>
      !ran.has(selector) &&
      !ran.has(selector.replace(/\(\)$/, "")) &&
      !skip.some((skipped) => overlaps(skipped, selector)),
  );
}

/**
 * The device a run landed on. A run of zero tests lists none in its summary,
 * but its tree still does -- and without it the destination loses its
 * platform.
 */
export function landedDevice(
  summary: TestSummary,
  tree: TestTree | undefined,
): TestDevice | undefined {
  return summary.devicesAndConfigurations?.[0]?.device ?? tree?.devices?.[0];
}

/**
 * The identifier `-only-testing` needs for one failure.
 *
 * `testIdentifierURL` spells it whole (`testIdentifierFromURL`), including
 * the parentheses a Swift Testing test needs. Without one, the older guess:
 * `testIdentifierString` omits the test target (`CheckoutTests/testFails()`),
 * so `targetName` is joined on the front -- unless the string already starts
 * with it, which is also what a class named for its target looks like, and
 * why the URL comes first. The trailing `()` is dropped for readability;
 * XCTest accepts either spelling.
 */
export function rerunIdentifier(
  failure: TestFailure | undefined,
): string | undefined {
  // Trusted only while it still starts with the target it should name.
  const fromURL = testIdentifierFromURL(failure?.testIdentifierURL);
  if (
    fromURL &&
    (!failure?.targetName || fromURL.startsWith(`${failure.targetName}/`))
  ) {
    return fromURL;
  }
  const id = failure?.testIdentifierString?.replace(/\(\)$/, "");
  if (!id) return undefined;
  const target = failure?.targetName;
  return target && !id.startsWith(`${target}/`) ? `${target}/${id}` : id;
}
