import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AxiError, mapXcodebuildError } from "./errors.js";
import { requireProject, type ProjectContext } from "./context.js";
import { resolveSubject } from "./scheme.js";
import { destinationSlug, resolveDestination } from "./destination.js";
import { runBuild, type BuildRun } from "./xcodebuild.js";
import { readBuildResults, toDiagnostics } from "./xcresult.js";
import { diagnosticsBlock, transcriptTail } from "./report.js";
import {
  duration,
  renderFields,
  renderHelp,
  renderOutput,
  tildePath,
} from "./toon.js";
import { getFlag, getIntFlag, getListFlag, hasFlag } from "./args.js";
import {
  packageArgs,
  PACKAGE_FLAG_HELP,
  PACKAGE_FLAGS,
  PACKAGE_VALUE_FLAGS,
} from "./packages.js";

/**
 * The machinery shared by every command that runs an xcodebuild *action* —
 * build, analyze, archive, clean, and the test family. They differ in which
 * action word they pass and what they say afterwards; everything before that
 * (finding the project, resolving the scheme and destination, assembling
 * flags, streaming to a log, reading the bundle back) is identical, and was
 * worth extracting the first time a second command needed it.
 */

/** Flags every build-family command accepts. Keep in sync with `BUILD_FLAG_HELP`. */
export const SHARED_BUILD_FLAGS = [
  "--scheme",
  "--target",
  "--all-targets",
  "--device",
  "--destination",
  "--configuration",
  "--sdk",
  "--arch",
  "--toolchain",
  "--xcconfig",
  "--derived-data",
  "--artifacts-dir",
  "--jobs",
  "--setting",
  "--sign",
  "--allow-provisioning",
  "--sanitizer",
  "--timing",
  "--destination-timeout",
  "--parallelize-targets",
  "--hide-script-env",
  "--skip-unavailable-actions",
  "--max-errors",
  "--full",
  "--codesize",
  "--log-level",
  "--bundle-version",
  "--stream",
  ...PACKAGE_FLAGS,
] as const;

export const SHARED_BUILD_VALUE_FLAGS = [
  "--scheme",
  "--target",
  "--device",
  "--destination",
  "--configuration",
  "--sdk",
  "--arch",
  "--toolchain",
  "--xcconfig",
  "--derived-data",
  "--artifacts-dir",
  "--jobs",
  "--setting",
  "--sanitizer",
  "--destination-timeout",
  "--max-errors",
  "--codesize",
  "--log-level",
  "--bundle-version",
  "--stream",
  ...PACKAGE_VALUE_FLAGS,
] as const;

/** The shared flag block, so each command's `--help` stays consistent. */
export const BUILD_FLAG_HELP = `  --scheme <name>         scheme to act on (required only when the project has more than one)
  --target <name>         build a target instead of a scheme; repeatable (project only)
  --all-targets           build every target in the project (project only)
  --device <name>         simulator or device name, e.g. "iPhone 17 Pro" (default: newest simulator)
  --destination <spec>    raw xcodebuild destination specifier, passed through untouched
  --configuration <name>  build configuration (default: the scheme's own)
  --sdk <name>            base SDK, e.g. iphonesimulator
  --arch <arch>           architecture to build; repeatable or comma-separated
  --toolchain <name>      toolchain identifier or name
  --xcconfig <path>       apply build settings from this file as overrides
  --derived-data <path>   derived data directory
  --artifacts-dir <path>  where to write this run's log and .xcresult (default: the tool's cache)
  --jobs <n>              maximum concurrent build operations
  --setting KEY=VALUE     build setting override; repeatable or comma-separated
  --sign                  allow code signing (off by default, so simulator builds need no team)
  --allow-provisioning    let xcodebuild talk to the developer portal for profiles
  --sanitizer <name>      address, thread, or undefined; repeatable or comma-separated
  --timing                report per-command build timings
  --destination-timeout <secs>  how long to wait for the destination device
  --parallelize-targets   build independent targets in parallel
  --hide-script-env       omit shell script environment variables from the log
  --skip-unavailable-actions  skip scheme actions that cannot run instead of failing
  --max-errors <n>        errors to list before summarizing the rest (default: 20)
  --full                  list every warning instead of the first 10
  --codesize <dir>        write a code size profile to this directory
  --log-level <level>     quiet, normal, or verbose — how much lands in the log file
  --bundle-version <n>    result bundle format version (default: xcodebuild's own)
  --stream <path>         also write xcodebuild's live result stream here
${PACKAGE_FLAG_HELP}`;

/**
 * The flags that map straight onto an xcodebuild switch with no interpretation
 * beyond validation. Grouped so they can be tested without a project.
 */
export function buildPassthroughArgs(
  args: string[],
  command: string,
): string[] {
  return [
    ...codesizeArgs(args),
    ...logLevelArgs(args, command),
    ...streamArgs(args),
    ...bundleVersionArgs(args),
  ];
}

function bundleVersionArgs(args: string[]): string[] {
  const version = getIntFlag(args, "--bundle-version");
  return version === undefined ? [] : ["-resultBundleVersion", String(version)];
}

const LOG_LEVELS: Record<string, string[]> = {
  quiet: ["-quiet"],
  normal: [],
  verbose: ["-verbose"],
};

/**
 * The log file is a real artifact with a real size, even though the report
 * never comes from it. `--log-level quiet` shrinks it; `verbose` is for the
 * failures the result bundle cannot explain on its own.
 */
function logLevelArgs(args: string[], command: string): string[] {
  const level = getFlag(args, "--log-level");
  if (level === undefined) return [];
  const mapped = LOG_LEVELS[level];
  if (mapped === undefined) {
    throw new AxiError(`Unknown log level '${level}'`, "VALIDATION_ERROR", [
      "valid levels are quiet, normal, verbose",
      `xcodebuild-axi ${command} --log-level verbose`,
    ]);
  }
  return mapped;
}

/**
 * `-resultStreamPath` refuses a path that does not already exist, which is an
 * odd contract to pass on to a caller — so create the file first.
 */
function streamArgs(args: string[]): string[] {
  const path = getFlag(args, "--stream");
  if (path === undefined) return [];
  const full = resolve(path);
  mkdirSync(dirname(full), { recursive: true });
  if (!existsSync(full)) writeFileSync(full, "");
  return ["-resultStreamPath", full];
}

/** `-enableCodesizeProfile` is inert without an output directory, so one flag
 * sets both rather than letting a build run and produce nothing. */
function codesizeArgs(args: string[]): string[] {
  const dir = getFlag(args, "--codesize");
  return dir
    ? ["-enableCodesizeProfile", "YES", "-codesizeProfileOutputDir", dir]
    : [];
}

const SANITIZER_FLAGS: Record<string, string> = {
  address: "-enableAddressSanitizer",
  thread: "-enableThreadSanitizer",
  undefined: "-enableUndefinedBehaviorSanitizer",
};

export interface BuildContext {
  project: ProjectContext;
  /** The scheme, or a description of the targets when in target mode. */
  scheme: string;
  /** Human-readable destination, or undefined when the command skipped one. */
  destination: string | undefined;
  /** Everything before the action word. */
  xcodebuildArgs: string[];
  maxErrors: number;
  full: boolean;
  /** Where to write the log and result bundle, when the caller chose. */
  artifactsDir: string | undefined;
}

export interface ResolveBuildContextOptions {
  args: string[];
  command: string;
  /** Skip destination resolution — `clean` does not need one, and it costs a subprocess. */
  needsDestination?: boolean;
}

export async function resolveBuildContext(
  options: ResolveBuildContextOptions,
): Promise<BuildContext> {
  const { args, command } = options;
  const project = requireProject();

  const subject = await resolveSubject(
    project,
    {
      ...(getFlag(args, "--scheme") !== undefined
        ? { scheme: getFlag(args, "--scheme") as string }
        : {}),
      targets: getListFlag(args, "--target"),
      allTargets: hasFlag(args, "--all-targets"),
    },
    command,
  );
  const scheme = subject.label;
  const targetMode = subject.targetMode;

  const rawDestination = getFlag(args, "--destination");
  const device = getFlag(args, "--device");
  const needsDestination = options.needsDestination !== false;

  const destination =
    !targetMode &&
    (needsDestination || rawDestination !== undefined || device !== undefined)
      ? await resolveDestination({
          project,
          scheme,
          ...(device !== undefined ? { device } : {}),
          ...(rawDestination !== undefined ? { raw: rawDestination } : {}),
        })
      : undefined;

  const sanitizers = getListFlag(args, "--sanitizer");
  for (const sanitizer of sanitizers) {
    if (!(sanitizer in SANITIZER_FLAGS)) {
      throw new AxiError(
        `Unknown sanitizer '${sanitizer}'`,
        "VALIDATION_ERROR",
        ["valid sanitizers are address, thread, undefined"],
      );
    }
  }

  const settings = getListFlag(args, "--setting");
  for (const setting of settings) {
    if (!setting.includes("=")) {
      throw new AxiError(
        `--setting expects KEY=VALUE, got '${setting}'`,
        "VALIDATION_ERROR",
        [
          "xcodebuild-axi " +
            command +
            " --setting SWIFT_STRICT_CONCURRENCY=complete",
        ],
      );
    }
  }

  const configuration = getFlag(args, "--configuration");
  const sdk = getFlag(args, "--sdk");
  const toolchain = getFlag(args, "--toolchain");
  const xcconfig = getFlag(args, "--xcconfig");
  const derivedData = getFlag(args, "--derived-data");
  const jobs = getIntFlag(args, "--jobs");

  const destinationTimeout = getIntFlag(args, "--destination-timeout");

  const xcodebuildArgs = [
    ...project.flags,
    ...subject.flags,
    ...(destination ? ["-destination", destination.specifier] : []),
    ...(destinationTimeout !== undefined
      ? ["-destination-timeout", String(destinationTimeout)]
      : []),
    ...(configuration ? ["-configuration", configuration] : []),
    ...(sdk ? ["-sdk", sdk] : []),
    ...getListFlag(args, "--arch").flatMap((arch) => ["-arch", arch]),
    ...(toolchain ? ["-toolchain", toolchain] : []),
    ...(xcconfig ? ["-xcconfig", xcconfig] : []),
    ...(derivedData ? ["-derivedDataPath", derivedData] : []),
    ...(jobs !== undefined ? ["-jobs", String(jobs)] : []),
    ...sanitizers.flatMap((sanitizer) => [
      SANITIZER_FLAGS[sanitizer] as string,
      "YES",
    ]),
    ...(hasFlag(args, "--timing") ? ["-showBuildTimingSummary"] : []),
    ...(hasFlag(args, "--parallelize-targets") ? ["-parallelizeTargets"] : []),
    ...(hasFlag(args, "--hide-script-env")
      ? ["-hideShellScriptEnvironment"]
      : []),
    ...(hasFlag(args, "--skip-unavailable-actions")
      ? ["-skipUnavailableActions"]
      : []),
    // Macro validation is an interactive trust prompt in disguise: unattended
    // it fails the build outright on any package using macros.
    "-skipMacroValidation",
    ...(hasFlag(args, "--allow-provisioning")
      ? ["-allowProvisioningUpdates"]
      : []),
    ...buildPassthroughArgs(args, command),
    ...packageArgs(args),
    ...(hasFlag(args, "--sign") ? [] : ["CODE_SIGNING_ALLOWED=NO"]),
    ...settings,
  ];

  return {
    project,
    scheme,
    destination: destination?.described,
    xcodebuildArgs,
    maxErrors: getIntFlag(args, "--max-errors") ?? 20,
    full: hasFlag(args, "--full"),
    artifactsDir: artifactsDirFrom(args),
  };
}

/**
 * Where a run's log and result bundle should go, if the caller said.
 *
 * Resolved against the working directory: a CI job asking for `build/` means
 * the workspace it checked out, and `runBuild` will `mkdir -p` whatever it is
 * handed from wherever the process happens to be.
 */
export function artifactsDirFrom(args: string[]): string | undefined {
  const dir = getFlag(args, "--artifacts-dir");
  return dir === undefined ? undefined : resolve(dir);
}

/** A filesystem stem that distinguishes runs of different commands and devices. */
export function runLabel(context: BuildContext, command: string): string {
  const device = context.destination
    ? `-${destinationSlug(context.destination)}`
    : "";
  return `${context.scheme}${device}-${command}`;
}

export interface RunActionOptions {
  context: BuildContext;
  command: string;
  /** xcodebuild action words, in order, e.g. `["clean", "build"]`. */
  actions: string[];
  /** Extra arguments appended after the shared ones. */
  extraArgs?: string[];
}

export function runAction(options: RunActionOptions): Promise<BuildRun> {
  return runBuild({
    args: [
      ...options.context.xcodebuildArgs,
      ...(options.extraArgs ?? []),
      ...options.actions,
    ],
    label: runLabel(options.context, options.command),
    project: options.context.project,
    ...(options.context.artifactsDir !== undefined
      ? { outDir: options.context.artifactsDir }
      : {}),
  });
}

export interface ReportActionOptions {
  context: BuildContext;
  run: BuildRun;
  /** Field name and success wording, e.g. `{ key: "build", ok: "succeeded" }`. */
  key: string;
  ok: string;
  command: string;
  /** Extra fields rendered after the destination, e.g. an archive path. */
  extra?: Record<string, unknown>;
  /** Report analyzer warnings as the payload rather than as a count. */
  analyzer?: boolean;
}

/**
 * The shared report for any action that compiles something.
 *
 * Errors are the payload on failure, warnings on success, and the full
 * transcript is always a path away.
 */
export async function reportAction(
  options: ReportActionOptions,
): Promise<string> {
  const { run, context } = options;
  const results = await readBuildResults(run.resultPath).catch(() => undefined);

  const errors = toDiagnostics(results?.errors);
  const analyzerWarnings = toDiagnostics(results?.analyzerWarnings);
  const warnings = toDiagnostics([
    ...(results?.warnings ?? []),
    ...(options.analyzer ? [] : (results?.analyzerWarnings ?? [])),
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
      [options.key]: succeeded ? options.ok : "failed",
      scheme: context.scheme,
      ...(context.destination ? { destination: context.destination } : {}),
      duration: duration(run.seconds),
      ...(options.extra ?? {}),
    }),
  ];

  const errorBlock = diagnosticsBlock("errors", errors, context.maxErrors);
  if (errorBlock.block) blocks.push(errorBlock.block);

  if (options.analyzer) {
    if (analyzerWarnings.length > 0) {
      blocks.push(
        diagnosticsBlock(
          "issues",
          analyzerWarnings,
          context.full ? analyzerWarnings.length : 20,
        ).block,
      );
    } else if (succeeded) {
      blocks.push(renderFields({ issues: "0 analyzer issues found" }));
    }
  }

  if (warnings.length > 0) {
    blocks.push(
      diagnosticsBlock(
        "warnings",
        warnings,
        context.full ? warnings.length : 10,
      ).block,
    );
  } else if (succeeded && !options.analyzer) {
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
      `Run \`xcodebuild-axi ${options.command} --max-errors ${errors.length}\` to list all ${errors.length} errors`,
    );
  }
  if (!context.full && warnings.length > 10) {
    hints.push(
      `Run \`xcodebuild-axi ${options.command} --full\` to list all ${warnings.length} warnings`,
    );
  }
  if (!succeeded) {
    hints.push(
      `Run \`xcodebuild-axi result ${tildePath(run.resultPath)}\` to re-read this run without rebuilding`,
    );
  }
  blocks.push(renderHelp(hints));

  // The agent asked for a build and did not get one. Exit non-zero so `&&`
  // chains and CI stop, while the report itself still reaches stdout.
  if (!succeeded) process.exitCode = 1;
  return renderOutput(blocks);
}
