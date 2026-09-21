import { AxiError } from "../errors.js";
import { resolve } from "node:path";
import {
  describeDevice,
  readBuildResults,
  readTestSummary,
  toDiagnostics,
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
  xcodebuild-axi result ~/Library/Caches/xcodebuild-axi/Apps-1a2b3c4d/Futures-iPhone-17-Pro-test.xcresult
  xcodebuild-axi result build/Tides.xcresult --failures --full
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

  if (summary?.totalTestCount !== undefined) {
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

function expandTilde(path: string): string {
  const home = process.env["HOME"];
  return home && path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}
