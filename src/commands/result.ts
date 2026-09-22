import { AxiError } from "../errors.js";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { exportDir, mergedBundlePath } from "../xcodebuild.js";
import {
  describeDevice,
  exportBundle,
  EXPORT_KINDS,
  mergeBundles,
  readComparison,
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
  type AttachmentManifestEntry,
  type BuildResults,
  type BundleMetadata,
  type ContentAvailability,
  type CountDelta,
  type Differential,
  type DifferentialIssue,
  type ExportKind,
  type Insight,
  type LogSection,
  type MetricsManifestEntry,
  type TestFailureDelta,
  type TestReference,
  type TestInsights,
  type TestMetric,
  type TestNode,
  type TestActivities,
  type TestTree,
} from "../xcresult.js";
import { diagnosticsBlock, failureRows } from "../report.js";
import {
  byteSize,
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
  hasFlag,
  positionals,
  rejectUnknownFlags,
} from "../args.js";

export const RESULT_HELP = `usage: xcodebuild-axi result <path.xcresult> [flags]
Re-reads a result bundle that a previous run wrote, without rebuilding.
flags[17]:
  --failures     failures and errors only
  --warnings     include the full warning list
  --tests        every test the run recorded, as the tree Xcode groups them into
  --insights     Xcode's own diagnosis: what failed together, and what was slow
  --activities   what one test did, step by step; needs --test
  --metrics      what the performance tests measured; --test narrows it
  --log <type>   the stored build, action, or console log, as timed sections
  --available    what this bundle holds at all: coverage, logs, test results
  --metadata     when the bundle was written, and in what format
  --export <what> write part of the bundle out: attachments, diagnostics,
                 metrics, or evaluations
  --against <path> compare this run to a baseline bundle: what broke, what
                 got fixed, which tests came and went
  --merge        combine two or more bundles into one, for a sharded run
  --to <path>    where --export or --merge writes (default: under
                 ~/Library/Caches)
  --test <id>    the test --activities, --metrics or --export is about
  --filter <glob> with --export attachments: filenames to keep, e.g. '*.png'
  --max <n>      rows to list before summarizing the rest (default: 20)
  --full         untruncated messages
note:
  Everything here reads the bundle a run already wrote, so none of it rebuilds
  anything. --available is the cheapest first question about a bundle from
  somewhere else: it says whether there is coverage or a log to ask for,
  instead of letting you find out by failing to read one.

  --export writes files rather than printing them, so it reports what landed
  and where. --failures narrows attachments and evaluations to what a failing
  test produced, which is usually all anyone wants out of a green run's
  hundreds of screenshots.

  --against answers 'is this worse than before' in one call: a failure the
  baseline did not have is what a CI check is looking for, and it is reported
  ahead of everything else.
examples:
  xcodebuild-axi result ~/Library/Caches/xcodebuild-axi/MyApps-1a2b3c4d/MyApp-iPhone-17-Pro-test.xcresult
  xcodebuild-axi result build/MyApp.xcresult --failures --full
  xcodebuild-axi result build/MyApp.xcresult --log build --max 10
  xcodebuild-axi result build/MyApp.xcresult --activities --test MyAppTests/CheckoutTests/testTotal
  xcodebuild-axi result build/MyApp.xcresult --export attachments --failures
  xcodebuild-axi result build/MyApp.xcresult --against build/baseline.xcresult
  xcodebuild-axi result shard1.xcresult shard2.xcresult --merge
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
  "--export",
  "--against",
  "--merge",
  "--to",
  "--test",
  "--filter",
  "--max",
  "--full",
] as const;

const VALUE_FLAGS = [
  "--max",
  "--log",
  "--test",
  "--export",
  "--against",
  "--to",
  "--filter",
] as const;

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
  "--export",
  "--against",
  "--merge",
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
    case "--export":
      return runExport(path, args, max, bundle);
    case "--against":
      return reportComparison(
        await readComparison(path, baselineOf(args)),
        args,
        max,
        bundle,
      );
    case "--merge":
      return runMerge(args, max);
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
 * `--export`, which writes files instead of printing them.
 *
 * The shape of the answer is therefore what landed and where, rather than the
 * content: a screenshot is not something to render into a terminal, but the
 * path to one is exactly what the next tool call needs.
 */
async function runExport(
  path: string,
  args: string[],
  max: number,
  bundle: string,
): Promise<string> {
  const kind = exportKind(args);
  const requested = getFlag(args, "--to");
  const outputPath = requested
    ? resolve(expandTilde(requested))
    : exportDir(path, kind);
  const testId = getFlag(args, "--test");
  const filter = getFlag(args, "--filter");
  const onlyFailures = hasFlag(args, "--failures");

  // Refused rather than dropped, because each of these changes what comes out.
  // Passing --filter to a diagnostics export and getting everything back is a
  // wrong answer that looks like a right one.
  if (filter !== undefined && kind !== "attachments") {
    throw new AxiError(
      `--filter narrows attachments by filename, and ${kind} has none`,
      "VALIDATION_ERROR",
      ["Drop --filter, or export attachments"],
    );
  }
  if (testId !== undefined && kind === "diagnostics") {
    throw new AxiError(
      "A diagnostics report covers the whole run, not one test",
      "VALIDATION_ERROR",
      ["Drop --test, or export attachments, metrics or evaluations"],
    );
  }
  if (onlyFailures && (kind === "diagnostics" || kind === "metrics")) {
    throw new AxiError(
      `--failures narrows an export to what a failing test produced, and ${kind} is not per-test`,
      "VALIDATION_ERROR",
      ["Drop --failures, or export attachments or evaluations"],
    );
  }

  await exportBundle({
    path,
    kind,
    outputPath,
    ...(testId !== undefined ? { testId } : {}),
    ...(filter !== undefined ? { filter } : {}),
    onlyFailures,
  });

  const files = walkFiles(outputPath).filter(
    (file) => basename(file.path) !== MANIFEST,
  );
  const to = renderFields({ to: tildePath(outputPath) });

  if (files.length === 0) {
    return renderOutput([
      renderFields({
        export: kind,
        files: `none — this bundle holds no ${kind}${describeNarrowing(testId, filter, onlyFailures)}`,
      }),
      bundle,
      renderHelp([
        "Run `xcodebuild-axi result <path> --available` to see what this bundle holds",
        ...(kind === "attachments"
          ? [
              "Xcode keeps attachments only when the test asks it to, or when the test failed",
            ]
          : []),
      ]),
    ]);
  }

  // The manifest is what ties an exported filename back to the test that made
  // it. When it is missing or says nothing -- an older bundle, or a directory
  // reused for a second export -- the files that are actually there are still
  // a true answer, and a truer one than an empty table.
  const named = kind === "diagnostics" ? [] : manifestRows(outputPath, kind);
  const rows =
    kind === "diagnostics"
      ? diagnosticRows(outputPath)
      : named.length > 0
        ? named
        : files.map((file) => ({
            file: relative(outputPath, file.path),
            size: byteSize(file.bytes),
          }));
  const shown = rows.slice(0, max);

  return renderOutput([
    renderFields({
      export: kind,
      files: files.length,
      size: byteSize(files.reduce((sum, file) => sum + file.bytes, 0)),
    }),
    to,
    renderList(
      rows.length > shown.length
        ? `exported (${shown.length} of ${rows.length})`
        : "exported",
      shown,
    ),
    bundle,
  ]);
}

/**
 * `--against`, which is the question CI actually asks: not "did this run
 * fail" but "did it fail in a way the last one did not".
 *
 * A failure the baseline did not have is reported ahead of everything else,
 * because it is the only part of a comparison that stops a merge.
 */
function reportComparison(
  differential: Differential | null,
  args: string[],
  max: number,
  bundle: string,
): string {
  const baseline = renderFields({ baseline: tildePath(baselineOf(args)) });

  if (differential === null) {
    return renderOutput([
      renderFields({
        compare: "nothing comparable — these two bundles hold different things",
      }),
      baseline,
      bundle,
      renderHelp([
        "Run `xcodebuild-axi result <path> --available` on each to see what they hold",
        "A build bundle and a test bundle have no common ground to compare",
      ]),
    ]);
  }

  const summary = differential.summary ?? {};
  const tests = summary.testsExecuted ?? {};
  const blocks = [
    renderFields({
      tests: `${tests.itemsInBaseline ?? 0} → ${tests.itemsInCurrent ?? 0}`,
      added: tests.added ?? 0,
      removed: tests.removed ?? 0,
      failures: deltaField(summary.testFailures),
      warnings: deltaField(summary.buildWarnings),
      analyzer: deltaField(summary.analyzerIssues),
    }),
  ];

  const introduced = differential.testFailures?.introduced ?? [];
  const resolved = differential.testFailures?.resolved ?? [];
  if (introduced.length > 0) {
    blocks.push(cappedList("newly_failing", failureDeltaRows(introduced), max));
  }
  if (resolved.length > 0) {
    blocks.push(cappedList("now_passing", failureDeltaRows(resolved), max));
  }

  const added = differential.testsExecuted?.added ?? [];
  const removed = differential.testsExecuted?.removed ?? [];
  if (added.length > 0) {
    blocks.push(cappedList("added_tests", testRefRows(added), max));
  }
  if (removed.length > 0) {
    blocks.push(cappedList("removed_tests", testRefRows(removed), max));
  }

  const newWarnings = [
    ...(differential.buildWarnings?.introduced ?? []),
    ...(differential.analyzerIssues?.introduced ?? []),
  ];
  if (newWarnings.length > 0) {
    blocks.push(cappedList("new_warnings", issueRows(newWarnings), max));
  }

  if (blocks.length === 1) {
    blocks.push(
      renderFields({ difference: "none — this run matches the baseline" }),
    );
  }

  return renderOutput([...blocks, baseline, bundle]);
}

function baselineOf(args: string[]): string {
  const against = getFlag(args, "--against");
  if (against === undefined) {
    throw new AxiError(
      "--against needs the baseline bundle to compare with",
      "VALIDATION_ERROR",
      ["xcodebuild-axi result <path.xcresult> --against <baseline.xcresult>"],
    );
  }
  return resolve(expandTilde(against));
}

/** "0 → 2 (+2 -0)", which says both the level and the direction. */
export function deltaField(delta: CountDelta | undefined): string {
  const before = delta?.itemsInBaseline ?? 0;
  const after = delta?.itemsInCurrent ?? 0;
  return `${before} → ${after} (+${delta?.introduced ?? 0} -${delta?.resolved ?? 0})`;
}

export function failureDeltaRows(
  deltas: TestFailureDelta[],
): Array<Record<string, unknown>> {
  return deltas.map((delta) => ({
    test:
      delta.associatedTest?.testIdentifier ?? delta.associatedTest?.name ?? "",
    message: truncate(delta.failureMessage ?? "", 300).text,
  }));
}

function testRefRows(refs: TestReference[]): Array<Record<string, unknown>> {
  return refs.map((ref) => ({ test: ref.testIdentifier ?? ref.name ?? "" }));
}

function issueRows(
  issues: DifferentialIssue[],
): Array<Record<string, unknown>> {
  return issues.map((issue) => ({
    target: issue.producingTarget ?? "",
    message: truncate(issue.message ?? "", 300).text,
  }));
}

function cappedList(
  label: string,
  rows: Array<Record<string, unknown>>,
  max: number,
): string {
  const shown = rows.slice(0, max);
  return renderList(
    rows.length > shown.length
      ? `${label} (${shown.length} of ${rows.length})`
      : label,
    shown,
  );
}

/**
 * `--merge`, which is how a sharded test run gets one verdict.
 *
 * The merged bundle is read back afterwards rather than described from the
 * inputs: the point of merging is the combined counts, and reporting them from
 * the thing that was actually written is the only way they are true.
 */
async function runMerge(args: string[], max: number): Promise<string> {
  const paths = positionals(args, VALUE_FLAGS).map((path) =>
    resolve(expandTilde(path)),
  );
  if (paths.length < 2) {
    throw new AxiError(
      `--merge combines two or more bundles, and ${paths.length} was given`,
      "VALIDATION_ERROR",
      [
        "xcodebuild-axi result shard1.xcresult shard2.xcresult --merge",
        "Each `test` run prints the bundle path it wrote",
      ],
    );
  }

  const requested = getFlag(args, "--to");
  const outputPath = requested
    ? resolve(expandTilde(requested))
    : mergedBundlePath(paths);

  // A bundle the caller named is theirs, and xcresulttool will write straight
  // over it. The one under our own cache directory is ours to clear, which is
  // the same split `runBuild` makes about the bundle it writes.
  if (requested && existsSync(outputPath)) {
    throw new AxiError(
      `Something is already at ${tildePath(outputPath)}`,
      "VALIDATION_ERROR",
      [
        "Pass a path that does not exist yet, or drop --to to write under ~/Library/Caches",
      ],
    );
  }
  if (!requested) rmSync(outputPath, { recursive: true, force: true });
  mkdirSync(dirname(outputPath), { recursive: true });

  await mergeBundles(paths, outputPath);

  const merged = await readTestSummary(outputPath).catch(() => undefined);
  return renderOutput([
    renderFields({
      merged: paths.length,
      ...(merged && (merged.totalTestCount ?? 0) > 0
        ? {
            tests: `${merged.passedTests ?? 0} passed / ${merged.failedTests ?? 0} failed / ${merged.skippedTests ?? 0} skipped`,
            result: merged.result?.toLowerCase() ?? "unknown",
          }
        : {}),
      to: tildePath(outputPath),
    }),
    cappedList(
      "from",
      paths.map((path) => ({ bundle: tildePath(path) })),
      max,
    ),
    renderHelp([
      `Run \`xcodebuild-axi result ${tildePath(outputPath)}\` to report on the merged run`,
    ]),
  ]);
}

const MANIFEST = "manifest.json";

function exportKind(args: string[]): ExportKind {
  const what = getFlag(args, "--export");
  if (what === undefined || !EXPORT_KINDS.includes(what as ExportKind)) {
    throw new AxiError(
      what === undefined
        ? "--export needs to know what to write out"
        : `Nothing named '${what}' can be exported from a result bundle`,
      "VALIDATION_ERROR",
      [`what can be exported: ${EXPORT_KINDS.join(", ")}`],
    );
  }
  return what as ExportKind;
}

/** Say which narrowing produced an empty export, so it can be lifted. */
function describeNarrowing(
  testId: string | undefined,
  filter: string | undefined,
  onlyFailures: boolean,
): string {
  const applied = [
    testId ? `for '${testId}'` : undefined,
    filter ? `matching '${filter}'` : undefined,
    onlyFailures ? "from a failing test" : undefined,
  ].filter((part): part is string => part !== undefined);
  return applied.length > 0 ? ` ${applied.join(" ")}` : "";
}

/**
 * The manifest `xcresulttool` writes beside the files it exported, which is
 * the only thing that ties an exported filename back to the test that made it.
 */
export function manifestRows(
  outputPath: string,
  kind: ExportKind,
): Array<Record<string, unknown>> {
  const manifestPath = join(outputPath, MANIFEST);
  if (!existsSync(manifestPath)) return [];

  let entries: Array<AttachmentManifestEntry & MetricsManifestEntry>;
  try {
    entries = JSON.parse(readFileSync(manifestPath, "utf-8")) as Array<
      AttachmentManifestEntry & MetricsManifestEntry
    >;
  } catch {
    return [];
  }

  const rows: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    const test = entry.testIdentifier ?? "";
    for (const file of entry.metricsFiles ?? []) rows.push({ test, file });
    for (const attachment of entry.attachments ?? []) {
      rows.push({
        test,
        file: attachment.exportedFileName ?? "",
        name: attachment.suggestedHumanReadableName ?? "",
        ...(kind === "attachments"
          ? { failure: attachment.isAssociatedWithFailure === true }
          : {}),
      });
    }
  }
  return rows;
}

/**
 * A diagnostics export has no manifest — it is a directory per device per
 * action, each holding dozens of logs. One row per top-level directory says
 * what was collected without printing a file list nobody reads.
 */
function diagnosticRows(outputPath: string): Array<Record<string, unknown>> {
  return readdirSync(outputPath, { withFileTypes: true })
    .filter((entry) => entry.name !== MANIFEST)
    .map((entry) => {
      const full = join(outputPath, entry.name);
      const files = entry.isDirectory()
        ? walkFiles(full)
        : [{ path: full, bytes: sizeOf(full) }];
      return {
        report: entry.name,
        files: files.length,
        size: byteSize(files.reduce((sum, file) => sum + file.bytes, 0)),
      };
    })
    .sort((a, b) => String(a.report).localeCompare(String(b.report)));
}

function walkFiles(dir: string): Array<{ path: string; bytes: number }> {
  if (!existsSync(dir)) return [];
  const found: Array<{ path: string; bytes: number }> = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push({ path: full, bytes: sizeOf(full) });
    }
  };
  walk(dir);
  return found;
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
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
