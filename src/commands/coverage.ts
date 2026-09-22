import { resolve } from "node:path";
import { AxiError } from "../errors.js";
import { percent, readCoverage, type CoverageFile } from "../xccov.js";
import { relativize } from "../xcresult.js";
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

export const COVERAGE_HELP = `usage: xcodebuild-axi coverage <path.xcresult> [flags]
Reads code coverage out of a result bundle — one percentage per target, not the
thousands of per-file lines xccov prints by default.
flags[4]:
  --files            list per-file coverage as well as per-target
  --target <name>    only this target
  --below <percent>  only files under this coverage, e.g. --below 50
  --max <n>          rows to list before summarizing the rest (default: 25)
note:
  Coverage has to have been collected. Run the tests with
  \`xcodebuild-axi test --coverage\` if the bundle has none.
examples:
  xcodebuild-axi coverage ~/Library/Caches/xcodebuild-axi/MyApps-1a2b3c4d/MyApp-test.xcresult
  xcodebuild-axi coverage build/MyApp.xcresult --files --below 50
`;

export const COVERAGE_FLAGS = [
  "--files",
  "--target",
  "--below",
  "--max",
] as const;
const VALUE_FLAGS = ["--target", "--below", "--max"] as const;

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

  blocks.push(renderFields({ bundle: tildePath(path) }));

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

function expandTilde(path: string): string {
  const home = process.env["HOME"];
  return home && path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}
