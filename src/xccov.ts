import { execFile } from "node:child_process";
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
              firstLine(stderr) || "xccov failed",
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

export async function readCoverage(
  resultPath: string,
  options: { files?: boolean } = {},
): Promise<CoverageReport> {
  const stdout = await xccov(["view", "--report", "--json", resultPath]);

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
