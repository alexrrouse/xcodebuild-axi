import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { relative } from "node:path";
import { AxiError } from "./errors.js";

/**
 * Structured reads of an .xcresult bundle.
 *
 * This is the whole reason the tool can be small: xcodebuild's transcript is
 * megabytes of noise, but the bundle it writes alongside carries the same
 * answers as a few KB of JSON — pass/fail counts, per-device breakdown, and
 * every diagnostic with a precise source location.
 */

const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export interface TestDevice {
  deviceName?: string;
  modelName?: string;
  platform?: string;
  osVersion?: string;
  architecture?: string;
  deviceId?: string;
}

export interface TestFailure {
  testName?: string;
  targetName?: string;
  failureText?: string;
  testIdentifierString?: string;
}

export interface TestSummary {
  title?: string;
  result?: string;
  totalTestCount?: number;
  passedTests?: number;
  failedTests?: number;
  skippedTests?: number;
  expectedFailures?: number;
  startTime?: number;
  finishTime?: number;
  environmentDescription?: string;
  testFailures?: TestFailure[];
  runtimeWarnings?: RawIssue[];
  devicesAndConfigurations?: {
    device?: TestDevice;
    passedTests?: number;
    failedTests?: number;
    skippedTests?: number;
  }[];
}

/** A node of the tree `test-details` returns for one test. */
export interface TestNode {
  nodeType?: string;
  name?: string;
  /** `Target/Suite/testName()`, the identifier `--only` and `--test` take. */
  nodeIdentifier?: string;
  result?: string;
  /** Pre-formatted by xcresulttool, e.g. `0.028s`. */
  duration?: string;
  sourceLocation?: { filePath?: string; lineNumber?: number };
  children?: TestNode[];
}

export interface TestDetails {
  testIdentifier?: string;
  testName?: string;
  testResult?: string;
  testRuns?: TestNode[];
}

/** `get test-results tests` — the whole tree of what ran. */
export interface TestTree {
  devices?: TestDevice[];
  testNodes?: TestNode[];
}

/** `get test-results activities` — what one test did, step by step. */
export interface ActivityNode {
  title?: string;
  startTime?: number;
  attachments?: unknown[];
  childActivities?: ActivityNode[];
}

export interface TestActivities {
  testIdentifier?: string;
  testName?: string;
  testRuns?: { device?: TestDevice; activities?: ActivityNode[] }[];
}

/** `get test-results insights` — Xcode's own diagnosis of a run. */
export interface TestInsights {
  commonFailureInsights?: Insight[];
  failureDistributionInsights?: Insight[];
  longestTestRunsInsights?: Insight[];
}

export interface Insight {
  category?: string;
  impact?: string;
  text?: string;
  testIdentifier?: string;
  testName?: string;
  totalDuration?: number;
  count?: number;
}

/** `get test-results metrics` — what a performance test measured. */
export interface TestMetric {
  testIdentifier?: string;
  testName?: string;
  measurements?: {
    displayName?: string;
    unit?: string;
    average?: number;
    baselineAverage?: number;
    maxPercentRelativeStandardDeviation?: number;
  }[];
}

/** `get content-availability` — what is in the bundle at all. */
export interface ContentAvailability {
  hasCoverage?: boolean;
  hasDiagnostics?: boolean;
  hasTestResults?: boolean;
  logs?: string[];
}

/** `get log` — the build or action log, as a tree of timed sections. */
export interface LogSection {
  title?: string;
  result?: string;
  duration?: number;
  startTime?: number;
  messages?: { title?: string; shortTitle?: string }[];
  subsections?: LogSection[];
  commandInvocationDetails?: { commandDetails?: string; exitCode?: number };
}

/** `metadata get` — the bundle's own storage details. */
export interface BundleMetadata {
  dateCreated?: string;
  directoryImportMode?: string;
  externalLocations?: unknown[];
  storage?: { backend?: string; compression?: string };
  version?: { major?: number; minor?: number };
}

export interface RawIssue {
  issueType?: string;
  message?: string;
  targetName?: string;
  sourceURL?: string;
}

export interface BuildResults {
  actionTitle?: string;
  status?: string;
  errorCount?: number;
  warningCount?: number;
  analyzerWarningCount?: number;
  errors?: RawIssue[];
  warnings?: RawIssue[];
  analyzerWarnings?: RawIssue[];
  destination?: TestDevice;
  startTime?: number;
  endTime?: number;
}

/** A diagnostic, flattened to the shape a TOON row wants. */
export interface Diagnostic {
  file: string;
  line: number | "";
  col: number | "";
  type: string;
  message: string;
}

function xcresulttool<T>(args: string[], path: string): Promise<T> {
  if (!existsSync(path)) {
    throw new AxiError(`No result bundle at ${path}`, "RESULT_NOT_FOUND", [
      "Run `xcodebuild-axi build` or `test` first — each prints the bundle path it wrote",
    ]);
  }
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "xcrun",
      ["xcresulttool", ...args, "--path", path, "--compact"],
      { maxBuffer: MAX_BUFFER_BYTES, encoding: "utf-8" },
      (error, stdout, stderr) => {
        if (error && stdout.trim().length === 0) {
          // xcresulttool explains itself on stderr -- "No console log
          // available", "Info.plist does not exist" -- and those answers are
          // more specific than anything inferable from the exit code.
          const reason = stderr
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line.startsWith("Error:"));
          rejectPromise(
            new AxiError(
              reason?.replace(/^Error:\s*/, "") ??
                `Could not read result bundle at ${path}`,
              "RESULT_NOT_FOUND",
              // Only guess when xcresulttool did not say. "No console log
              // available" is a complete answer, and following it with
              // "the bundle may be from an incompatible Xcode" sends the
              // reader after a problem that is not there.
              reason
                ? [
                    "Run `xcodebuild-axi result <path> --available` to see what this bundle holds",
                  ]
                : [
                    "The bundle may be from an incompatible Xcode version, or still being written",
                  ],
            ),
          );
          return;
        }
        try {
          resolvePromise(JSON.parse(stdout) as T);
        } catch {
          rejectPromise(
            new AxiError(
              `Result bundle at ${path} produced unreadable output`,
              "RESULT_NOT_FOUND",
            ),
          );
        }
      },
    );
  });
}

export function readTestSummary(path: string): Promise<TestSummary> {
  return xcresulttool<TestSummary>(["get", "test-results", "summary"], path);
}

/**
 * Where one test failed, which the summary does not carry.
 *
 * `TestFailure` in a test-results summary has a name, a target and a message
 * and no source location at all — so the only way to tell an agent which line
 * to look at is to ask about each failing test by name.
 */
export function readTestDetails(
  path: string,
  testIdentifier: string,
): Promise<TestDetails> {
  return xcresulttool<TestDetails>(
    ["get", "test-results", "test-details", "--test-id", testIdentifier],
    path,
  );
}

/**
 * The file and line a failing test points at.
 *
 * **These line numbers are one-based**, unlike the `StartingLineNumber` in a
 * build diagnostic's `sourceURL`, which is zero-based and gets a `+1` in
 * `parseSourceURL`. Verified against a real failing assertion: an
 * `XCTAssertEqual` written on line 10 is reported here as `lineNumber: 10`.
 * Adding an offset to one of these would send the agent one line past the
 * failure, every time.
 *
 * The deepest node wins: a "Source Code Reference" child points at the
 * assertion itself, while its parent points at the test case that ran it.
 */
export function failureLocation(details: TestDetails): {
  file: string;
  line: number | "";
} {
  let best: { file: string; line: number | ""; depth: number } | undefined;

  const walk = (node: TestNode, depth: number): void => {
    const location = node.sourceLocation;
    if (location?.filePath && (best === undefined || depth >= best.depth)) {
      best = {
        file: relativize(location.filePath),
        line: location.lineNumber ?? "",
        depth,
      };
    }
    for (const child of node.children ?? []) walk(child, depth + 1);
  };

  for (const run of details.testRuns ?? []) walk(run, 0);
  return best ? { file: best.file, line: best.line } : { file: "", line: "" };
}

/** Every test the run knows about, as the tree Xcode groups them into. */
export function readTests(path: string): Promise<TestTree> {
  return xcresulttool<TestTree>(["get", "test-results", "tests"], path);
}

/**
 * What one test actually did, step by step.
 *
 * The summary says a test failed and `test-details` says where; this is the
 * trail of what it had done by then, which is the only thing that explains a
 * UI test that failed three screens into a flow.
 */
export function readActivities(
  path: string,
  testIdentifier: string,
): Promise<TestActivities> {
  return xcresulttool<TestActivities>(
    ["get", "test-results", "activities", "--test-id", testIdentifier],
    path,
  );
}

/** Xcode's own diagnosis of a run: what failed together, and what was slow. */
export function readInsights(path: string): Promise<TestInsights> {
  return xcresulttool<TestInsights>(["get", "test-results", "insights"], path);
}

/** What a performance test measured, and what it measured last time. */
export function readMetrics(
  path: string,
  testIdentifier?: string,
): Promise<TestMetric[]> {
  return xcresulttool<TestMetric[]>(
    [
      "get",
      "test-results",
      "metrics",
      ...(testIdentifier ? ["--test-id", testIdentifier] : []),
    ],
    path,
  );
}

/**
 * What the bundle actually holds.
 *
 * Worth one subprocess because the alternative is finding out by asking for
 * coverage and reading the failure — an error that looks like a broken tool
 * rather than like an answer.
 */
export function readContentAvailability(
  path: string,
): Promise<ContentAvailability> {
  return xcresulttool<ContentAvailability>(
    ["get", "content-availability"],
    path,
  );
}

/** The build, action or console log, as the timed tree the bundle stores. */
export function readLog(path: string, type: string): Promise<LogSection> {
  return xcresulttool<LogSection>(["get", "log", "--type", type], path);
}

/** The bundle's own metadata — when it was written, and in what format. */
export function readBundleMetadata(path: string): Promise<BundleMetadata> {
  return xcresulttool<BundleMetadata>(["metadata", "get"], path);
}

export function readBuildResults(path: string): Promise<BuildResults> {
  return xcresulttool<BuildResults>(["get", "build-results"], path);
}

/** What `xcresulttool compare` answers: one run measured against another. */
export interface Differential {
  summary?: DifferentialSummary;
  testFailures?: {
    introduced?: TestFailureDelta[];
    resolved?: TestFailureDelta[];
  };
  testsExecuted?: { added?: TestReference[]; removed?: TestReference[] };
  buildWarnings?: IssueDelta;
  analyzerIssues?: IssueDelta;
}

export interface DifferentialSummary {
  testFailures?: CountDelta;
  buildWarnings?: CountDelta;
  analyzerIssues?: CountDelta;
  testsExecuted?: {
    itemsInBaseline?: number;
    itemsInCurrent?: number;
    added?: number;
    removed?: number;
  };
}

export interface CountDelta {
  itemsInBaseline?: number;
  itemsInCurrent?: number;
  introduced?: number;
  resolved?: number;
}

export interface TestReference {
  name?: string;
  testIdentifier?: string;
}

export interface TestFailureDelta {
  associatedTest?: TestReference;
  failureMessage?: string;
}

export interface IssueDelta {
  introduced?: DifferentialIssue[];
  resolved?: DifferentialIssue[];
}

export interface DifferentialIssue {
  message?: string;
  producingTarget?: string;
  issueType?: string;
}

/** What an `xcresulttool export` can be asked for. */
export const EXPORT_KINDS = [
  "attachments",
  "diagnostics",
  "metrics",
  "evaluations",
] as const;

export type ExportKind = (typeof EXPORT_KINDS)[number];

export interface ExportRequest {
  path: string;
  kind: ExportKind;
  outputPath: string;
  /** Narrow to one test case or suite. Not accepted by `diagnostics`. */
  testId?: string;
  /** Glob against the attachment filename. `attachments` only. */
  filter?: string;
  /** Only what a failure produced. `attachments` and `evaluations` only. */
  onlyFailures?: boolean;
}

/** One test's row in an exported `manifest.json`. */
export interface ExportedAttachment {
  exportedFileName?: string;
  suggestedHumanReadableName?: string;
  isAssociatedWithFailure?: boolean;
}

export interface AttachmentManifestEntry {
  testIdentifier?: string;
  attachments?: ExportedAttachment[];
}

export interface MetricsManifestEntry {
  testIdentifier?: string;
  metricsFiles?: string[];
}

/**
 * Write part of a bundle out to a directory.
 *
 * Unlike every other read here this one produces files rather than JSON, and
 * it narrates: exporting attachments from a 40-test run prints "Skipped export
 * for <test>: no matching attachments" once per test, which is the answer
 * nobody asked for repeated forty times. The prose is dropped and the caller
 * reports what actually landed on disk instead.
 */
export function exportBundle(request: ExportRequest): Promise<void> {
  if (!existsSync(request.path)) {
    throw new AxiError(
      `No result bundle at ${request.path}`,
      "RESULT_NOT_FOUND",
      [
        "Run `xcodebuild-axi build` or `test` first — each prints the bundle path it wrote",
      ],
    );
  }

  const args = [
    "xcresulttool",
    "export",
    request.kind,
    "--path",
    request.path,
    "--output-path",
    request.outputPath,
    ...(request.testId ? ["--test-id", request.testId] : []),
    ...(request.filter ? ["--filter", request.filter] : []),
    ...(request.onlyFailures ? ["--only-failures"] : []),
  ];

  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "xcrun",
      args,
      { maxBuffer: MAX_BUFFER_BYTES, encoding: "utf-8" },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise();
          return;
        }
        // The refusal lands on either stream depending on the subcommand --
        // a bad --test-id is printed on stdout and still exits 1.
        rejectPromise(
          new AxiError(
            exportComplaint(`${stdout}\n${stderr}`) ??
              `xcresulttool could not export ${request.kind} from ${request.path}`,
            "RESULT_NOT_FOUND",
            [
              "Run `xcodebuild-axi result <path> --available` to see what this bundle holds",
            ],
          ),
        );
      },
    );
  });
}

function exportComplaint(output: string): string | undefined {
  const reason = output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("Error:"));
  return reason?.replace(/^Error:\s*/, "");
}

/**
 * One run measured against another.
 *
 * Not routed through `xcresulttool()` because `compare` takes the bundle as a
 * positional rather than as `--path`, and rejects `--compact` outright. It
 * also answers a bare `null` rather than an error when the two bundles have
 * nothing comparable in them — a build bundle against a test one — which is an
 * answer the caller has to be able to tell apart from a clean comparison.
 */
export function readComparison(
  path: string,
  baselinePath: string,
): Promise<Differential | null> {
  for (const [label, candidate] of [
    ["", path],
    ["baseline ", baselinePath],
  ] as const) {
    if (!existsSync(candidate)) {
      throw new AxiError(
        `No ${label}result bundle at ${candidate}`,
        "RESULT_NOT_FOUND",
        [
          "Run `xcodebuild-axi build` or `test` first — each prints the bundle path it wrote",
        ],
      );
    }
  }

  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "xcrun",
      ["xcresulttool", "compare", path, "--baseline-path", baselinePath],
      { maxBuffer: MAX_BUFFER_BYTES, encoding: "utf-8" },
      (error, stdout, stderr) => {
        const complaint = exportComplaint(`${stdout}\n${stderr}`);
        // `compare` prints its refusals and still exits 0, so the exit code is
        // not the signal here; the `Error:` line is.
        if (error || complaint) {
          rejectPromise(
            new AxiError(
              complaint ?? `Could not compare ${path} to ${baselinePath}`,
              "RESULT_NOT_FOUND",
              [
                "Run `xcodebuild-axi result <path> --available` on each bundle to see what they hold",
              ],
            ),
          );
          return;
        }
        try {
          resolvePromise(JSON.parse(stdout) as Differential | null);
        } catch {
          rejectPromise(
            new AxiError(
              `Comparing ${path} to ${baselinePath} produced unreadable output`,
              "RESULT_NOT_FOUND",
            ),
          );
        }
      },
    );
  });
}

/**
 * Combine bundles into one, which is how a sharded test run gets a single
 * verdict. Writes a bundle rather than printing one, so the caller reports the
 * path and then reads it back like any other.
 */
export function mergeBundles(
  paths: string[],
  outputPath: string,
): Promise<void> {
  for (const path of paths) {
    if (!existsSync(path)) {
      throw new AxiError(`No result bundle at ${path}`, "RESULT_NOT_FOUND", [
        "Run `xcodebuild-axi build` or `test` first — each prints the bundle path it wrote",
      ]);
    }
  }

  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "xcrun",
      ["xcresulttool", "merge", ...paths, "--output-path", outputPath],
      { maxBuffer: MAX_BUFFER_BYTES, encoding: "utf-8" },
      (error, stdout, stderr) => {
        const complaint = exportComplaint(`${stdout}\n${stderr}`);
        if (error || complaint) {
          rejectPromise(
            new AxiError(
              complaint ?? `Could not merge ${paths.length} result bundles`,
              "RESULT_NOT_FOUND",
              [
                "Bundles written by different Xcode versions cannot be merged into one",
              ],
            ),
          );
          return;
        }
        resolvePromise();
      },
    );
  });
}

/**
 * Pull `file`, `line` and `col` out of a diagnostic's sourceURL.
 *
 * The URL looks like
 *   file:///path/To.swift#EndingColumnNumber=83&StartingLineNumber=165&...
 * and the line and column in that fragment are **zero-based** — a diagnostic
 * reported at `StartingLineNumber=165` is on line 166 as any editor counts it.
 * Getting this wrong sends the agent to the wrong line, which is worse than
 * sending it nowhere, so the offset is applied here and nowhere else.
 */
export function parseSourceURL(sourceURL: string | undefined): {
  file: string;
  line: number | "";
  col: number | "";
} {
  if (!sourceURL) return { file: "", line: "", col: "" };

  const hashIndex = sourceURL.indexOf("#");
  const rawPath = hashIndex === -1 ? sourceURL : sourceURL.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : sourceURL.slice(hashIndex + 1);

  let file = rawPath.startsWith("file://")
    ? rawPath.slice("file://".length)
    : rawPath;
  try {
    file = decodeURIComponent(file);
  } catch {
    // A malformed escape is not worth failing a whole build report over.
  }
  const params = new URLSearchParams(fragment);
  const line = toZeroBasedNumber(params.get("StartingLineNumber"));
  const col = toZeroBasedNumber(params.get("StartingColumnNumber"));

  return { file: relativize(file), line, col };
}

function toZeroBasedNumber(raw: string | null): number | "" {
  if (raw === null) return "";
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed + 1 : "";
}

/**
 * Repo-relative when the file is under cwd, absolute otherwise.
 *
 * Both sides need the `/private` prefix stripped, not just the diagnostic's:
 * on macOS `process.cwd()` in `/tmp` reports `/private/tmp`, so comparing the
 * two raw would make every path look outside the tree and stay absolute.
 */
export function relativize(file: string, cwd = process.cwd()): string {
  if (!file.startsWith("/")) return file;
  const normalized = stripPrivate(file);
  const rel = relative(stripPrivate(cwd), normalized);
  return rel.startsWith("..") ? normalized : rel;
}

function stripPrivate(path: string): string {
  return path.startsWith("/private/") ? path.slice("/private".length) : path;
}

/**
 * Flatten issues to TOON rows, dropping exact duplicates.
 *
 * The same Swift diagnostic is reported once per target that compiles the
 * file, so a warning in a shared package can appear a dozen times in one
 * build. Only the first is information; the rest are paid-for repetition.
 */
export function toDiagnostics(issues: RawIssue[] | undefined): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];

  for (const issue of issues ?? []) {
    const { file, line, col } = parseSourceURL(issue.sourceURL);
    const message = (issue.message ?? "").replace(/\s+/g, " ").trim();
    const key = `${file}:${line}:${col}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      file,
      line,
      col,
      type: shortIssueType(issue.issueType),
      message,
    });
  }

  return out;
}

/** "Swift Compiler Error" is four tokens to say "swift". */
function shortIssueType(issueType: string | undefined): string {
  if (!issueType) return "error";
  const lower = issueType.toLowerCase();
  if (lower.includes("swift")) return "swift";
  if (lower.includes("clang") || lower.includes("c compiler")) return "clang";
  if (lower.includes("linker")) return "linker";
  if (lower.includes("script")) return "script";
  if (lower.includes("package")) return "package";
  if (lower.includes("uncategorized")) return "xcodebuild";
  return lower.replace(/ (error|warning)$/, "").replace(/\s+/g, "-");
}

/** The device a run actually landed on, as one readable line. */
export function describeDevice(device: TestDevice | undefined): string {
  if (!device) return "unknown";
  const name = device.deviceName || device.modelName;
  const parts = [
    name,
    device.osVersion
      ? `${device.platform ?? "iOS"} ${device.osVersion}`
      : device.platform,
  ];
  const described = parts.filter((part) => part && part.length > 0).join(" · ");
  return described.length > 0 ? described : "unknown";
}
