import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AxiError } from "../errors.js";
import {
  coverageSource,
  mergeCoverage,
  percent,
  readArchiveFiles,
  readCoverage,
  readCoverageDiff,
  readFileLines,
  readFunctions,
  type CoverageFile,
  type CoverageDiff,
  type CoverageLine,
  type CoverageFunction,
} from "../xccov.js";
import { relativize } from "../xcresult.js";
import { mergedCoveragePath } from "../xcodebuild.js";
import {
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

export const COVERAGE_HELP = `usage: xcodebuild-axi coverage <path> [flags]
Reads code coverage out of a result bundle — one percentage per target, not the
thousands of per-file lines xccov prints by default. The path can also be an
.xccovreport or .xccovarchive.
flags[9]:
  --files            list per-file coverage as well as per-target
  --target <name>    only this target
  --below <percent>  only files under this coverage, e.g. --below 50
  --functions <file> per-function coverage for one file, so an uncovered
                     branch has a name
  --lines <file>     how many times each line of one file ran
  --against <path>   compare coverage with an earlier run: what moved, and
                     which files went with it
  --merge            combine the coverage of two or more runs into one report
  --to <path>        where --merge writes (default: under ~/Library/Caches)
  --max <n>          rows to list before summarizing the rest (default: 25)
note:
  Coverage has to have been collected. Run the tests with
  \`xcodebuild-axi test --coverage\` if the bundle has none.

  --lines reads the archive rather than the report: the report knows what
  percentage of a file ran, the archive knows how many times each line did.
examples:
  xcodebuild-axi coverage ~/Library/Caches/xcodebuild-axi/MyApps-1a2b3c4d/MyApp-test.xcresult
  xcodebuild-axi coverage build/MyApp.xcresult --files --below 50
  xcodebuild-axi coverage build/MyApp.xcresult --functions Checkout.swift
  xcodebuild-axi coverage build/MyApp.xcresult --against build/baseline.xcresult
`;

export const COVERAGE_FLAGS = [
  "--files",
  "--target",
  "--below",
  "--functions",
  "--lines",
  "--against",
  "--merge",
  "--to",
  "--max",
] as const;
const VALUE_FLAGS = [
  "--target",
  "--below",
  "--functions",
  "--lines",
  "--against",
  "--to",
  "--max",
] as const;

export async function coverageCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "coverage", COVERAGE_FLAGS, VALUE_FLAGS);

  const [rawPath] = positionals(args, VALUE_FLAGS);
  if (rawPath === undefined) {
    throw new AxiError(
      "coverage needs a path to an .xcresult bundle",
      "VALIDATION_ERROR",
      [
        "xcodebuild-axi coverage <path.xcresult>",
        "`xcodebuild-axi test --coverage` prints the path it wrote",
      ],
    );
  }

  const path = resolve(expandTilde(rawPath));
  const below = getIntFlag(args, "--below");
  const max = getIntFlag(args, "--max") ?? 25;

  const mode = soleMode(args);
  if (mode) return readMode(mode, path, args, max);

  // An archive holds raw execution counts and no report at all, so the
  // percentages the default view is made of do not exist for one. What it can
  // answer is which files it covers, which is also what --lines takes.
  if (coverageSource(path) === "archive") return reportArchive(path, max);

  const targetFilter = getFlag(args, "--target")?.toLowerCase();
  // A --below filter is meaningless without the files it filters, so imply it
  // rather than returning an empty list the agent has to debug.
  const wantFiles = hasFlag(args, "--files") || below !== undefined;

  const report = await readCoverage(path, { files: wantFiles });

  let targets = report.targets;
  if (targetFilter) {
    targets = targets.filter((target) =>
      target.name.toLowerCase().includes(targetFilter),
    );
    if (targets.length === 0) {
      throw new AxiError(
        `No target matching '${getFlag(args, "--target")}'`,
        "VALIDATION_ERROR",
        [
          `targets in this bundle: ${report.targets.map((target) => target.name).join(", ")}`,
        ],
      );
    }
  }

  const blocks = [
    renderFields({
      coverage: percent(report.lineCoverage),
      lines: `${report.coveredLines} of ${report.executableLines} covered`,
      targets: report.targets.length,
    }),
  ];

  const targetRows = targets
    .slice()
    .sort((a, b) => a.lineCoverage - b.lineCoverage)
    .slice(0, max)
    .map((target) => ({
      target: target.name,
      coverage: percent(target.lineCoverage),
      lines: `${target.coveredLines}/${target.executableLines}`,
    }));

  if (targetRows.length > 0) {
    blocks.push(
      renderList(
        targets.length > targetRows.length
          ? `targets (${targetRows.length} of ${targets.length})`
          : "targets",
        targetRows,
      ),
    );
  }

  if (wantFiles) {
    const threshold = below === undefined ? undefined : below / 100;
    const files: CoverageFile[] = targets
      .flatMap((target) => target.files ?? [])
      .filter(
        (file) => threshold === undefined || file.lineCoverage < threshold,
      )
      // Executable-line-free files sit at 0% forever and are pure noise in a
      // "what needs tests" list.
      .filter((file) => file.executableLines > 0)
      .sort((a, b) => a.lineCoverage - b.lineCoverage);

    if (files.length === 0) {
      blocks.push(
        renderFields({
          files:
            below === undefined
              ? "0 files with executable lines"
              : `0 files below ${below}% coverage`,
        }),
      );
    } else {
      const shown = files.slice(0, max).map((file) => ({
        file: relativize(file.path || file.name),
        coverage: percent(file.lineCoverage),
        lines: `${file.coveredLines}/${file.executableLines}`,
      }));
      blocks.push(
        renderList(
          files.length > shown.length
            ? `files (${shown.length} of ${files.length})`
            : "files",
          shown,
        ),
      );
    }
  }

  blocks.push(renderFields(sourceField(path)));

  const hints: string[] = [];
  if (!wantFiles) {
    hints.push(
      `Run \`xcodebuild-axi coverage ${rawPath} --files\` for per-file coverage`,
    );
    hints.push(
      `Run \`xcodebuild-axi coverage ${rawPath} --below 50\` for the files that need tests`,
    );
  }
  blocks.push(renderHelp(hints));

  return renderOutput(blocks);
}

/**
 * Name the path by what it is. A `.xccovreport` reported as `bundle:` is a
 * path the next call cannot reuse the same way.
 */
function sourceField(path: string): Record<string, string> {
  const kind = coverageSource(path);
  return { [kind]: tildePath(path) };
}

/** What an .xccovarchive can answer on its own: which files it holds. */
async function reportArchive(path: string, max: number): Promise<string> {
  const files = await readArchiveFiles(path);
  const shown = files.slice(0, max).map((file) => ({ file: relativize(file) }));

  return renderOutput([
    renderFields({ archive: tildePath(path), files: files.length }),
    files.length > 0
      ? renderList(
          files.length > shown.length
            ? `files (${shown.length} of ${files.length})`
            : "files",
          shown,
        )
      : renderFields({ files: "none — this archive holds no coverage" }),
    renderHelp([
      `Run \`xcodebuild-axi coverage ${tildePath(path)} --lines <file>\` for the lines that never ran`,
    ]),
  ]);
}

/** The one coverage question this invocation is for, if not the default. */
const MODES = ["--functions", "--lines", "--against", "--merge"] as const;

function soleMode(args: string[]): (typeof MODES)[number] | undefined {
  const asked = MODES.filter((mode) => args.includes(mode));
  if (asked.length > 1) {
    throw new AxiError(
      `${asked.join(" and ")} ask different questions — pass one`,
      "VALIDATION_ERROR",
      [`each is its own read of the coverage data: ${MODES.join(", ")}`],
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
  switch (mode) {
    case "--functions":
      return reportFunctions(path, requireValue(args, "--functions"), max);
    case "--lines":
      return reportLines(path, requireValue(args, "--lines"), max);
    case "--against":
      return reportDiff(
        path,
        resolve(expandTilde(requireValue(args, "--against"))),
        max,
      );
    case "--merge":
      return runMerge(args, max);
  }
}

function requireValue(args: string[], flag: string): string {
  const value = getFlag(args, flag);
  if (value === undefined) {
    throw new AxiError(`${flag} needs a value`, "VALIDATION_ERROR", [
      `xcodebuild-axi coverage <path> ${flag} <value>`,
    ]);
  }
  return value;
}

/**
 * Per-function coverage, which is where an uncovered branch gets a name.
 *
 * A file at 60% says a test is missing; it does not say which one. The
 * function list does, and it is sorted with the least covered first because
 * that is the row someone is looking for.
 */
async function reportFunctions(
  path: string,
  file: string,
  max: number,
): Promise<string> {
  const found = await readFunctions(path, file);
  const functions = found.flatMap((entry) => entry.functions);

  if (functions.length === 0) {
    return renderOutput([
      renderFields({
        functions: `no coverage recorded for a file named '${file}'`,
      }),
      renderFields(sourceField(path)),
      renderHelp([
        `Run \`xcodebuild-axi coverage ${tildePath(path)} --files\` to see which files the report covers`,
        "The name is matched against the path the file had when the report was written",
      ]),
    ]);
  }

  const sorted = functions
    .slice()
    .sort((a, b) => a.lineCoverage - b.lineCoverage);
  const shown = sorted.slice(0, max).map(functionRow);

  return renderOutput([
    renderFields({
      file: relativize(found[0]?.file ?? file),
      functions: functions.length,
      uncovered: functions.filter((fn) => fn.executionCount === 0).length,
    }),
    renderList(
      sorted.length > shown.length
        ? `functions (${shown.length} of ${sorted.length})`
        : "functions",
      shown,
    ),
    renderFields(sourceField(path)),
  ]);
}

function functionRow(fn: CoverageFunction): Record<string, unknown> {
  return {
    function: fn.name,
    line: fn.lineNumber,
    coverage: percent(fn.lineCoverage),
    lines: `${fn.coveredLines}/${fn.executableLines}`,
    runs: fn.executionCount,
  };
}

/**
 * Per-line execution counts, reported as the ranges that did not run.
 *
 * Printing one row per line is the thing `xccov` already does and the thing
 * nobody can read: a 400-line file is 400 rows to find the eight that matter.
 * Consecutive uncovered lines collapse into a range instead.
 */
async function reportLines(
  path: string,
  file: string,
  max: number,
): Promise<string> {
  const lines = await readFileLines(path, file).catch(
    async (error: unknown) => {
      // xccov answers an unknown file with a load failure rather than a list, so
      // the list is what the refusal carries.
      const candidates = await readArchiveFiles(path).catch(() => []);
      if (candidates.length === 0) throw error;
      const near = candidates.filter((candidate) => candidate.includes(file));
      throw new AxiError(
        `No coverage recorded for '${file}'`,
        "VALIDATION_ERROR",
        near.length > 0
          ? [`did you mean: ${near.slice(0, 5).join(", ")}`]
          : [
              `Run \`xcodebuild-axi coverage ${tildePath(path)} --files\` to see the files this archive holds`,
            ],
      );
    },
  );

  const executable = lines.filter((line) => line.isExecutable);
  const covered = executable.filter((line) => line.executionCount > 0).length;
  const gaps = uncoveredRanges(executable);
  const shown = gaps.slice(0, max);

  return renderOutput([
    renderFields({
      file: relativize(file),
      coverage: percent(
        executable.length > 0 ? covered / executable.length : 0,
      ),
      lines: `${covered} of ${executable.length} covered`,
    }),
    gaps.length === 0
      ? renderFields({ uncovered: "none — every executable line ran" })
      : renderList(
          gaps.length > shown.length
            ? `uncovered (${shown.length} of ${gaps.length})`
            : "uncovered",
          shown,
        ),
    renderFields(sourceField(path)),
  ]);
}

/** Consecutive lines that never ran, as ranges rather than one row each. */
export function uncoveredRanges(
  lines: CoverageLine[],
): Array<Record<string, unknown>> {
  const ranges: Array<{ from: number; to: number }> = [];
  for (const line of lines) {
    if (line.executionCount > 0) continue;
    const last = ranges[ranges.length - 1];
    if (last && line.line === last.to + 1) last.to = line.line;
    else ranges.push({ from: line.line, to: line.line });
  }
  return ranges.map((range) => ({
    lines:
      range.from === range.to ? `${range.from}` : `${range.from}-${range.to}`,
    count: range.to - range.from + 1,
  }));
}

/**
 * `--against`, which answers "did coverage drop" without a spreadsheet.
 *
 * The headline is the delta, because a coverage check in CI is a comparison
 * rather than a threshold most of the time.
 */
async function reportDiff(
  path: string,
  baseline: string,
  max: number,
): Promise<string> {
  // xccov's argument order is before, after; the bundle being asked about is
  // the after, so the baseline goes first.
  const diff = await readCoverageDiff(baseline, path);
  const overall = diff.lineCoverageDelta ?? {};

  const blocks = [
    renderFields({
      coverage: movement(overall.lineCoverageDelta ?? 0),
      covered_lines: overall.coveredLinesDelta ?? 0,
      executable_lines: overall.executableLinesDelta ?? 0,
    }),
  ];

  // Sorted on the number and rendered afterwards: "down 45.5%" does not
  // compare as a number, and the biggest drop is the row being looked for.
  const moved = (diff.targetDeltas ?? [])
    .flatMap((target) =>
      (target.fileDeltas ?? []).map((file) => ({
        target: target.name ?? "",
        file: relativize(file.documentLocation ?? ""),
        delta: file.lineCoverageDelta?.lineCoverageDelta ?? 0,
        lines: file.lineCoverageDelta?.coveredLinesDelta ?? 0,
      })),
    )
    .sort((a, b) => a.delta - b.delta);

  if (moved.length > 0) {
    const shown = moved.slice(0, max).map(({ target, file, delta, lines }) => ({
      target,
      file,
      coverage: movement(delta),
      lines,
    }));
    blocks.push(
      renderList(
        moved.length > shown.length
          ? `files (${shown.length} of ${moved.length})`
          : "files",
        shown,
      ),
    );
  }

  const added = namesOf(diff, "addedFiles");
  const removed = namesOf(diff, "removedFiles");
  if (added.length > 0) blocks.push(renderFields({ added_files: added }));
  if (removed.length > 0) blocks.push(renderFields({ removed_files: removed }));

  if (blocks.length === 1 && moved.length === 0) {
    blocks.push(
      renderFields({ difference: "none — coverage matches the baseline" }),
    );
  }

  return renderOutput([
    ...blocks,
    renderFields({ baseline: tildePath(baseline), ...sourceField(path) }),
  ]);
}

function namesOf(
  diff: CoverageDiff,
  key: "addedFiles" | "removedFiles",
): string[] {
  return (diff.targetDeltas ?? []).flatMap((target) =>
    (target[key] ?? []).map((file) => relativize(file.documentLocation ?? "")),
  );
}

/**
 * Which way coverage moved, in words.
 *
 * Words rather than a signed percentage because TOON quotes any scalar that
 * starts with `-`, and `"-2.1%"` costs more in quotes than `down 2.1%` costs
 * in letters.
 */
export function movement(delta: number): string {
  if (delta === 0) return "unchanged";
  return `${delta > 0 ? "up" : "down"} ${percent(Math.abs(delta))}`;
}

/**
 * `--merge`, which combines the coverage of a sharded run.
 *
 * `xccov merge` wants report/archive pairs rather than result bundles, so the
 * bundles are unpacked first — the two-step that makes this something people
 * give up on doing in CI.
 */
async function runMerge(args: string[], max: number): Promise<string> {
  const paths = positionals(args, VALUE_FLAGS).map((path) =>
    resolve(expandTilde(path)),
  );
  if (paths.length < 2) {
    throw new AxiError(
      `--merge combines the coverage of two or more runs, and ${paths.length} was given`,
      "VALIDATION_ERROR",
      [
        "xcodebuild-axi coverage shard1.xcresult shard2.xcresult --merge",
        "`xcodebuild-axi test --coverage` prints the bundle path it wrote",
      ],
    );
  }

  const requested = getFlag(args, "--to");
  const outReport = requested
    ? resolve(expandTilde(requested))
    : mergedCoveragePath(paths);
  const outArchive = outReport.replace(/\.xccovreport$/, "") + ".xccovarchive";

  if (requested && (existsSync(outReport) || existsSync(outArchive))) {
    throw new AxiError(
      `Something is already at ${tildePath(outReport)}`,
      "VALIDATION_ERROR",
      [
        "Pass a path that does not exist yet, or drop --to to write under ~/Library/Caches",
      ],
    );
  }
  if (!requested) {
    rmSync(outReport, { recursive: true, force: true });
    rmSync(outArchive, { recursive: true, force: true });
  }
  mkdirSync(dirname(outReport), { recursive: true });

  await mergeCoverage(paths, outReport, outArchive);
  const merged = await readCoverage(outReport);

  return renderOutput([
    renderFields({
      merged: paths.length,
      coverage: percent(merged.lineCoverage),
      lines: `${merged.coveredLines} of ${merged.executableLines} covered`,
      report: tildePath(outReport),
      archive: tildePath(outArchive),
    }),
    renderList(
      "from",
      paths.slice(0, max).map((path) => ({ bundle: tildePath(path) })),
    ),
    renderHelp([
      `Run \`xcodebuild-axi coverage ${tildePath(outReport)} --files\` to report on the merged coverage`,
    ]),
  ]);
}

function expandTilde(path: string): string {
  const home = process.env["HOME"];
  return home && path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}
