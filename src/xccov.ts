import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "./errors.js";

/**
 * Code coverage, read out of a result bundle with `xccov`.
 *
 * The per-file report for a real app runs to thousands of lines; the number
 * an agent actually wants is one percentage per target, and the list of files
 * that drag it down.
 */

const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export interface CoverageTarget {
  name: string;
  lineCoverage: number;
  coveredLines: number;
  executableLines: number;
  files?: CoverageFile[];
}

export interface CoverageFile {
  name: string;
  path: string;
  lineCoverage: number;
  coveredLines: number;
  executableLines: number;
}

interface RawReport {
  targets?: {
    name?: string;
    lineCoverage?: number;
    coveredLines?: number;
    executableLines?: number;
    files?: {
      name?: string;
      path?: string;
      lineCoverage?: number;
      coveredLines?: number;
      executableLines?: number;
    }[];
  }[];
  lineCoverage?: number;
  coveredLines?: number;
  executableLines?: number;
}

export interface CoverageReport {
  lineCoverage: number;
  coveredLines: number;
  executableLines: number;
  targets: CoverageTarget[];
}

function xccov(args: string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "xcrun",
      ["xccov", ...args],
      { maxBuffer: MAX_BUFFER_BYTES, encoding: "utf-8" },
      (error, stdout, stderr) => {
        if (error && stdout.trim().length === 0) {
          // xccov's own phrasing for the common case, translated into
          // something that names the command that fixes it.
          if (/No coverage data/i.test(stderr)) {
            rejectPromise(
              new AxiError(
                "That result bundle carries no coverage data",
                "RESULT_NOT_FOUND",
                ["Re-run the tests with `xcodebuild-axi test --coverage`"],
              ),
            );
            return;
          }
          rejectPromise(
            new AxiError(
              complaint(stderr) || "xccov failed",
              "RESULT_NOT_FOUND",
            ),
          );
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}

/**
 * What a coverage question can be pointed at.
 *
 * `xccov` spells the same view three ways depending on what it is reading:
 * `view --report <bundle>`, `view <report>`, and `view --archive <bundle>` vs
 * `view <archive>`. The caller has one path and should not have to know which.
 */
export type CoverageSource = "bundle" | "report" | "archive";

export function coverageSource(path: string): CoverageSource {
  if (path.endsWith(".xccovreport")) return "report";
  if (path.endsWith(".xccovarchive")) return "archive";
  return "bundle";
}

/** The `view` flags that select the report inside whatever this path is. */
function reportArgs(path: string): string[] {
  return coverageSource(path) === "bundle" ? ["view", "--report"] : ["view"];
}

/** The `view` flags that select the archive — raw counts, not percentages. */
function archiveArgs(path: string): string[] {
  return coverageSource(path) === "bundle" ? ["view", "--archive"] : ["view"];
}

export async function readCoverage(
  resultPath: string,
  options: { files?: boolean } = {},
): Promise<CoverageReport> {
  const stdout = await xccov([...reportArgs(resultPath), "--json", resultPath]);

  let parsed: RawReport;
  try {
    parsed = JSON.parse(stdout) as RawReport;
  } catch {
    throw new AxiError(
      "xccov returned output that could not be read",
      "RESULT_NOT_FOUND",
    );
  }

  const targets: CoverageTarget[] = (parsed.targets ?? []).map((target) => ({
    name: target.name ?? "unknown",
    lineCoverage: target.lineCoverage ?? 0,
    coveredLines: target.coveredLines ?? 0,
    executableLines: target.executableLines ?? 0,
    ...(options.files
      ? {
          files: (target.files ?? []).map((file) => ({
            name: file.name ?? "unknown",
            path: file.path ?? "",
            lineCoverage: file.lineCoverage ?? 0,
            coveredLines: file.coveredLines ?? 0,
            executableLines: file.executableLines ?? 0,
          })),
        }
      : {}),
  }));

  // The top-level totals are not always present, and a report that silently
  // reports 0% because a field was missing is worse than one that adds up the
  // targets itself.
  const coveredLines =
    parsed.coveredLines ??
    targets.reduce((sum, target) => sum + target.coveredLines, 0);
  const executableLines =
    parsed.executableLines ??
    targets.reduce((sum, target) => sum + target.executableLines, 0);

  return {
    lineCoverage:
      parsed.lineCoverage ??
      (executableLines > 0 ? coveredLines / executableLines : 0),
    coveredLines,
    executableLines,
    targets,
  };
}

/** 0.8342 -> "83.4%". */
export function percent(fraction: number): string {
  if (!Number.isFinite(fraction)) return "unknown";
  return `${(fraction * 100).toFixed(1)}%`;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

/**
 * xccov's refusals, minus the NSError wrapping.
 *
 * A bad path comes back as `Error: Error Domain=XCCovErrorDomain Code=0
 * "Failed to load result bundle" UserInfo={NSLocalizedDescription=Failed to
 * load result bundle, NSUnderlyingError=0x… {…}}` — 400 characters around a
 * five-word answer that is already in there.
 */
function complaint(stderr: string): string {
  const line = firstLine(stderr).replace(/^Error:\s*/, "");
  return line.match(/NSLocalizedDescription=([^,}]+)/)?.[1]?.trim() ?? line;
}

/** One function's coverage, which is where an uncovered branch gets a name. */
export interface CoverageFunction {
  name: string;
  lineNumber: number;
  executionCount: number;
  lineCoverage: number;
  coveredLines: number;
  executableLines: number;
}

interface RawFunctionsForFile {
  file?: string;
  functions?: Array<Partial<CoverageFunction>>;
}

/**
 * Per-function coverage for one file.
 *
 * The file is matched by name or by the path it had when the report was
 * written, so it need not exist on disk — which is the point when the report
 * came from CI.
 */
export async function readFunctions(
  path: string,
  file: string,
): Promise<Array<{ file: string; functions: CoverageFunction[] }>> {
  const stdout = await xccov([
    ...reportArgs(path),
    "--functions-for-file",
    file,
    "--json",
    path,
  ]);

  let parsed: RawFunctionsForFile[];
  try {
    parsed = JSON.parse(stdout) as RawFunctionsForFile[];
  } catch {
    throw new AxiError(
      "xccov returned output that could not be read",
      "RESULT_NOT_FOUND",
    );
  }

  return parsed.map((entry) => ({
    file: entry.file ?? file,
    functions: (entry.functions ?? []).map((fn) => ({
      name: fn.name ?? "unknown",
      lineNumber: fn.lineNumber ?? 0,
      executionCount: fn.executionCount ?? 0,
      lineCoverage: fn.lineCoverage ?? 0,
      coveredLines: fn.coveredLines ?? 0,
      executableLines: fn.executableLines ?? 0,
    })),
  }));
}

export interface CoverageLine {
  line: number;
  isExecutable: boolean;
  executionCount: number;
}

/**
 * Per-line execution counts for one file, out of the archive rather than the
 * report — the report knows percentages, the archive knows how many times
 * each line ran.
 */
export async function readFileLines(
  path: string,
  file: string,
): Promise<CoverageLine[]> {
  const stdout = await xccov([
    ...archiveArgs(path),
    "--file",
    file,
    "--json",
    path,
  ]);

  let parsed: Record<string, Array<Partial<CoverageLine>>>;
  try {
    parsed = JSON.parse(stdout) as Record<string, Array<Partial<CoverageLine>>>;
  } catch {
    throw new AxiError(
      "xccov returned output that could not be read",
      "RESULT_NOT_FOUND",
    );
  }

  return Object.values(parsed)
    .flat()
    .map((line) => ({
      line: line.line ?? 0,
      isExecutable: line.isExecutable === true,
      executionCount: line.executionCount ?? 0,
    }));
}

/** Every file the archive holds counts for, which is what `--file` accepts. */
export async function readArchiveFiles(path: string): Promise<string[]> {
  const stdout = await xccov([...archiveArgs(path), "--file-list", path]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export interface CoverageDelta {
  coveredLinesDelta?: number;
  executableLinesDelta?: number;
  lineCoverageDelta?: number;
}

export interface FileDelta {
  documentLocation?: string;
  lineCoverageDelta?: CoverageDelta;
  addedFunctions?: Array<Partial<CoverageFunction>>;
  removedFunctions?: Array<Partial<CoverageFunction>>;
  functionDeltas?: Array<{
    name?: string;
    lineCoverageDelta?: CoverageDelta;
  }>;
}

export interface TargetDelta {
  name?: string;
  lineCoverageDelta?: CoverageDelta;
  addedFiles?: Array<{ documentLocation?: string }>;
  removedFiles?: Array<{ documentLocation?: string }>;
  fileDeltas?: FileDelta[];
}

export interface CoverageDiff {
  lineCoverageDelta?: CoverageDelta;
  addedTargets?: Array<{ name?: string }>;
  removedTargets?: Array<{ name?: string }>;
  targetDeltas?: TargetDelta[];
}

/**
 * Two coverage reports measured against each other.
 *
 * `xccov diff` refuses to run without `--json` — its own text form was
 * removed — so there is only one shape to read.
 */
export async function readCoverageDiff(
  before: string,
  after: string,
): Promise<CoverageDiff> {
  const stdout = await xccov(["diff", "--json", before, after]);
  try {
    return JSON.parse(stdout) as CoverageDiff;
  } catch {
    throw new AxiError(
      "xccov returned a diff that could not be read",
      "RESULT_NOT_FOUND",
    );
  }
}

/**
 * Combine the coverage of several runs into one report and archive.
 *
 * `xccov merge` takes report/archive **pairs**, not result bundles, so each
 * bundle is unpacked with `xcresulttool export coverage` first. That two-step
 * is the whole reason merging coverage across shards is something people give
 * up on.
 */
export async function mergeCoverage(
  paths: string[],
  outReport: string,
  outArchive: string,
): Promise<void> {
  const pairs: string[] = [];
  for (const path of paths) {
    if (coverageSource(path) !== "bundle") {
      pairs.push(path);
      continue;
    }
    const exported = mkdtempSync(join(tmpdir(), "axi-xccov-"));
    await exportCoverage(path, exported);
    const report = findExported(exported, "CoverageReport");
    const archive = findExported(exported, "CoverageArchive");
    if (!report || !archive) {
      throw new AxiError(
        `No coverage to merge in ${path}`,
        "RESULT_NOT_FOUND",
        ["Re-run those tests with `xcodebuild-axi test --coverage`"],
      );
    }
    pairs.push(report, archive);
  }

  await xccov([
    "merge",
    "--outReport",
    outReport,
    "--outArchive",
    outArchive,
    ...pairs,
  ]);
}

function findExported(dir: string, suffix: string): string | undefined {
  const match = readdirSync(dir).find((entry) => entry.endsWith(suffix));
  return match ? join(dir, match) : undefined;
}

function exportCoverage(path: string, outputPath: string): Promise<void> {
  if (!existsSync(path)) {
    throw new AxiError(`No result bundle at ${path}`, "RESULT_NOT_FOUND", [
      "Run `xcodebuild-axi test --coverage` first — it prints the bundle path it wrote",
    ]);
  }
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "xcrun",
      [
        "xcresulttool",
        "export",
        "coverage",
        "--path",
        path,
        "--output-path",
        outputPath,
      ],
      { maxBuffer: MAX_BUFFER_BYTES, encoding: "utf-8" },
      (error, _stdout, stderr) => {
        if (error) {
          rejectPromise(
            new AxiError(
              firstLine(stderr) || `Could not read coverage out of ${path}`,
              "RESULT_NOT_FOUND",
              ["Re-run those tests with `xcodebuild-axi test --coverage`"],
            ),
          );
          return;
        }
        resolvePromise();
      },
    );
  });
}
