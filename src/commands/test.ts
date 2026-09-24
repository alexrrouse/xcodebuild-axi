import { AxiError, mapXcodebuildError } from "../errors.js";
import {
  BUILD_FLAG_HELP,
  resolveBuildContext,
  runAction,
  SHARED_BUILD_FLAGS,
  SHARED_BUILD_VALUE_FLAGS,
  subjectField,
  type BuildContext,
} from "../action.js";
import {
  readBuildResults,
  readTestSummary,
  toDiagnostics,
  describeDevice,
  type BuildResults,
  type TestFailure,
  type TestSummary,
} from "../xcresult.js";
import { readCoverage, percent } from "../xccov.js";
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
flags[67]:
${BUILD_FLAG_HELP}
  --test-plan <name>     test plan to run
  --only <id>            run only this test/class/target; repeatable or comma-separated
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
exit:
  0 all tests passed, 1 a test or the build failed, 2 usage error
examples:
  xcodebuild-axi test
  xcodebuild-axi test --scheme MyApp --device "iPhone 17 Pro"
  xcodebuild-axi test --scheme MyApp --only MyAppTests/CheckoutTests
  xcodebuild-axi test --scheme MyApp --coverage
`;

export const TEST_FLAGS = [
  ...SHARED_BUILD_FLAGS,
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
  const context = await resolveBuildContext({ args, command: "test" });
  const coverage = hasFlag(args, "--coverage");

  const run = await runAction({
    context,
    command: "test",
    actions: [withoutBuilding ? "test-without-building" : "test"],
    extraArgs: testArgs(args, coverage),
  });

  const summary = await readTestSummary(run.resultPath).catch(() => undefined);
  // Only worth the second xcresulttool call when the summary counted nothing.
  const build =
    summary?.totalTestCount === 0
      ? await readBuildResults(run.resultPath).catch(() => undefined)
      : undefined;

  if (!summary || testsNeverRan(summary, build)) {
    return renderTestsNeverRan(context, run);
  }

  return renderTestSummary({
    context,
    summary,
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
  const errors = toDiagnostics(results?.errors);

  if (errors.length === 0) {
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
  process.exitCode = 1;
  return renderOutput(blocks);
}

interface RenderTestSummaryOptions {
  context: BuildContext;
  summary: TestSummary;
  run: BuildRun;
  maxFailures: number;
  full: boolean;
  coverage: boolean;
}

async function renderTestSummary(
  options: RenderTestSummaryOptions,
): Promise<string> {
  const { summary, run, context } = options;
  const failed = summary.failedTests ?? 0;
  const passed = summary.passedTests ?? 0;
  const skipped = summary.skippedTests ?? 0;
  const succeeded = run.exitCode === 0 && failed === 0;

  // Report the destination the run actually landed on, not the one requested:
  // a name-based specifier can resolve to a different runtime than expected,
  // and a pass on the wrong OS is a pass the agent should not trust.
  const device = summary.devicesAndConfigurations?.[0]?.device;
  const landed = device
    ? describeDevice(device)
    : (context.destination ?? "unknown");

  const coverageReport = options.coverage
    ? await readCoverage(run.resultPath).catch(() => undefined)
    : undefined;

  const blocks: string[] = [
    renderFields({
      test: succeeded ? "passed" : "failed",
      ...subjectField(context),
      destination: landed,
      // Slash-separated, not comma-separated: TOON quotes any scalar
      // containing a comma, and the quotes cost more than the commas saved.
      tests: `${passed} passed / ${failed} failed / ${skipped} skipped`,
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
  // xcodebuild fails a run whose filters matched nothing, and says only that
  // it failed. Name the cause, since "0 passed / 0 failed" reads like a crash.
  if (passed + failed + skipped === 0) {
    hints.push(
      "No tests ran — an --only or --skip identifier matched nothing. They are spelled Target/Class/method",
      `Run \`xcodebuild-axi tests ${context.subject.rerun}\` for the identifiers this scheme has`,
    );
  }
  if (failures.length > 0) {
    const first = rerunIdentifier(failures[0]);
    if (first) {
      hints.push(
        `Run \`xcodebuild-axi test ${context.subject.rerun} --only ${first}\` to re-run just this failure`,
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

/**
 * The identifier `-only-testing` needs for one failure.
 *
 * `testIdentifierString` omits the test target (`CheckoutTests/testFails()`),
 * and `-only-testing` without one matches nothing — the run then reports zero
 * tests and a failure with no reason. The target lives beside it in
 * `targetName`, so the two are joined here. The trailing `()` is dropped for
 * readability; xcodebuild accepts either spelling.
 */
export function rerunIdentifier(
  failure: TestFailure | undefined,
): string | undefined {
  const id = failure?.testIdentifierString?.replace(/\(\)$/, "");
  if (!id) return undefined;
  const target = failure?.targetName;
  return target && !id.startsWith(`${target}/`) ? `${target}/${id}` : id;
}
