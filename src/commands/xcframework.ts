import { existsSync } from "node:fs";
import { AxiError } from "../errors.js";
import { runMetadata, stripPreamble } from "../xcodebuild.js";
import { renderFields, renderHelp, renderOutput, tildePath } from "../toon.js";
import { getFlag, hasFlag, orderedFlags, rejectUnknownFlags } from "../args.js";

export const XCFRAMEWORK_HELP = `usage: xcodebuild-axi xcframework --output <path.xcframework> [flags]
Bundles prebuilt frameworks or libraries into one .xcframework.
flags[7]:
  --output <path>         the .xcframework to write (required)
  --framework <path>      a built .framework to include; repeatable
  --library <path>        a built static or dynamic library to include; repeatable
  --headers <path>        headers for the library that precedes it; repeatable
  --archive <path>        take the next --framework or --library out of this .xcarchive
  --debug-symbols <path>  dSYMs or bcsymbolmaps for the slice that precedes it; repeatable
  --allow-internal-distribution  mark the result as not for public distribution
note:
  Order is meaning here, because it is meaning to xcodebuild: --headers and
  --debug-symbols attach to the --framework or --library they follow, and
  --archive applies to the one that follows it. After --archive, name the
  framework or library rather than giving a path to it.
  Ship dSYMs with anything a crash report has to be read from — an
  .xcframework built without --debug-symbols cannot be symbolicated.
examples:
  xcodebuild-axi xcframework --output Out.xcframework --framework A.framework --framework B.framework
  xcodebuild-axi xcframework --output Out.xcframework --library libA.a --headers include
  xcodebuild-axi xcframework --output MyLib.xcframework \\
    --archive ios.xcarchive --framework MyLib.framework --debug-symbols ios.xcarchive/dSYMs \\
    --archive sim.xcarchive --framework MyLib.framework --debug-symbols sim.xcarchive/dSYMs
`;

export const XCFRAMEWORK_FLAGS = [
  "--output",
  "--framework",
  "--library",
  "--headers",
  "--archive",
  "--debug-symbols",
  "--allow-internal-distribution",
] as const;

const VALUE_FLAGS = [
  "--output",
  "--framework",
  "--library",
  "--headers",
  "--archive",
  "--debug-symbols",
] as const;

/** The flags that name a slice of the xcframework rather than describing one. */
const SLICE_FLAGS = ["--framework", "--library"];

const XCODEBUILD_FLAG: Record<string, string> = {
  "--framework": "-framework",
  "--library": "-library",
  "--headers": "-headers",
  "--archive": "-archive",
  "--debug-symbols": "-debug-symbols",
};

export interface XcframeworkPlan {
  /** The `-create-xcframework` arguments, in the order they were given. */
  args: string[];
  frameworks: number;
  libraries: number;
  archives: number;
  /** Inputs that should exist on disk and do not. */
  missing: string[];
}

/**
 * Translate the command's flags into xcodebuild's, keeping their order.
 *
 * xcodebuild reads this argument list positionally — `-headers` belongs to the
 * `-library` before it, `-debug-symbols` to the slice before that, `-archive`
 * to the slice after it — so the translation is a walk rather than a regroup.
 */
export function planXcframework(args: string[]): XcframeworkPlan {
  const sequence = orderedFlags(args, Object.keys(XCODEBUILD_FLAG));

  const plan: XcframeworkPlan = {
    args: [],
    frameworks: 0,
    libraries: 0,
    archives: 0,
    missing: [],
  };

  let previous: string | undefined;
  /** The archive the next slice comes out of, if one was just named. */
  let pendingArchive: string | undefined;

  for (const { flag, value } of sequence) {
    if (flag === "--headers" && previous !== "--library") {
      throw new AxiError(
        "--headers describes the --library before it, and none precedes it",
        "VALIDATION_ERROR",
        [
          "xcodebuild-axi xcframework --output Out.xcframework --library libA.a --headers include",
        ],
      );
    }
    if (flag === "--debug-symbols" && !isSliceOrDescriptor(previous)) {
      throw new AxiError(
        "--debug-symbols describes the slice before it, and none precedes it",
        "VALIDATION_ERROR",
        [
          "Put --debug-symbols after the --framework or --library it belongs to",
        ],
      );
    }
    if (pendingArchive !== undefined && !SLICE_FLAGS.includes(flag)) {
      throw new AxiError(
        `--archive '${pendingArchive}' is not followed by a --framework or --library`,
        "VALIDATION_ERROR",
        ["Name the framework or library to take out of the archive next"],
      );
    }

    if (flag === "--framework") plan.frameworks += 1;
    if (flag === "--library") plan.libraries += 1;
    if (flag === "--archive") {
      plan.archives += 1;
      pendingArchive = value;
    } else if (SLICE_FLAGS.includes(flag)) {
      pendingArchive = undefined;
    }

    // Inside an archive a slice is named, not located, so only the paths that
    // are really paths are checked for.
    const isName = SLICE_FLAGS.includes(flag) && previous === "--archive";
    if (!isName && !existsSync(value)) plan.missing.push(value);

    plan.args.push(XCODEBUILD_FLAG[flag] as string, value);
    previous = flag;
  }

  if (pendingArchive !== undefined) {
    throw new AxiError(
      `--archive '${pendingArchive}' is not followed by a --framework or --library`,
      "VALIDATION_ERROR",
      ["Name the framework or library to take out of the archive next"],
    );
  }

  return plan;
}

function isSliceOrDescriptor(flag: string | undefined): boolean {
  return flag !== undefined && flag !== "--archive";
}

export async function xcframeworkCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "xcframework", XCFRAMEWORK_FLAGS, VALUE_FLAGS);

  const output = getFlag(args, "--output");
  if (output === undefined) {
    throw new AxiError("xcframework needs --output", "VALIDATION_ERROR", [
      "xcodebuild-axi xcframework --output Out.xcframework --framework A.framework",
    ]);
  }

  const plan = planXcframework(args);

  if (plan.frameworks === 0 && plan.libraries === 0) {
    throw new AxiError(
      "xcframework needs at least one --framework or --library",
      "VALIDATION_ERROR",
      [
        "xcodebuild-axi xcframework --output Out.xcframework --framework A.framework",
      ],
    );
  }

  if (plan.missing.length > 0) {
    // xcodebuild reports this one input at a time; naming them all at once
    // saves a round trip per missing path.
    throw new AxiError(
      `Missing input — ${plan.missing.join(", ")}`,
      "VALIDATION_ERROR",
      ["Build each slice first, then pass the built products here"],
    );
  }

  const internal = hasFlag(args, "--allow-internal-distribution");

  const { stdout, stderr, exitCode } = await runMetadata([
    "-create-xcframework",
    ...plan.args,
    ...(internal ? ["-allow-internal-distribution"] : []),
    "-output",
    output,
  ]);

  if (exitCode !== 0) {
    throw new AxiError(
      firstMeaningfulLine(`${stderr}\n${stdout}`) ||
        "Could not create the xcframework",
      "UNKNOWN",
    );
  }

  return renderOutput([
    renderFields({
      xcframework: tildePath(output),
      frameworks: plan.frameworks,
      libraries: plan.libraries,
      ...(plan.archives > 0 ? { archives: plan.archives } : {}),
      ...(internal ? { distribution: "internal only" } : {}),
    }),
    renderHelp([
      "Add the .xcframework to a target's Frameworks build phase to use it",
    ]),
  ]);
}

function firstMeaningfulLine(output: string): string {
  return (
    stripPreamble(output)
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}
