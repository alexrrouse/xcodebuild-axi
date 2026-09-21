import { AxiError, mapXcodebuildError } from "../errors.js";
import { requireProject } from "../context.js";
import { requireScheme } from "../scheme.js";
import { destinationSlug, resolveDestination } from "../destination.js";
import { runBuild } from "../xcodebuild.js";
import {
  describeDevice,
  readBuildResults,
  readTestSummary,
  toDiagnostics,
  type TestSummary,
} from "../xcresult.js";
import { diagnosticsBlock, transcriptTail } from "../report.js";
import {
  duration,
  renderFields,
  renderHelp,
  renderList,
  renderOutput,
  tildePath,
  truncate,
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
flags[9]:
  --scheme <name>        scheme to test (required only when the project has more than one)
  --device <name>        simulator name, e.g. "iPhone 17 Pro" (default: newest simulator)
  --destination <spec>   raw xcodebuild destination specifier, passed through untouched
  --test-plan <name>     test plan to run
  --only <id>            run only this test/class/target; repeatable or comma-separated
  --skip <id>            skip this test/class/target; repeatable or comma-separated
  --test-timeout <secs>  per-test execution allowance (default: 300, 0 disables)
  --max-failures <n>     failures to list before summarizing the rest (default: 20)
  --full                 show untruncated failure text
exit:
  0 all tests passed, 1 a test or the build failed, 2 usage error
examples:
  xcodebuild-axi test
  xcodebuild-axi test --scheme Futures --device "iPhone 17 Pro"
  xcodebuild-axi test --scheme Tides --only TidesTests/TideChartTests
`;

const FLAGS = [
  "--scheme",
  "--device",
  "--destination",
  "--test-plan",
  "--only",
  "--skip",
  "--test-timeout",
  "--max-failures",
  "--full",
] as const;

const VALUE_FLAGS = [
  "--scheme",
  "--device",
  "--destination",
  "--test-plan",
  "--only",
  "--skip",
  "--test-timeout",
  "--max-failures",
] as const;

export async function testCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "test", FLAGS, VALUE_FLAGS);

  const project = requireProject();
  const scheme = await requireScheme(
    project,
    getFlag(args, "--scheme"),
    "test",
  );
  const destination = await resolveDestination({
    project,
    scheme,
    ...(getFlag(args, "--device") !== undefined
      ? { device: getFlag(args, "--device") as string }
      : {}),
    ...(getFlag(args, "--destination") !== undefined
      ? { raw: getFlag(args, "--destination") as string }
      : {}),
  });

  const testPlan = getFlag(args, "--test-plan");
  const only = getListFlag(args, "--only");
  const skip = getListFlag(args, "--skip");
  const timeout = getIntFlag(args, "--test-timeout") ?? 300;
  const maxFailures = getIntFlag(args, "--max-failures") ?? 20;
  const full = hasFlag(args, "--full");

  const xcodebuildArgs = [
    ...project.flags,
    "-scheme",
    scheme,
    "-destination",
    destination.specifier,
    ...(testPlan ? ["-testPlan", testPlan] : []),
    ...only.flatMap((id) => ["-only-testing", id]),
    ...skip.flatMap((id) => ["-skip-testing", id]),
    "-skipMacroValidation",
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
    "CODE_SIGNING_ALLOWED=NO",
    "test",
  ];

  const run = await runBuild({
    args: xcodebuildArgs,
    label: `${scheme}-${destinationSlug(destination.described)}-test`,
    project,
  });

  const summary = await readTestSummary(run.resultPath).catch(() => undefined);

  // No test summary on a nonzero exit means the tests never ran — the build
  // under them failed, or xcodebuild refused the invocation. Report that as a
  // build failure rather than "0 tests", which reads like a passing run.
  if (!summary || summary.totalTestCount === undefined) {
    return renderTestsNeverRan({
      scheme,
      destination: destination.described,
      run,
      maxFailures,
    });
  }

  return renderTestSummary({
    scheme,
    destination: destination.described,
    summary,
    run,
    maxFailures,
    full,
  });
}

interface TestsNeverRanOptions {
  scheme: string;
  destination: string;
  run: {
    exitCode: number;
    logPath: string;
    resultPath: string;
    seconds: number;
    tail: string;
  };
  maxFailures: number;
}

async function renderTestsNeverRan(
  options: TestsNeverRanOptions,
): Promise<string> {
  const { run } = options;
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
      scheme: options.scheme,
      destination: options.destination,
      duration: duration(run.seconds),
    }),
  ];

  const errorBlock = diagnosticsBlock("errors", errors, options.maxFailures);
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
  scheme: string;
  destination: string;
  summary: TestSummary;
  run: {
    exitCode: number;
    logPath: string;
    resultPath: string;
    seconds: number;
    tail: string;
  };
  maxFailures: number;
  full: boolean;
}

function renderTestSummary(options: RenderTestSummaryOptions): string {
  const { summary, run } = options;
  const failed = summary.failedTests ?? 0;
  const passed = summary.passedTests ?? 0;
  const skipped = summary.skippedTests ?? 0;
  const succeeded = run.exitCode === 0 && failed === 0;

  // Report the destination the run actually landed on, not the one requested:
  // a name-based specifier can resolve to a different runtime than expected,
  // and a pass on the wrong OS is a pass the agent should not trust.
  const device = summary.devicesAndConfigurations?.[0]?.device;
  const landed = device ? describeDevice(device) : options.destination;

  const blocks: string[] = [
    renderFields({
      test: succeeded ? "passed" : "failed",
      scheme: options.scheme,
      destination: landed,
      // Slash-separated, not comma-separated: TOON quotes any scalar
      // containing a comma, and the quotes cost more than the commas saved.
      tests: `${passed} passed / ${failed} failed / ${skipped} skipped`,
      duration: duration(run.seconds),
    }),
  ];

  const failures = summary.testFailures ?? [];
  if (failures.length > 0) {
    const shown = failures.slice(0, options.maxFailures).map((failure) => ({
      test: failure.testIdentifierString ?? failure.testName ?? "unknown",
      target: failure.targetName ?? "",
      message: options.full
        ? (failure.failureText ?? "").replace(/\s+/g, " ").trim()
        : truncate((failure.failureText ?? "").replace(/\s+/g, " ").trim(), 300)
            .text,
    }));
    const label =
      failures.length > shown.length
        ? `failures (${shown.length} of ${failures.length})`
        : "failures";
    blocks.push(renderList(label, shown));
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
  if (failures.length > 0) {
    const first = failures[0]?.testIdentifierString;
    if (first) {
      hints.push(
        `Run \`xcodebuild-axi test --only ${first}\` to re-run just this failure`,
      );
    }
    hints.push(
      `Run \`xcodebuild-axi result ${tildePath(run.resultPath)} --failures --full\` for untruncated failure text`,
    );
  }
  blocks.push(renderHelp(hints));

  if (!succeeded) process.exitCode = 1;
  return renderOutput(blocks);
}
