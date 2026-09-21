import { existsSync } from "node:fs";
import { AxiError } from "../errors.js";
import { runMetadata, stripPreamble } from "../xcodebuild.js";
import { renderFields, renderHelp, renderOutput, tildePath } from "../toon.js";
import { getListFlag, getFlag, rejectUnknownFlags } from "../args.js";

export const XCFRAMEWORK_HELP = `usage: xcodebuild-axi xcframework --output <path.xcframework> [flags]
Bundles prebuilt frameworks or libraries into one .xcframework.
flags[4]:
  --output <path>     the .xcframework to write (required)
  --framework <path>  a built .framework to include; repeatable
  --library <path>    a built static or dynamic library to include; repeatable
  --headers <path>    headers for the library that precedes it; repeatable
note:
  --headers applies to the --library it follows, which is how xcodebuild pairs
  them. Give them in matching order.
examples:
  xcodebuild-axi xcframework --output Out.xcframework --framework A.framework --framework B.framework
  xcodebuild-axi xcframework --output Out.xcframework --library libA.a --headers include
`;

const FLAGS = ["--output", "--framework", "--library", "--headers"] as const;

export async function xcframeworkCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "xcframework", FLAGS, FLAGS);

  const output = getFlag(args, "--output");
  if (output === undefined) {
    throw new AxiError("xcframework needs --output", "VALIDATION_ERROR", [
      "xcodebuild-axi xcframework --output Out.xcframework --framework A.framework",
    ]);
  }

  const frameworks = getListFlag(args, "--framework");
  const libraries = getListFlag(args, "--library");
  const headers = getListFlag(args, "--headers");

  if (frameworks.length === 0 && libraries.length === 0) {
    throw new AxiError(
      "xcframework needs at least one --framework or --library",
      "VALIDATION_ERROR",
      [
        "xcodebuild-axi xcframework --output Out.xcframework --framework A.framework",
      ],
    );
  }

  const missing = [...frameworks, ...libraries].filter(
    (path) => !existsSync(path),
  );
  if (missing.length > 0) {
    // xcodebuild reports this one input at a time; naming them all at once
    // saves a round trip per missing path.
    throw new AxiError(
      `Missing input: ${missing.join(", ")}`,
      "VALIDATION_ERROR",
      ["Build each slice first, then pass the built products here"],
    );
  }

  const { stdout, stderr, exitCode } = await runMetadata([
    "-create-xcframework",
    ...frameworks.flatMap((path) => ["-framework", path]),
    ...libraries.flatMap((path, index) => [
      "-library",
      path,
      ...(headers[index] !== undefined
        ? ["-headers", headers[index] as string]
        : []),
    ]),
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
      frameworks: frameworks.length,
      libraries: libraries.length,
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
