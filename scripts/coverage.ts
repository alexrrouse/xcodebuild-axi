/**
 * Measure how much of `xcodebuild` this tool covers, and keep the README honest.
 *
 * The number is not hand-maintained: the denominator comes from the installed
 * `xcodebuild -help`, and the numerator from `src/surface.ts`. Run with
 * `--check` in CI to fail on three kinds of drift — a stale README, an option
 * the map has never heard of (a new Xcode shipped one), and an option the map
 * still claims that xcodebuild has dropped.
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { format, resolveConfig } from "prettier";
import {
  ACTION_COVERAGE,
  OPTION_COVERAGE,
  tally,
  type OptionCoverage,
} from "../src/surface.js";

const run = promisify(execFile);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readmePath = join(root, "README.md");
const START = "<!-- coverage:start -->";
const END = "<!-- coverage:end -->";
const BADGE_START = "<!-- coverage-badge:start -->";
const BADGE_END = "<!-- coverage-badge:end -->";

/**
 * The options block of `xcodebuild -help`, which lists one flag per line at a
 * fixed four-space indent and ends where the build-setting keys begin.
 */
async function liveOptions(): Promise<string[] | undefined> {
  let help: string;
  try {
    const result = await run("xcodebuild", ["-help"], {
      maxBuffer: 4 * 1024 * 1024,
    });
    help = `${result.stdout}${result.stderr}`;
  } catch {
    return undefined;
  }

  const options = new Set<string>();
  let inside = false;
  for (const line of help.split("\n")) {
    if (/^Options:/.test(line)) {
      inside = true;
      continue;
    }
    if (/^Available keys/.test(line)) break;
    if (!inside) continue;
    const match = /^ {4}(-[A-Za-z0-9-]+)/.exec(line);
    if (match?.[1]) options.add(match[1]);
  }
  return [...options].sort();
}

function describe(entry: OptionCoverage): string {
  return entry.status === "exposed" ? entry.via : entry.why;
}

function renderSection(): string {
  const options = tally(OPTION_COVERAGE);
  const actions = tally(ACTION_COVERAGE);

  const rows = (status: OptionCoverage["status"]) =>
    Object.entries(OPTION_COVERAGE)
      .filter(([, entry]) => entry.status === status)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([flag, entry]) => `| \`${flag}\` | ${describe(entry)} |`);

  const uncovered = Object.entries(OPTION_COVERAGE)
    .filter(([, entry]) => entry.status === "n/a")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([flag, entry]) => `| \`${flag}\` | ${describe(entry)} |`);

  const actionGaps = Object.entries(ACTION_COVERAGE)
    .filter(([, entry]) => entry.status === "n/a")
    .map(([name]) => `\`${name}\``);

  return [
    START,
    "",
    `**Coverage: ${options.percent}% — every one of the ${options.total} options \`xcodebuild -help\` lists, and ${actions.covered} of its ${actions.total} build actions.**`,
    "",
    `${options.exposed} options map to an \`xcodebuild-axi\` flag. The other ${options.always + options.superseded} are reachable without one:`,
    "",
    "| Option | How |",
    "| --- | --- |",
    ...rows("always"),
    ...rows("superseded"),
    ...(uncovered.length > 0
      ? [
          "",
          `The remaining ${options.na} are deliberately not wrapped:`,
          "",
          "| Option | Why not |",
          "| --- | --- |",
          ...uncovered,
        ]
      : []),
    ...(actionGaps.length > 0
      ? [
          "",
          `The one action left out is ${actionGaps.join(", ")} — it copies sources into \`SRCROOT\` as root, which is a packaging step rather than anything an agent loop needs.`,
        ]
      : []),
    "",
    "The denominator is read from the `xcodebuild -help` on the machine running `npm run coverage`, and CI fails if a new Xcode adds an option this table has never classified.",
    "",
    END,
  ].join("\n");
}

function classificationDrift(live: string[]): string[] {
  const problems: string[] = [];
  for (const flag of live) {
    if (!(flag in OPTION_COVERAGE)) {
      problems.push(
        `xcodebuild has '${flag}' but src/surface.ts does not classify it`,
      );
    }
  }
  for (const flag of Object.keys(OPTION_COVERAGE)) {
    if (!live.includes(flag)) {
      problems.push(
        `src/surface.ts classifies '${flag}' but this xcodebuild does not list it`,
      );
    }
  }
  return problems;
}

function renderBadge(): string {
  const { percent } = tally(OPTION_COVERAGE);
  const color =
    percent >= 90 ? "brightgreen" : percent >= 75 ? "yellow" : "orange";
  return `${BADGE_START}<img alt="xcodebuild coverage" src="https://img.shields.io/badge/xcodebuild_coverage-${percent}%25-${color}?style=flat-square" />${BADGE_END}`;
}

/** Swap the text between a marker pair, leaving the markers in place. */
function splice(
  text: string,
  start: string,
  end: string,
  replacement: string,
): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from < 0 || to < 0) {
    console.error(`README.md is missing the ${start} / ${end} markers`);
    process.exit(1);
  }
  return `${text.slice(0, from)}${replacement}${text.slice(to + end.length)}`;
}

const check = process.argv.includes("--check");
const readme = readFileSync(readmePath, "utf-8");

// Prettier pads markdown table cells by display width, which this script has
// no business reimplementing — so the generated section goes through prettier
// before it is compared or written. Otherwise `coverage` and `format:check`
// would disagree forever.
const prettierConfig = await resolveConfig(readmePath);
const updated = await format(
  splice(
    splice(readme, START, END, renderSection()),
    BADGE_START,
    BADGE_END,
    renderBadge(),
  ),
  { ...prettierConfig, filepath: readmePath },
);
const live = await liveOptions();

if (live === undefined) {
  // Linux CI, or a machine without command line tools. The README check still
  // works; only the drift check needs a real xcodebuild.
  console.warn("xcodebuild not available — skipping the drift check");
} else {
  const problems = classificationDrift(live);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error(
      "\nAdd the missing options to src/surface.ts, then rerun `npm run coverage`.",
    );
    process.exit(1);
  }
}

if (check) {
  if (updated !== readme) {
    console.error(
      "README.md coverage section is stale — run `npm run coverage`",
    );
    process.exit(1);
  }
  const options = tally(OPTION_COVERAGE);
  console.log(
    `coverage ${options.percent}% (${options.covered}/${options.total}) up to date`,
  );
} else {
  writeFileSync(readmePath, updated);
  const options = tally(OPTION_COVERAGE);
  console.log(
    `README.md updated: ${options.percent}% (${options.covered}/${options.total})`,
  );
}
