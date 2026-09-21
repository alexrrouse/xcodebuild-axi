import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { resolveProject, type ProjectContext } from "../context.js";
import { listSchemes } from "../scheme.js";
import { artifactDir } from "../xcodebuild.js";
import { readTestSummary, describeDevice } from "../xcresult.js";
import {
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

  let newest: { path: string; mtime: number } | undefined;
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".xcresult")) continue;
      const path = join(dir, entry);
      const mtime = statSync(path).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { path, mtime };
    }
  } catch {
    return undefined;
  }
  if (!newest) return undefined;

  const summary = await readTestSummary(newest.path).catch(() => undefined);
  const when = relativeTime(newest.mtime / 1000);
  const where = `see \`xcodebuild-axi result ${tildePath(newest.path)}\``;
  const kind = runKind(newest.path);

  // `xcresulttool` answers the test-shaped query for *any* bundle, so a build
  // comes back as `{title: "Test - X", totalTestCount: 0, result: "unknown"}`
  // rather than as nothing. Reading that as a verdict rendered a build as
  // "Test - X on unknown — 0 passed", which is the shape of a clean pass and
  // was observed on a real build bundle. The old guard did not catch it
  // because it tested for `undefined` and the count is `0`.
  //
  // Which command wrote the bundle is not a guess: `runLabel` names it
  // `<scheme>[-<device>]-<command>`, so the suffix is authoritative.
  if (kind !== "test") {
    return `${when} — ${kind} — ${where}`;
  }
  if (!summary || !summary.totalTestCount) {
    return `${when} — test recorded no tests — ${where}`;
  }

  const failed = summary.failedTests ?? 0;
  const device = describeDevice(summary.devicesAndConfigurations?.[0]?.device);
  const verdict =
    failed > 0
      ? `${failed} failed, ${summary.passedTests ?? 0} passed`
      : `${summary.passedTests ?? 0} passed`;
  return `${summary.title ?? "test"} on ${device} — ${verdict} (${when})`;
}

/**
 * Which command wrote a bundle, from the name `runLabel` gave it:
 * `<scheme>[-<device>]-<command>.xcresult`.
 */
export function runKind(path: string): string {
  const stem = basename(path, ".xcresult");
  const tail = stem.split("-").pop();
  // `basename` leaves the extension alone when stripping it would leave
  // nothing, so a degenerate ".xcresult" comes back whole. A command name
  // always starts with a letter, which is enough to tell the two apart.
  return tail && /^[A-Za-z]/.test(tail) ? tail : "run";
}
