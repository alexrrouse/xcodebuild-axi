/**
 * Measure how much of `xcodebuild` this tool covers, and keep the README honest.
 *
 * The number is not hand-maintained: the denominator comes from the installed
 * `xcodebuild -help`, and the numerator from `src/surface.ts`. Run with
 * `--check` in CI to fail on three kinds of drift — a stale README, an option
 * the map has never heard of (a new Xcode shipped one), and an option the map
 * still claims that xcodebuild has dropped.
 *
 * What the map *claims* about each command — that `settings --target` exists,
 * say — is checked against the commands themselves in `test/surface.test.ts`,
 * where a wrong claim fails as a test rather than as a rendering.
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { format, resolveConfig } from "prettier";
import {
  ACTION_COVERAGE,
  AUTHORED_AGAINST,
  COMPANION_SURFACES,
  EXPORT_OPTION_COVERAGE,
  FORM_COVERAGE,
  OPTION_COVERAGE,
  XCFRAMEWORK_COVERAGE,
  describe,
  gaps,
  reach,
  tally,
  type CoverageTally,
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

/** `Xcode 27.0\nBuild version 27A266a` -> `27.0`. */
async function liveXcodeVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await run("xcodebuild", ["-version"]);
    return /^Xcode ([0-9.]+)/m.exec(stdout)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * The xcodebuild surfaces, counted as leaves — one documented switch, key, or
 * sub-option each. `-exportOptionsPlist` is one option and eighteen leaves,
 * and for a long time only the option was counted.
 */
const XCODEBUILD_SURFACES: Array<{
  name: string;
  what: string;
  map: Record<string, OptionCoverage>;
}> = [
  { name: "`xcodebuild -help` options", what: "options", map: OPTION_COVERAGE },
  { name: "build actions", what: "actions", map: ACTION_COVERAGE },
  {
    name: "second forms (`-version <infoitem>`, `-license check`)",
    what: "forms",
    map: FORM_COVERAGE,
  },
  {
    name: "`-exportOptionsPlist` keys",
    what: "keys",
    map: EXPORT_OPTION_COVERAGE,
  },
  {
    name: "`-create-xcframework` options",
    what: "options",
    map: XCFRAMEWORK_COVERAGE,
  },
];

function totals(maps: Record<string, OptionCoverage>[]): CoverageTally {
  const merged = maps.reduce<Record<string, OptionCoverage>>(
    (all, map, index) => {
      for (const [key, entry] of Object.entries(map))
        all[`${index}:${key}`] = entry;
      return all;
    },
    {},
  );
  return tally(merged);
}

function surfaceRows(
  surfaces: Array<{ name: string; map: Record<string, OptionCoverage> }>,
): string[] {
  return surfaces.map(({ name, map }) => {
    const counts = tally(map);
    return `| ${name} | ${counts.total} | ${counts.covered} (${counts.percent}%) |`;
  });
}

/** The open list: every leaf that should exist and does not, yet. */
function openGaps(): string[] {
  const rows: string[] = [];

  for (const { option, command, why } of gaps(OPTION_COVERAGE)) {
    rows.push(`| \`${option}\` | \`${command}\` | ${why} |`);
  }

  const missingFrom = (
    map: Record<string, OptionCoverage>,
    label: (key: string) => string,
  ) => {
    for (const [key, entry] of Object.entries(map)) {
      if (entry.status !== "missing") continue;
      rows.push(`| ${label(key)} | \`${entry.from ?? "?"}\` | ${entry.why} |`);
    }
  };

  missingFrom(FORM_COVERAGE, (key) => `\`${key}\``);
  missingFrom(EXPORT_OPTION_COVERAGE, (key) => `\`${key}\` (export options)`);
  missingFrom(XCFRAMEWORK_COVERAGE, (key) => `\`${key}\` (xcframework)`);
  for (const [tool, map] of Object.entries(COMPANION_SURFACES)) {
    missingFrom(map, (key) => `\`${tool} ${key}\``);
  }
  return rows;
}

function renderSection(): string {
  const options = tally(OPTION_COVERAGE);
  const overall = totals(XCODEBUILD_SURFACES.map((surface) => surface.map));
  const reachable = reach(OPTION_COVERAGE);
  const companions = totals(Object.values(COMPANION_SURFACES));
  const open = openGaps();

  const rows = (status: OptionCoverage["status"]) =>
    Object.entries(OPTION_COVERAGE)
      .filter(([, entry]) => entry.status === status)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([flag, entry]) => `| \`${flag}\` | ${describe(entry)} |`);

  const actionGaps = Object.entries(ACTION_COVERAGE)
    .filter(([, entry]) => entry.status === "n/a")
    .map(([name]) => `\`${name}\``);

  return [
    START,
    "",
    `**Coverage: ${overall.percent}% of the ${overall.total} leaves \`xcodebuild\` documents** — every option, build action, export options key, \`-create-xcframework\` argument, and the second forms that only a usage line mentions.`,
    "",
    `A leaf is one switch you could type. Counting options alone says ${options.percent}% (${options.total}/${options.total}), which was true and hid every gap below: an option is one thing, and \`-exportOptionsPlist\` alone opens eighteen more.`,
    "",
    "| Surface | Leaves | Covered |",
    "| --- | --- | --- |",
    ...surfaceRows(XCODEBUILD_SURFACES),
    `| **total** | **${overall.total}** | **${overall.covered} (${overall.percent}%)** |`,
    "",
    `**Reach: ${reachable.percent}%** of the ${reachable.pairs} command-and-option pairs. The same options, counted once per command xcodebuild accepts them on — because \`-target\` exposed on \`build\` and missing from \`settings\` is not covered for anyone asking \`settings\`. ${reachable.missing} pairs are open.`,
    "",
    `${options.exposed} options map to an \`xcodebuild-axi\` flag. The other ${options.always + options.superseded} are reachable without one:`,
    "",
    "| Option | How |",
    "| --- | --- |",
    ...rows("always"),
    ...rows("superseded"),
    ...(actionGaps.length > 0
      ? [
          "",
          `The one action left out is ${actionGaps.join(", ")} — it copies sources into \`SRCROOT\` as root, which is a packaging step rather than anything an agent loop needs.`,
        ]
      : []),
    "",
    "### Companion tools",
    "",
    `\`xcresulttool\`, \`xccov\` and \`simctl\` are not xcodebuild, so they are not in the number above — but this tool wraps all three, and an agent that has to shell out to one directly has dropped back down. **${companions.percent}% of ${companions.total} leaves**, counted the same way:`,
    "",
    "| Tool | Leaves | Covered |",
    "| --- | --- | --- |",
    ...surfaceRows(
      Object.entries(COMPANION_SURFACES).map(([name, map]) => ({
        name: `\`${name}\``,
        map,
      })),
    ),
    ...(open.length > 0
      ? [
          "",
          "### Still open",
          "",
          `${open.length} leaves are known gaps rather than decisions — each one a reason someone would still reach for the raw tool:`,
          "",
          "| Leaf | Unreachable from | What that costs |",
          "| --- | --- | --- |",
          ...open,
        ]
      : []),
    "",
    `The denominator is read from \`xcodebuild -help\` rather than hand-maintained, and this table is written against **Xcode ${AUTHORED_AGAINST}** — the option list moves between releases. \`npm run coverage:check\` fails on that Xcode if an option here is unclassified or has been dropped, and reports the difference without failing on any other.`,
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
  const { percent: covered } = totals(
    XCODEBUILD_SURFACES.map((surface) => surface.map),
  );
  const color =
    covered >= 90 ? "brightgreen" : covered >= 75 ? "yellow" : "orange";
  return `${BADGE_START}<img alt="xcodebuild coverage" src="https://img.shields.io/badge/xcodebuild_coverage-${covered}%25-${color}?style=flat-square" />${BADGE_END}`;
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
  const version = await liveXcodeVersion();
  // Only the Xcode this map was written against can prove it stale. Any other
  // version disagrees for reasons that are not a defect in this file, and
  // failing on that would make the check impossible to keep green anywhere but
  // one machine.
  const authoritative = version === AUTHORED_AGAINST;

  if (problems.length > 0 && authoritative) {
    for (const problem of problems) console.error(problem);
    console.error(
      "\nAdd the missing options to src/surface.ts, then rerun `npm run coverage`.",
    );
    process.exit(1);
  }

  if (problems.length > 0) {
    console.warn(
      `xcodebuild ${version ?? "of an unknown version"} differs from the Xcode ${AUTHORED_AGAINST} this map was written against:`,
    );
    for (const problem of problems) console.warn(`  ${problem}`);
    console.warn(
      `\nNot a failure — only Xcode ${AUTHORED_AGAINST} can say this map is stale. To move the map forward, run \`npm run coverage\` on that Xcode and bump AUTHORED_AGAINST in src/surface.ts.`,
    );
  } else if (authoritative) {
    console.log(`classification matches Xcode ${AUTHORED_AGAINST} exactly`);
  }
}

const summary = () => {
  const overall = totals(XCODEBUILD_SURFACES.map((surface) => surface.map));
  const reachable = reach(OPTION_COVERAGE);
  const companions = totals(Object.values(COMPANION_SURFACES));
  return [
    `xcodebuild ${overall.percent}% (${overall.covered}/${overall.total} leaves)`,
    `reach ${reachable.percent}% (${reachable.reached}/${reachable.pairs} pairs)`,
    `companions ${companions.percent}% (${companions.covered}/${companions.total})`,
  ].join(", ");
};

if (check) {
  if (updated !== readme) {
    console.error(
      "README.md coverage section is stale — run `npm run coverage`",
    );
    process.exit(1);
  }
  console.log(`${summary()} — up to date`);
} else {
  writeFileSync(readmePath, updated);
  console.log(`README.md updated: ${summary()}`);
}
