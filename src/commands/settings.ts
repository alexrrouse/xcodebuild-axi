import { AxiError } from "../errors.js";
import { requireProject } from "../context.js";
import { resolveSubject } from "../scheme.js";
import { resolveDestination } from "../destination.js";
import { runMetadata } from "../xcodebuild.js";
import { renderFields, renderHelp, renderList, renderOutput } from "../toon.js";
import {
  getFlag,
  getIntFlag,
  getListFlag,
  hasFlag,
  rejectUnknownFlags,
} from "../args.js";

export const SETTINGS_HELP = `usage: xcodebuild-axi settings [flags]
Reads resolved build settings. Asking for the keys you want turns a 40 KB dump
into a few lines.
flags[18]:
  --scheme <name>         scheme to resolve against (required only when the project has more than one)
  --target <name>         resolve a target instead of a scheme; repeatable (project only)
  --all-targets           resolve every target in the project (project only)
  --key <NAME>            setting to read; repeatable or comma-separated
  --configuration <name>  build configuration to resolve against
  --device <name>         resolve against a simulator or device by name, e.g. "iPhone 17 Pro"
  --destination <spec>    raw xcodebuild destination specifier, passed through untouched
  --destination-timeout <secs>  how long to wait for the destination device
  --sdk <name>            base SDK to resolve against, e.g. iphonesimulator
  --arch <arch>           architecture to resolve against; repeatable or comma-separated
  --toolchain <name>      toolchain identifier or name
  --xcconfig <path>       apply this file's settings as overrides before resolving
  --derived-data <path>   derived data directory, which the build paths are under
  --setting KEY=VALUE     override a setting before resolving; repeatable or comma-separated
  --all                   dump every setting (large — hundreds of keys)
  --for-index             the per-source-file settings an indexer sees
  --file <path>           with --for-index: the one source file to report on
  --full                  with --for-index --file: list the long argument arrays
note:
  Paths and platform names are destination-dependent. With no --device,
  --destination or --sdk, xcodebuild resolves against the default SDK, which is
  the *device* SDK -- so BUILT_PRODUCTS_DIR comes back under Debug-iphoneos
  while build and test default to a simulator. The reported platform names
  what the answer is for.
  --setting and --xcconfig answer "what would this be if I overrode that",
  which is the question -showBuildSettings exists for. --derived-data matters
  because every build path -- BUILT_PRODUCTS_DIR and everything under it --
  hangs off it, so the default answer describes a directory CI does not use.
  --for-index answers a different question from the rest of this command: it
  reports the compiler invocation the indexer builds per source file. The raw
  payload measured 216 KB on a 12-scheme workspace, so without --file it
  reports only which targets have index settings and how many files each has.
examples:
  xcodebuild-axi settings --key PRODUCT_BUNDLE_IDENTIFIER,MARKETING_VERSION
  xcodebuild-axi settings --target MyApp --key SWIFT_VERSION
  xcodebuild-axi settings --scheme MyApp --setting SWIFT_STRICT_CONCURRENCY=complete --key SWIFT_STRICT_CONCURRENCY
  xcodebuild-axi settings --scheme MyApp --key SWIFT_VERSION
  xcodebuild-axi settings --scheme MyApp --device "iPhone 17 Pro" --key BUILT_PRODUCTS_DIR
  xcodebuild-axi settings --scheme MyApp --for-index --file MyApp/AppFeature.swift
`;

export const SETTINGS_FLAGS = [
  "--scheme",
  "--target",
  "--all-targets",
  "--key",
  "--configuration",
  "--device",
  "--destination",
  "--destination-timeout",
  "--sdk",
  "--arch",
  "--toolchain",
  "--xcconfig",
  "--derived-data",
  "--setting",
  "--all",
  "--for-index",
  "--file",
  "--full",
] as const;
const VALUE_FLAGS = [
  "--scheme",
  "--target",
  "--key",
  "--configuration",
  "--device",
  "--destination",
  "--destination-timeout",
  "--sdk",
  "--arch",
  "--toolchain",
  "--xcconfig",
  "--derived-data",
  "--setting",
  "--file",
] as const;

export async function settingsCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "settings", SETTINGS_FLAGS, VALUE_FLAGS);

  const keys = getListFlag(args, "--key");
  const all = hasFlag(args, "--all");
  const forIndex = hasFlag(args, "--for-index");

  if (keys.length === 0 && !all && !forIndex) {
    throw new AxiError("settings needs --key or --all", "VALIDATION_ERROR", [
      "xcodebuild-axi settings --key PRODUCT_BUNDLE_IDENTIFIER",
      "xcodebuild-axi settings --all  # every setting, hundreds of lines",
    ]);
  }

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
    "settings",
  );
  const scheme = subject.label;
  const configuration = getFlag(args, "--configuration");
  const sdk = getFlag(args, "--sdk");
  const toolchain = getFlag(args, "--toolchain");
  const xcconfig = getFlag(args, "--xcconfig");
  const derivedData = getFlag(args, "--derived-data");
  const destinationTimeout = getIntFlag(args, "--destination-timeout");

  const overrides = getListFlag(args, "--setting");
  for (const setting of overrides) {
    if (!setting.includes("=")) {
      throw new AxiError(
        `--setting expects KEY=VALUE, got '${setting}'`,
        "VALIDATION_ERROR",
        [
          "xcodebuild-axi settings --setting SWIFT_VERSION=6 --key SWIFT_VERSION",
        ],
      );
    }
  }

  // Without a destination xcodebuild resolves against the default *device*
  // SDK, so BUILT_PRODUCTS_DIR and PLATFORM_NAME describe a build that
  // `xcodebuild-axi build` -- which defaults to the newest simulator -- never
  // performs. Reading the `.app` path out of that answer sends you to an
  // iphoneos directory for a simulator build. Only resolve when asked, so the
  // default answer does not move under anyone.
  const rawDestination = getFlag(args, "--destination");
  const device = getFlag(args, "--device");
  // Destinations are listed per scheme, so target mode has nothing to resolve
  // a device *name* against — a whole specifier still passes through.
  if (subject.targetMode && device !== undefined) {
    throw new AxiError(
      "--device is resolved against a scheme, and --target names no scheme",
      "VALIDATION_ERROR",
      [
        "Pass the whole specifier instead: --destination 'platform=iOS Simulator,name=iPhone 17 Pro'",
        "Or resolve against a scheme with `--scheme <name>`",
      ],
    );
  }

  const destination = subject.targetMode
    ? rawDestination
    : rawDestination !== undefined || device !== undefined
      ? (
          await resolveDestination({
            project,
            scheme,
            ...(device !== undefined ? { device } : {}),
            ...(rawDestination !== undefined ? { raw: rawDestination } : {}),
          })
        ).specifier
      : undefined;

  const { stdout, stderr, exitCode } = await runMetadata([
    ...project.flags,
    ...subject.flags,
    ...(configuration ? ["-configuration", configuration] : []),
    ...(destination ? ["-destination", destination] : []),
    ...(destinationTimeout !== undefined
      ? ["-destination-timeout", String(destinationTimeout)]
      : []),
    ...(sdk ? ["-sdk", sdk] : []),
    ...getListFlag(args, "--arch").flatMap((arch) => ["-arch", arch]),
    ...(toolchain ? ["-toolchain", toolchain] : []),
    ...(xcconfig ? ["-xcconfig", xcconfig] : []),
    ...(derivedData ? ["-derivedDataPath", derivedData] : []),
    forIndex ? "-showBuildSettingsForIndex" : "-showBuildSettings",
    "-json",
    // Overrides go last, the way xcodebuild reads `KEY=VALUE` arguments.
    ...overrides,
  ]);

  // A rejected combination of flags exits non-zero and still prints a JSON
  // document -- an empty one. Parsing that and reporting every key as `unset`
  // reads exactly like a correct answer about a target with no settings, so
  // the refusal has to be surfaced rather than parsed past. xcodebuild
  // rejects more combinations than this command can enumerate up front
  // (`-derivedDataPath` without a scheme is one), so this is the general net.
  if (exitCode !== 0) {
    throw new AxiError(
      `xcodebuild could not resolve settings for ${subject.label}`,
      "VALIDATION_ERROR",
      [
        ...xcodebuildComplaint(stderr),
        ...(subject.targetMode
          ? [
              "Some options are only accepted alongside a scheme — try `--scheme <name>`",
            ]
          : []),
      ],
    );
  }

  if (forIndex) {
    return reportIndexSettings(
      stdout,
      scheme,
      getFlag(args, "--file"),
      hasFlag(args, "--full"),
    );
  }

  const settings = parseSettings(stdout);

  const platform = platformOf(settings);
  // `scheme: MyApp` is a lie when targets were named, and the label is the
  // reader's only clue about which question was answered.
  const subjectField = subject.targetMode ? { targets: scheme } : { scheme };

  if (all) {
    return renderOutput([
      renderFields({
        ...subjectField,
        ...platform,
        settings: Object.keys(settings).length,
      }),
      renderFields({ ...settings }),
    ]);
  }

  // xcodebuild answers `[]` -- exit 0, no targets -- when nothing in the
  // scheme is buildable for the destination it resolved against. Running the
  // per-key loop over that reports every key as `unset`, which is the same
  // answer as a key that genuinely is not set, so the two have to be told
  // apart before the loop rather than inside it.
  if (Object.keys(settings).length === 0) {
    return renderOutput([
      renderFields({
        ...subjectField,
        settings: "none — xcodebuild resolved no targets to read settings from",
      }),
      renderHelp([
        "-showBuildSettings answers with an empty list rather than an error, so this is not a failure",
        "A Swift package's scheme resolves nothing here at all; a project scheme with no buildable for the resolved platform does the same",
        `Run \`xcodebuild-axi settings ${subject.rerun} --destination <spec>\` to resolve against another platform`,
      ]),
    ]);
  }

  const found: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const key of keys) {
    const value = settings[key];
    if (value === undefined) missing.push(key);
    else found[key] = value;
  }

  const blocks = [renderFields({ ...subjectField, ...platform })];

  if (Object.keys(found).length > 0) {
    blocks.push(renderFields({ settings: found }));
  }

  if (missing.length > 0) {
    // A key that does not exist is an answer, not an error — say so plainly
    // rather than returning an empty block the agent has to re-query to trust.
    blocks.push(renderFields({ unset: missing }));
    blocks.push(
      renderHelp([
        `Run \`xcodebuild-axi settings ${subject.rerun} --all\` to see every key this resolves`,
      ]),
    );
  }

  return renderOutput(blocks);
}

/**
 * xcodebuild's own one-line reason, which names the flag it objected to and is
 * more specific than anything this command could infer from the arguments.
 */
export function xcodebuildComplaint(stderr: string): string[] {
  const line = stderr
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("xcodebuild: error:"));
  return line ? [line.replace(/^xcodebuild: error:\s*/, "")] : [];
}

/**
 * Name the platform an answer is for. These settings are destination-dependent
 * and the destination is easy not to think about, so the report says which one
 * it resolved against rather than leaving the reader to assume.
 */
export function platformOf(
  settings: Record<string, unknown>,
): { platform: string } | Record<string, never> {
  const name = settings["PLATFORM_NAME"];
  return typeof name === "string" && name.length > 0 ? { platform: name } : {};
}

/** `{ target: { sourceFilePath: { setting: value } } }`. */
type IndexSettings = Record<string, Record<string, Record<string, unknown>>>;

/**
 * `-showBuildSettingsForIndex` is the one query in this family whose full
 * output is never worth printing: it repeats the entire Swift driver command
 * line for every source file in the scheme. Report the shape, or one file.
 */
function reportIndexSettings(
  stdout: string,
  scheme: string,
  file: string | undefined,
  full: boolean,
): string {
  const start = stdout.indexOf("{");
  let parsed: IndexSettings;
  try {
    parsed = JSON.parse(stdout.slice(start < 0 ? 0 : start)) as IndexSettings;
  } catch {
    parsed = {};
  }

  const targets = Object.entries(parsed);
  if (targets.length === 0) {
    return renderOutput([
      renderFields({
        scheme,
        index_settings: "none — the scheme builds no indexable sources",
      }),
    ]);
  }

  if (file === undefined) {
    return renderOutput([
      renderFields({ scheme }),
      renderList(
        "targets",
        targets.map(([target, files]) => ({
          target,
          files: Object.keys(files).length,
        })),
      ),
      renderHelp([
        "Add `--file <path>` to see the compiler settings for one source file",
      ]),
    ]);
  }

  const match = findFile(targets, file);
  if (!match) {
    // The path is the caller's, so echo what was searched rather than making
    // them guess whether the file or the scheme was wrong.
    throw new AxiError(
      `No index settings for '${file}' in scheme ${scheme}`,
      "NOT_FOUND",
      [
        `the scheme indexes ${plural(
          targets.reduce(
            (sum, [, files]) => sum + Object.keys(files).length,
            0,
          ),
          "file",
        )} across ${plural(targets.length, "target")}`,
        `Run \`xcodebuild-axi settings --scheme ${scheme} --for-index\` to see the targets`,
      ],
    );
  }

  const [target, path, settings] = match;
  // swiftASTCommandArguments alone is several hundred entries of compiler flags.
  const rendered = Object.fromEntries(
    Object.entries(settings).map(([key, value]) => [
      key,
      Array.isArray(value) && !full
        ? `${plural(value.length, "entry", "entries")} — pass --full to list them`
        : value,
    ]),
  );

  return renderOutput([
    renderFields({ scheme, target, file: relativeToCwd(path) }),
    renderFields(rendered),
  ]);
}

/** Match on suffix, so a repo-relative path works as well as an absolute one. */
function findFile(
  targets: Array<[string, Record<string, Record<string, unknown>>]>,
  file: string,
): [string, string, Record<string, unknown>] | undefined {
  const needle = file.replace(/^\.\//, "");
  for (const [target, files] of targets) {
    for (const [path, settings] of Object.entries(files)) {
      if (path === file || path.endsWith(`/${needle}`)) {
        return [target, path, settings];
      }
    }
  }
  return undefined;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function relativeToCwd(path: string): string {
  const cwd = `${process.cwd()}/`;
  return path.startsWith(cwd) ? path.slice(cwd.length) : path;
}

/**
 * `-showBuildSettings -json` emits an array of one object per target, each
 * with a `buildSettings` map. Later targets win on collision, which matches
 * the order xcodebuild itself resolves them in.
 */
function parseSettings(stdout: string): Record<string, string> {
  const start = stdout.indexOf("[");
  if (start === -1) return {};
  let parsed: { buildSettings?: Record<string, string> }[];
  try {
    parsed = JSON.parse(stdout.slice(start)) as {
      buildSettings?: Record<string, string>;
    }[];
  } catch {
    return {};
  }
  const merged: Record<string, string> = {};
  for (const entry of parsed) {
    Object.assign(merged, entry.buildSettings ?? {});
  }
  return merged;
}
