import { AxiError, mapXcodebuildError } from "../errors.js";
import { requireProject } from "../context.js";
import { requireScheme } from "../scheme.js";
import { destinationSlug, resolveDestination } from "../destination.js";
import { runBuild } from "../xcodebuild.js";
import { readBuildResults, toDiagnostics } from "../xcresult.js";
import { diagnosticsBlock, transcriptTail } from "../report.js";
import {
  duration,
  renderFields,
  renderHelp,
  renderOutput,
  tildePath,
} from "../toon.js";
import { getFlag, getIntFlag, hasFlag, rejectUnknownFlags } from "../args.js";

export const BUILD_HELP = `usage: xcodebuild-axi build [flags]
Builds a scheme and reports only what failed, with exact source locations.
flags[8]:
  --scheme <name>         scheme to build (required only when the project has more than one)
  --device <name>         simulator or device name, e.g. "iPhone 17 Pro" (default: newest simulator)
  --destination <spec>    raw xcodebuild destination specifier, passed through untouched
  --configuration <name>  build configuration (default: the scheme's own)
  --clean                 clean before building
  --sign                  allow code signing (off by default, so simulator builds need no team)
  --max-errors <n>        errors to list before summarizing the rest (default: 20)
  --full                  list every warning instead of the first 10
exit:
  0 build succeeded, 1 build failed, 2 usage error
examples:
  xcodebuild-axi build
  xcodebuild-axi build --scheme Futures --device "iPhone 17 Pro"
  xcodebuild-axi build --scheme Tides --configuration Release --clean
`;

const FLAGS = [
  "--scheme",
  "--device",
  "--destination",
  "--configuration",
  "--clean",
  "--sign",
  "--max-errors",
  "--full",
] as const;

const VALUE_FLAGS = [
  "--scheme",
  "--device",
  "--destination",
  "--configuration",
  "--max-errors",
] as const;

export async function buildCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "build", FLAGS, VALUE_FLAGS);

  const project = requireProject();
  const scheme = await requireScheme(
    project,
    getFlag(args, "--scheme"),
    "build",
  );
  const destination = await resolveDestination({
    project,
    scheme,
    ...(getFlag(args, "--device") !== undefined
      ? { device: getFlag(args, "--device") as string }
      : {}),
    ...(getFlag(args, "--destination") !== undefined
      ? { raw: getFlag(args, "--destination") as string }
      : {}),
  });

  const configuration = getFlag(args, "--configuration");
  const maxErrors = getIntFlag(args, "--max-errors") ?? 20;
  const full = hasFlag(args, "--full");

  const xcodebuildArgs = [
    ...project.flags,
    "-scheme",
    scheme,
    "-destination",
    destination.specifier,
    ...(configuration ? ["-configuration", configuration] : []),
    // Macro validation is an interactive trust prompt in disguise: unattended
    // it fails the build outright on any package using macros.
    "-skipMacroValidation",
    ...(hasFlag(args, "--sign") ? [] : ["CODE_SIGNING_ALLOWED=NO"]),
    ...(hasFlag(args, "--clean") ? ["clean"] : []),
    "build",
  ];

  const run = await runBuild({
    args: xcodebuildArgs,
    label: `${scheme}-${destinationSlug(destination.described)}-build`,
    project,
  });

  return renderBuildRun({
    action: "build",
    scheme,
    destination: destination.described,
    run,
    maxErrors,
    full,
  });
}

export interface RenderBuildRunOptions {
  action: string;
  scheme: string;
  destination: string;
  run: {
    exitCode: number;
    logPath: string;
    resultPath: string;
    seconds: number;
    tail: string;
  };
  maxErrors: number;
  full: boolean;
}

export async function renderBuildRun(
  options: RenderBuildRunOptions,
): Promise<string> {
  const { run } = options;
  const results = await readBuildResults(run.resultPath).catch(() => undefined);

  const errors = toDiagnostics(results?.errors);
  const warnings = toDiagnostics([
    ...(results?.warnings ?? []),
    ...(results?.analyzerWarnings ?? []),
  ]);
  const succeeded = run.exitCode === 0;

  // A bundle that records no error for a nonzero exit means xcodebuild died
  // before it built anything — a bad scheme, an unmatched destination, a
  // missing signing team. The transcript is the only witness.
  if (!succeeded && errors.length === 0) {
    const mapped = mapXcodebuildError(run.tail);
    if (mapped) {
      throw new AxiError(mapped.message, mapped.code, [
        ...mapped.suggestions,
        `full transcript: ${tildePath(run.logPath)}`,
      ]);
    }
  }

  const blocks: string[] = [
    renderFields({
      [options.action]: succeeded ? "succeeded" : "failed",
      scheme: options.scheme,
      destination: options.destination,
      duration: duration(run.seconds),
    }),
  ];

  const errorBlock = diagnosticsBlock("errors", errors, options.maxErrors);
  if (errorBlock.block) blocks.push(errorBlock.block);

  if (warnings.length > 0) {
    const warningBlock = diagnosticsBlock(
      "warnings",
      warnings,
      options.full ? warnings.length : 10,
    );
    blocks.push(warningBlock.block);
  } else if (succeeded) {
    blocks.push(renderFields({ warnings: 0 }));
  }

  if (!succeeded && errors.length === 0) {
    const tail = transcriptTail(run.tail);
    if (tail) blocks.push(tail);
  }

  blocks.push(
    renderFields({
      log: tildePath(run.logPath),
      result: tildePath(run.resultPath),
    }),
  );

  const hints: string[] = [];
  if (errorBlock.hidden > 0) {
    hints.push(
      `Run \`xcodebuild-axi ${options.action} --max-errors ${errors.length}\` to list all ${errors.length} errors`,
    );
  }
  if (!options.full && warnings.length > 10) {
    hints.push(
      `Run \`xcodebuild-axi ${options.action} --full\` to list all ${warnings.length} warnings`,
    );
  }
  if (!succeeded) {
    hints.push(
      `Run \`xcodebuild-axi result ${tildePath(run.resultPath)}\` to re-read this run without rebuilding`,
    );
  }
  blocks.push(renderHelp(hints));

  const output = renderOutput(blocks);
  if (!succeeded) {
    // The agent asked for a build and did not get one. Exit non-zero so `&&`
    // chains and CI stop, while the report itself still reaches stdout.
    process.exitCode = 1;
  }
  return output;
}
