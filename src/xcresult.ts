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
      (error, stdout) => {
        if (error && stdout.trim().length === 0) {
          rejectPromise(
            new AxiError(
              `Could not read result bundle at ${path}`,
              "RESULT_NOT_FOUND",
              [
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

export function readBuildResults(path: string): Promise<BuildResults> {
  return xcresulttool<BuildResults>(["get", "build-results"], path);
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
