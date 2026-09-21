import { AxiError } from "../errors.js";
import { resolve } from "node:path";
import {
  describeDevice,
  readBuildResults,
  readTestSummary,
  toDiagnostics,
  type BuildResults,
} from "../xcresult.js";
import { diagnosticsBlock } from "../report.js";
import {
  duration,
  renderFields,
  renderHelp,
  renderList,
  renderOutput,
  tildePath,
  truncate,
} from "../toon.js";
import {
  getIntFlag,
  hasFlag,
  positionals,
  rejectUnknownFlags,
} from "../args.js";

export const RESULT_HELP = `usage: xcodebuild-axi result <path.xcresult> [flags]
Re-reads a result bundle that a previous run wrote, without rebuilding.
flags[4]:
  --failures     failures and errors only
  --warnings     include the full warning list
  --max <n>      rows to list before summarizing the rest (default: 20)
  --full         untruncated messages
examples:
  xcodebuild-axi result ~/Library/Caches/xcodebuild-axi/MyApps-1a2b3c4d/MyApp-iPhone-17-Pro-test.xcresult
  xcodebuild-axi result build/MyApp.xcresult --failures --full
`;

const FLAGS = ["--failures", "--warnings", "--max", "--full"] as const;

export async function resultCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "result", FLAGS, ["--max"]);

  const [rawPath] = positionals(args, ["--max"]);
  if (rawPath === undefined) {
    throw new AxiError(
      "result needs a path to an .xcresult bundle",
      "VALIDATION_ERROR",
      [
        "xcodebuild-axi result <path.xcresult>",
        "`xcodebuild-axi build` and `test` each print the path they wrote",
      ],
    );
  }

  const path = resolve(expandTilde(rawPath));
  const max = getIntFlag(args, "--max") ?? 20;
  const full = hasFlag(args, "--full");
  const failuresOnly = hasFlag(args, "--failures");

  const [summary, build] = await Promise.all([
    readTestSummary(path).catch(() => undefined),
    readBuildResults(path).catch(() => undefined),
  ]);

  if (!summary && !build) {
    throw new AxiError(
      `Nothing readable in the bundle at ${rawPath}`,
      "RESULT_NOT_FOUND",
    );
  }

  const blocks: string[] = [];

  // `xcresulttool` answers the test-shaped query for *any* bundle, so a build
  // comes back as `{title: "Test - X", totalTestCount: 0, result: "unknown"}`
  // rather than as nothing. Reading that as a verdict rendered a build as
  // `result: unknown / title: Test - X / 0 passed / 0 failed`, which is the
  // shape of a clean pass. `home.ts` fixed the same misread by trusting the
  // name `runLabel` gave the bundle, but `result` takes an arbitrary path --
  // its own help offers `build/MyApp.xcresult` -- so the name proves nothing
  // here and the count is the discriminator instead.
  if (summary && (summary.totalTestCount ?? 0) > 0) {
    const device = summary.devicesAndConfigurations?.[0]?.device;
    blocks.push(
      renderFields({
        result: summary.result?.toLowerCase() ?? "unknown",
        title: summary.title ?? "",
        destination: describeDevice(device),
        tests: `${summary.passedTests ?? 0} passed / ${summary.failedTests ?? 0} failed / ${summary.skippedTests ?? 0} skipped`,
        duration:
          summary.startTime !== undefined && summary.finishTime !== undefined
            ? duration(summary.finishTime - summary.startTime)
            : "unknown",
      }),
    );

    const failures = summary.testFailures ?? [];
    if (failures.length > 0) {
      const shown = failures.slice(0, max).map((failure) => ({
        test: failure.testIdentifierString ?? failure.testName ?? "unknown",
        target: failure.targetName ?? "",
        message: full
          ? (failure.failureText ?? "").replace(/\s+/g, " ").trim()
          : truncate(
              (failure.failureText ?? "").replace(/\s+/g, " ").trim(),
              300,
            ).text,
      }));
      blocks.push(
        renderList(
          failures.length > shown.length
            ? `failures (${shown.length} of ${failures.length})`
            : "failures",
          shown,
        ),
      );
    } else if (failuresOnly) {
      blocks.push(renderFields({ failures: "0 test failures in this bundle" }));
    }
  } else if (build) {
    blocks.push(renderFields(buildFields(build)));
  }

  if (build) {
    const errors = toDiagnostics(build.errors);
    const warnings = toDiagnostics([
      ...(build.warnings ?? []),
      ...(build.analyzerWarnings ?? []),
    ]);

    if (errors.length > 0) {
      blocks.push(
        diagnosticsBlock("errors", errors, max, full ? 4000 : 300).block,
      );
    }

    if (!failuresOnly) {
      if (warnings.length > 0 && hasFlag(args, "--warnings")) {
        blocks.push(
          diagnosticsBlock("warnings", warnings, max, full ? 4000 : 300).block,
        );
      } else if (warnings.length > 0) {
        blocks.push(renderFields({ warnings: warnings.length }));
      }
    }
  }

  blocks.push(renderFields({ bundle: tildePath(path) }));

  const hints: string[] = [];
  if (
    !hasFlag(args, "--warnings") &&
    (build?.warningCount ?? 0) > 0 &&
    !failuresOnly
  ) {
    hints.push(
      `Run \`xcodebuild-axi result ${rawPath} --warnings\` to list them`,
    );
  }
  blocks.push(renderHelp(hints));

  return renderOutput(blocks);
}

/**
 * The header a non-test bundle reports. A build bundle carries every field the
 * test-shaped query lacks: `actionTitle` names the action xcodebuild ran,
 * `status` is the verdict it recorded, and `destination` is the device it
 * actually landed on.
 */
export function buildFields(build: BuildResults): Record<string, string> {
  return {
    result: build.status?.toLowerCase() ?? "unknown",
    title: build.actionTitle ?? "",
    destination: describeDevice(build.destination),
    duration:
      build.startTime !== undefined && build.endTime !== undefined
        ? duration(build.endTime - build.startTime)
        : "unknown",
  };
}

function expandTilde(path: string): string {
  const home = process.env["HOME"];
  return home && path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}
