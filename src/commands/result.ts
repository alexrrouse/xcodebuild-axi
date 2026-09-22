import { AxiError } from "../errors.js";
import { resolve } from "node:path";
import {
  describeDevice,
  readActivities,
  readBuildResults,
  readBundleMetadata,
  readContentAvailability,
  readInsights,
  readLog,
  readMetrics,
  readTests,
  readTestSummary,
  toDiagnostics,
  type ActivityNode,
  type BuildResults,
  type BundleMetadata,
  type ContentAvailability,
  type Insight,
  type LogSection,
  type TestInsights,
  type TestMetric,
  type TestNode,
  type TestActivities,
  type TestTree,
} from "../xcresult.js";
import { diagnosticsBlock, failureRows } from "../report.js";
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
  hasFlag,
  positionals,
  rejectUnknownFlags,
} from "../args.js";

export const RESULT_HELP = `usage: xcodebuild-axi result <path.xcresult> [flags]
Re-reads a result bundle that a previous run wrote, without rebuilding.
flags[12]:
  --failures     failures and errors only
  --warnings     include the full warning list
  --tests        every test the run recorded, as the tree Xcode groups them into
  --insights     Xcode's own diagnosis: what failed together, and what was slow
  --activities   what one test did, step by step; needs --test
  --metrics      what the performance tests measured; --test narrows it
  --log <type>   the stored build, action, or console log, as timed sections
  --available    what this bundle holds at all: coverage, logs, test results
  --metadata     when the bundle was written, and in what format
  --test <id>    the test --activities or --metrics is about
  --max <n>      rows to list before summarizing the rest (default: 20)
  --full         untruncated messages
note:
  Everything here reads the bundle a run already wrote, so none of it rebuilds
  anything. --available is the cheapest first question about a bundle from
  somewhere else: it says whether there is coverage or a log to ask for,
  instead of letting you find out by failing to read one.
examples:
  xcodebuild-axi result ~/Library/Caches/xcodebuild-axi/MyApps-1a2b3c4d/MyApp-iPhone-17-Pro-test.xcresult
  xcodebuild-axi result build/MyApp.xcresult --failures --full
  xcodebuild-axi result build/MyApp.xcresult --log build --max 10
  xcodebuild-axi result build/MyApp.xcresult --activities --test MyAppTests/CheckoutTests/testTotal
`;

export const RESULT_FLAGS = [
  "--failures",
  "--warnings",
  "--tests",
  "--insights",
  "--activities",
  "--metrics",
  "--log",
  "--available",
  "--metadata",
  "--test",
  "--max",
  "--full",
] as const;

const VALUE_FLAGS = ["--max", "--log", "--test"] as const;

export async function resultCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "result", RESULT_FLAGS, VALUE_FLAGS);

  const [rawPath] = positionals(args, VALUE_FLAGS);
  if (rawPath === undefined) {
    throw new AxiError(
      "result needs a path to an .xcresult bundle",
      "VALIDATION_ERROR",
      [
        "xcodebuild-axi result <path.xcresult>",
        "`xcodebuild-axi build` and `test` each print the path they wrote",
      ],
    );
  }

  const path = resolve(expandTilde(rawPath));
  const max = getIntFlag(args, "--max") ?? 20;
  const full = hasFlag(args, "--full");
  const failuresOnly = hasFlag(args, "--failures");

  const mode = soleMode(args);
  if (mode) return readMode(mode, path, args, max);

  const [summary, build] = await Promise.all([
    readTestSummary(path).catch(() => undefined),
    readBuildResults(path).catch(() => undefined),
  ]);

  if (!summary && !build) {
    throw new AxiError(
      `Nothing readable in the bundle at ${rawPath}`,
      "RESULT_NOT_FOUND",
    );
  }

  const blocks: string[] = [];

  // `xcresulttool` answers the test-shaped query for *any* bundle, so a build
  // comes back as `{title: "Test - X", totalTestCount: 0, result: "unknown"}`
  // rather than as nothing. Reading that as a verdict rendered a build as
  // `result: unknown / title: Test - X / 0 passed / 0 failed`, which is the
  // shape of a clean pass. `home.ts` fixed the same misread by trusting the
  // name `runLabel` gave the bundle, but `result` takes an arbitrary path --
  // its own help offers `build/MyApp.xcresult` -- so the name proves nothing
  // here and the count is the discriminator instead.
  if (summary && (summary.totalTestCount ?? 0) > 0) {
    const device = summary.devicesAndConfigurations?.[0]?.device;
    blocks.push(
      renderFields({
        result: summary.result?.toLowerCase() ?? "unknown",
        title: summary.title ?? "",
        destination: describeDevice(device),
        tests: `${summary.passedTests ?? 0} passed / ${summary.failedTests ?? 0} failed / ${summary.skippedTests ?? 0} skipped`,
        duration:
          summary.startTime !== undefined && summary.finishTime !== undefined
            ? duration(summary.finishTime - summary.startTime)
            : "unknown",
      }),
    );

    const failures = summary.testFailures ?? [];
    if (failures.length > 0) {
      const shown = await failureRows(path, failures, { max, full });
      blocks.push(
        renderList(
          failures.length > shown.length
            ? `failures (${shown.length} of ${failures.length})`
            : "failures",
          shown,
        ),
      );
    } else if (failuresOnly) {
      blocks.push(renderFields({ failures: "0 test failures in this bundle" }));
    }
  } else if (build) {
    blocks.push(renderFields(buildFields(build)));
  }

  if (build) {
    const errors = toDiagnostics(build.errors);
    const warnings = toDiagnostics([
      ...(build.warnings ?? []),
      ...(build.analyzerWarnings ?? []),
    ]);

    if (errors.length > 0) {
      blocks.push(
        diagnosticsBlock("errors", errors, max, full ? 4000 : 300).block,
      );
    }

    if (!failuresOnly) {
      if (warnings.length > 0 && hasFlag(args, "--warnings")) {
        blocks.push(
          diagnosticsBlock("warnings", warnings, max, full ? 4000 : 300).block,
        );
      } else if (warnings.length > 0) {
        blocks.push(renderFields({ warnings: warnings.length }));
      }
    }
  }

  blocks.push(renderFields({ bundle: tildePath(path) }));

  const hints: string[] = [];
  if (
    !hasFlag(args, "--warnings") &&
    (build?.warningCount ?? 0) > 0 &&
    !failuresOnly
  ) {
    hints.push(
      `Run \`xcodebuild-axi result ${rawPath} --warnings\` to list them`,
    );
  }
  blocks.push(renderHelp(hints));

  return renderOutput(blocks);
}

/** The one read this invocation is for, if it is not the default report. */
const MODES = [
  "--tests",
  "--insights",
  "--activities",
  "--metrics",
  "--log",
  "--available",
  "--metadata",
] as const;

/**
 * These answer different questions from each other and from the default
 * report, so two at once would print two reports and call it one answer.
 */
function soleMode(args: string[]): (typeof MODES)[number] | undefined {
  const asked = MODES.filter((mode) => args.includes(mode));
  if (asked.length > 1) {
    throw new AxiError(
      `${asked.join(" and ")} ask different questions — pass one`,
      "VALIDATION_ERROR",
      [`each is its own read of the bundle: ${MODES.join(", ")}`],
    );
  }
  return asked[0];
}

async function readMode(
  mode: (typeof MODES)[number],
  path: string,
  args: string[],
  max: number,
): Promise<string> {
  const bundle = renderFields({ bundle: tildePath(path) });

  switch (mode) {
    case "--tests":
      return reportTests(await readTests(path), max, bundle);
    case "--insights":
      return reportInsights(await readInsights(path), max, bundle);
    case "--activities":
      return reportActivities(
        await readActivities(path, requireTest(args, "--activities")),
        max,
        bundle,
      );
    case "--metrics":
      return reportMetrics(
        await readMetrics(path, getFlag(args, "--test")),
        max,
        bundle,
      );
    case "--log":
      return reportLog(
        await readLog(path, logType(args)),
        logType(args),
        max,
        bundle,
      );
    case "--available":
      return reportAvailability(await readContentAvailability(path), bundle);
    case "--metadata":
      return reportMetadata(await readBundleMetadata(path), bundle);
  }
}

function requireTest(args: string[], mode: string): string {
  const test = getFlag(args, "--test");
  if (test === undefined) {
    throw new AxiError(`${mode} is about one test`, "VALIDATION_ERROR", [
      `xcodebuild-axi result <path.xcresult> ${mode} --test MyAppTests/CheckoutTests/testTotal`,
      "Run `xcodebuild-axi result <path.xcresult> --tests` to see the identifiers",
    ]);
  }
  return test;
}

const LOG_TYPES = ["build", "action", "console"] as const;

function logType(args: string[]): string {
  const type = getFlag(args, "--log") ?? "build";
  if (!LOG_TYPES.includes(type as (typeof LOG_TYPES)[number])) {
    throw new AxiError(`Unknown log type '${type}'`, "VALIDATION_ERROR", [
      `valid types: ${LOG_TYPES.join(", ")}`,
    ]);
  }
  return type;
}

/**
 * The test tree, flattened to one row per test case.
 *
 * Xcode nests plan -> target -> suite -> case, and printing that as a tree
 * costs more tokens than it explains. The identifier already carries the
 * hierarchy, so the rows carry the identifier and the verdict.
 */
export function flattenTests(
  nodes: TestNode[] | undefined,
): Array<{ test: string; result: string; duration: string }> {
  const rows: Array<{ test: string; result: string; duration: string }> = [];
  const walk = (node: TestNode): void => {
    if (node.nodeType === "Test Case") {
      rows.push({
        test: node.nodeIdentifier ?? node.name ?? "",
        result: (node.result ?? "").toLowerCase(),
        duration: node.duration ?? "",
      });
    }
    for (const child of node.children ?? []) walk(child);
  };
  for (const node of nodes ?? []) walk(node);
  return rows;
}

function reportTests(tree: TestTree, max: number, bundle: string): string {
  const rows = flattenTests(tree.testNodes);
  if (rows.length === 0) {
    return renderOutput([
      renderFields({ tests: "none — this bundle recorded no tests" }),
      bundle,
    ]);
  }

  // A failing test is the reason anyone asks, so it is never the row that
  // gets cut when the list is capped.
  const ordered = [
    ...rows.filter((row) => row.result !== "passed"),
    ...rows.filter((row) => row.result === "passed"),
  ];
  const shown = ordered.slice(0, max);
  const device = tree.devices?.[0];

  return renderOutput([
    renderFields({
      tests: rows.length,
      failed: rows.filter((row) => row.result === "failed").length,
      ...(device ? { destination: describeDevice(device) } : {}),
    }),
    renderList(
      rows.length > shown.length
        ? `test_list (${shown.length} of ${rows.length})`
        : "test_list",
      shown,
    ),
    bundle,
    renderHelp(
      rows.length > shown.length
        ? [`Run the same command with \`--max ${rows.length}\` for all of them`]
        : [],
    ),
  ]);
}

function reportInsights(
  insights: TestInsights,
  max: number,
  bundle: string,
): string {
  const groups: Array<[string, Insight[] | undefined]> = [
    ["common_failures", insights.commonFailureInsights],
    ["failure_distribution", insights.failureDistributionInsights],
    ["longest_runs", insights.longestTestRunsInsights],
  ];

  const blocks = groups.flatMap(([name, items]) =>
    items && items.length > 0
      ? [
          renderList(
            name,
            items.slice(0, max).map((item) => ({
              insight: item.text ?? item.testName ?? item.category ?? "",
              ...(item.impact ? { impact: item.impact } : {}),
              ...(item.totalDuration !== undefined
                ? { duration: duration(item.totalDuration) }
                : {}),
            })),
          ),
        ]
      : [],
  );

  if (blocks.length === 0) {
    // Xcode returning three empty lists is an answer: it found nothing worth
    // saying, which is not the same as this command failing to ask.
    return renderOutput([
      renderFields({ insights: "none — Xcode found nothing to report" }),
      bundle,
    ]);
  }
  return renderOutput([...blocks, bundle]);
}

function reportActivities(
  activities: TestActivities,
  max: number,
  bundle: string,
): string {
  const rows: Array<{ step: string; depth: number }> = [];
  const walk = (node: ActivityNode, depth: number): void => {
    if (node.title) rows.push({ step: node.title, depth });
    for (const child of node.childActivities ?? []) walk(child, depth + 1);
  };
  for (const run of activities.testRuns ?? []) {
    for (const activity of run.activities ?? []) walk(activity, 0);
  }

  const shown = rows.slice(0, max);
  return renderOutput([
    renderFields({
      test: activities.testName ?? activities.testIdentifier ?? "",
      steps: rows.length,
    }),
    rows.length > 0
      ? renderList(
          rows.length > shown.length
            ? `activities (${shown.length} of ${rows.length})`
            : "activities",
          shown,
        )
      : renderFields({ activities: "none recorded for this test" }),
    bundle,
  ]);
}

function reportMetrics(
  metrics: TestMetric[],
  max: number,
  bundle: string,
): string {
  const rows = metrics.flatMap((metric) =>
    (metric.measurements ?? []).map((measurement) => ({
      test: metric.testName ?? metric.testIdentifier ?? "",
      metric: measurement.displayName ?? "",
      value: measurement.average ?? "",
      unit: measurement.unit ?? "",
      baseline: measurement.baselineAverage ?? "",
    })),
  );

  if (rows.length === 0) {
    return renderOutput([
      renderFields({
        metrics: "none — no performance measurements in this bundle",
      }),
      bundle,
      renderHelp([
        "Performance metrics come from XCTMetric tests; a plain test run records none",
      ]),
    ]);
  }

  const shown = rows.slice(0, max);
  return renderOutput([
    renderList(
      rows.length > shown.length
        ? `metrics (${shown.length} of ${rows.length})`
        : "metrics",
      shown,
    ),
    bundle,
  ]);
}

/**
 * The stored log, as the timed tree it is rather than as text.
 *
 * The transcript on disk is the same content as a flat stream; what the bundle
 * adds is which section took how long, which is the question worth a
 * subprocess -- the slowest step of a build, without rebuilding it.
 */
function reportLog(
  log: LogSection,
  type: string,
  max: number,
  bundle: string,
): string {
  // Sorted on the seconds rather than on the formatted string: `1m16s`
  // parses as 1, so a minute-long section would rank below a five-second one.
  const sections = (log.subsections ?? [])
    .map((section) => ({
      section: section.title ?? "",
      seconds: section.duration ?? 0,
      result: (section.result ?? "").toLowerCase(),
    }))
    .sort((a, b) => b.seconds - a.seconds);
  const shown = sections.slice(0, max).map(({ section, seconds, result }) => ({
    section,
    duration: duration(seconds),
    result,
  }));

  return renderOutput([
    renderFields({
      log: type,
      result: (log.result ?? "unknown").toLowerCase(),
      duration: duration(log.duration ?? 0),
      sections: sections.length,
    }),
    sections.length > 0
      ? renderList(
          sections.length > shown.length
            ? `slowest (${shown.length} of ${sections.length})`
            : "sections",
          shown,
        )
      : renderFields({ sections: "none recorded" }),
    bundle,
  ]);
}

function reportAvailability(
  available: ContentAvailability,
  bundle: string,
): string {
  return renderOutput([
    renderFields({
      test_results: available.hasTestResults === true,
      coverage: available.hasCoverage === true,
      diagnostics: available.hasDiagnostics === true,
      logs: available.logs ?? [],
    }),
    bundle,
  ]);
}

function reportMetadata(metadata: BundleMetadata, bundle: string): string {
  return renderOutput([
    renderFields({
      created: metadata.dateCreated ?? "unknown",
      format: `${metadata.version?.major ?? "?"}.${metadata.version?.minor ?? "?"}`,
      ...(metadata.storage?.backend
        ? { storage: metadata.storage.backend }
        : {}),
      ...(metadata.storage?.compression
        ? { compression: metadata.storage.compression }
        : {}),
      external_locations: (metadata.externalLocations ?? []).length,
    }),
    bundle,
  ]);
}

/**
 * The header a non-test bundle reports. A build bundle carries every field the
 * test-shaped query lacks: `actionTitle` names the action xcodebuild ran,
 * `status` is the verdict it recorded, and `destination` is the device it
 * actually landed on.
 */
export function buildFields(build: BuildResults): Record<string, string> {
  return {
    result: build.status?.toLowerCase() ?? "unknown",
    title: build.actionTitle ?? "",
    destination: describeDevice(build.destination),
    duration:
      build.startTime !== undefined && build.endTime !== undefined
        ? duration(build.endTime - build.startTime)
        : "unknown",
  };
}

function expandTilde(path: string): string {
  const home = process.env["HOME"];
  return home && path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}
