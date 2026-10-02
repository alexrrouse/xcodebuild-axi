import { existsSync } from "node:fs";
import { logFor, newestBundle, type RecordedBundle } from "../bundles.js";
import { resolveProject, type ProjectContext } from "../context.js";
import { listSchemes } from "../scheme.js";
import { artifactDir } from "../xcodebuild.js";
import {
  buildErrorCount,
  buildStatus,
  readBuildResults,
  readTestSummary,
  readRepeatedRuns,
  describeDevice,
  type BuildResults,
} from "../xcresult.js";
import { testsNeverRan } from "./test.js";
import {
  plural,
  relativeTime,
  renderFields,
  renderHelp,
  renderOutput,
  tildePath,
} from "../toon.js";

const MAX_SCHEMES_SHOWN = 12;

/**
 * The no-argument view (AXI principles 7 and 8).
 *
 * This is what a session-start hook injects into every conversation, so it has
 * to be both immediately useful and ruthlessly cheap: what is here, what can
 * be built, and how the last run went. Nothing that needs a build, and nothing
 * that takes more than a moment — `-list -json` and one result bundle read.
 */
export async function homeCommand(): Promise<string> {
  const project = resolveProject();

  if (!project) {
    return renderOutput([
      renderFields({
        project: `no Xcode project in ${tildePath(process.cwd())}`,
      }),
      renderHelp([
        "cd to a directory holding a .xcworkspace, .xcodeproj, or Package.swift",
        "Run `xcodebuild-axi --help` for the full command list",
      ]),
    ]);
  }

  const [schemeInfo, lastRun] = await Promise.all([
    listSchemes(project).catch(() => undefined),
    describeLastRun(project),
  ]);

  const schemes = schemeInfo?.schemes ?? [];
  const shown = schemes.slice(0, MAX_SCHEMES_SHOWN);

  const blocks = [
    renderFields({
      [project.kind]: project.name,
      // Count and names as separate fields: a "12: A,B,C" value contains a
      // colon, which TOON then has to quote, costing more than the field it
      // saved.
      scheme_count: schemes.length,
      schemes: schemes.length === 0 ? "none shared" : shown,
    }),
  ];

  if (lastRun) blocks.push(renderFields({ last: lastRun }));

  const hints: string[] = [];
  const example = schemes.length === 1 ? "" : " --scheme <name>";
  if (schemes.length > 0) {
    hints.push(`Run \`xcodebuild-axi build${example}\` to build`);
    hints.push(`Run \`xcodebuild-axi test${example}\` to run tests`);
  }
  if (schemes.length > shown.length) {
    hints.push(
      `Run \`xcodebuild-axi schemes\` for all ${schemes.length} schemes`,
    );
  }
  blocks.push(renderHelp(hints));

  return renderOutput(blocks);
}

/**
 * Summarize the most recent run this tool recorded for the project.
 *
 * Read from our own artifact directory rather than anywhere in the repo, so
 * the home view never reports on a bundle some other tool left behind and
 * never reaches into a working tree.
 */
async function describeLastRun(
  project: ProjectContext,
): Promise<string | undefined> {
  const dir = artifactDir(project);

  const newest = newestBundle(dir).chosen;
  if (!newest) return undefined;

  const when = relativeTime(newest.mtimeMs / 1000);
  const where = `see \`xcodebuild-axi result ${tildePath(newest.path)}\``;
  const kind = newest.kind;

  // `xcresulttool` answers the test-shaped query for *any* bundle, so a build
  // comes back as `{title: "Test - X", totalTestCount: 0, result: "unknown"}`
  // rather than as nothing. Reading that as a verdict rendered a build as
  // "Test - X on unknown — 0 passed", which is the shape of a clean pass and
  // was observed on a real build bundle. The old guard did not catch it
  // because it tested for `undefined` and the count is `0`. Every other
  // kind is read through `build-results` instead, which is where its verdict
  // lives.
  //
  // Which command wrote the bundle is not a guess: `runLabel` names it
  // `<scheme>[-<device>]-<command>`, and `bundleKind` reads that back past
  // the per-run pid.
  if (kind !== "test") {
    if (!VERDICT_KINDS.has(kind)) return `${when} — ${kind} — ${where}`;
    const results = await readBuildResults(newest.path).catch(() => undefined);
    return `${when} — ${buildVerdict(kind, results) ?? kind} — ${pointer(newest, results, where)}`;
  }
  const summary = await readTestSummary(newest.path).catch(() => undefined);
  if (!summary || !summary.totalTestCount) {
    // Zero tests is as often a build that failed under them as an empty
    // run, and the test command tells the two apart the same way.
    const results = await readBuildResults(newest.path).catch(() => undefined);
    const verdict = testsNeverRan(summary, results)
      ? buildVerdict(kind, results)
      : undefined;
    return verdict
      ? `${when} — ${verdict} — ${pointer(newest, results, where)}`
      : `${when} — test recorded no tests — ${where}`;
  }

  // A repeated run's summary counts tests, so one failed run in ten would
  // read as a broken test. Only then is the tree worth a second read.
  const runs = await readRepeatedRuns(newest.path, summary);
  const failed = runs?.failed ?? summary.failedTests ?? 0;
  const passed = runs?.passed ?? summary.passedTests ?? 0;
  const device = describeDevice(summary.devicesAndConfigurations?.[0]?.device);
  const verdict = `${failed > 0 ? `${failed} failed, ` : ""}${passed} passed${runs ? ` of ${runs.runs} runs` : ""}`;
  return `${summary.title ?? "test"} on ${device} — ${verdict} (${when})`;
}

/**
 * The kinds whose bundle's build results are a verdict on the run. `tests`
 * stops before running anything and its bundle says nothing about whether
 * the listing worked, so it keeps the bare kind.
 */
const VERDICT_KINDS = new Set([
  "build",
  "build-for-testing",
  "install",
  "docbuild",
  "analyze",
  "archive",
  "clean",
  "run",
  "test",
]);

/**
 * How a run went, from its bundle's build results: `build succeeded`, `build
 * failed (2 errors)`. Undefined when the bundle does not say, so the caller
 * keeps the bare kind rather than guessing.
 *
 * Without this the home view named the last build and not whether it worked,
 * which is the one thing an agent opening a session wants to know about it.
 * A `run` bundle covers only the build, never the launch, and a `test` one is
 * read here only when its tests never ran, so both verdicts are the build's.
 * Statuses are matched against the words xcresulttool is known to use, so an
 * unexpected one cannot reach the output.
 */
export function buildVerdict(
  kind: string,
  results: BuildResults | undefined,
): string | undefined {
  if (!VERDICT_KINDS.has(kind) || !results) return undefined;
  const subject = kind === "run" || kind === "test" ? `${kind} build` : kind;
  const errors = buildErrorCount(results);
  const counted = errors > 0 ? ` (${plural(errors, "error")})` : "";
  const status = buildStatus(results);
  switch (status) {
    case "succeeded": {
      const analyzer = results.analyzerWarningCount ?? 0;
      return kind === "analyze" && analyzer > 0
        ? `${subject} succeeded (${plural(analyzer, "analyzer warning")})`
        : `${subject} succeeded`;
    }
    case "failed":
      return `${subject} failed${counted}`;
    // What an xcodebuild that died before building anything can record, with
    // no error to go with it (see AGENTS.md).
    case "notrequested":
      return counted
        ? `${subject} failed${counted}`
        : `${subject} failed before building`;
    case "cancelled":
    case "interrupted":
      return `${subject} ${status}${counted}`;
    default:
      return undefined;
  }
}

/**
 * Whether a bundle has nothing worth reading: it could not be read at all --
 * a run killed before it was finished, or one still going -- or it failed
 * without an error that says why. Then the transcript is the only witness.
 */
export function nothingToRead(results: BuildResults | undefined): boolean {
  return (
    !results ||
    (buildStatus(results) !== "succeeded" && buildErrorCount(results) === 0)
  );
}

/** Where to send the agent next: the bundle, or its log when that is empty. */
function pointer(
  bundle: RecordedBundle,
  results: BuildResults | undefined,
  where: string,
): string {
  const log = logFor(bundle.path);
  return nothingToRead(results) && existsSync(log)
    ? `see ${tildePath(log)}`
    : where;
}
