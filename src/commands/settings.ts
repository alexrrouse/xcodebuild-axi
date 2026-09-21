import { AxiError } from "../errors.js";
import { requireProject } from "../context.js";
import { requireScheme } from "../scheme.js";
import { runMetadata } from "../xcodebuild.js";
import { renderFields, renderHelp, renderList, renderOutput } from "../toon.js";
import { getFlag, getListFlag, hasFlag, rejectUnknownFlags } from "../args.js";

export const SETTINGS_HELP = `usage: xcodebuild-axi settings [flags]
Reads resolved build settings. Asking for the keys you want turns a 40 KB dump
into a few lines.
flags[7]:
  --scheme <name>         scheme to resolve against (required only when the project has more than one)
  --key <NAME>            setting to read; repeatable or comma-separated
  --configuration <name>  build configuration to resolve against
  --all                   dump every setting (large — hundreds of keys)
  --for-index             the per-source-file settings an indexer sees
  --file <path>           with --for-index: the one source file to report on
  --full                  with --for-index --file: list the long argument arrays
note:
  --for-index answers a different question from the rest of this command: it
  reports the compiler invocation the indexer builds per source file. The raw
  payload measured 216 KB on a 12-scheme workspace, so without --file it
  reports only which targets have index settings and how many files each has.
examples:
  xcodebuild-axi settings --key PRODUCT_BUNDLE_IDENTIFIER,MARKETING_VERSION
  xcodebuild-axi settings --scheme Tides --key SWIFT_VERSION
  xcodebuild-axi settings --scheme Tides --for-index --file Tides/AppFeature.swift
`;

const FLAGS = [
  "--scheme",
  "--key",
  "--configuration",
  "--all",
  "--for-index",
  "--file",
  "--full",
] as const;
const VALUE_FLAGS = ["--scheme", "--key", "--configuration", "--file"] as const;

export async function settingsCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "settings", FLAGS, VALUE_FLAGS);

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
  const scheme = await requireScheme(
    project,
    getFlag(args, "--scheme"),
    "settings",
  );
  const configuration = getFlag(args, "--configuration");

  const { stdout } = await runMetadata([
    ...project.flags,
    "-scheme",
    scheme,
    ...(configuration ? ["-configuration", configuration] : []),
    forIndex ? "-showBuildSettingsForIndex" : "-showBuildSettings",
    "-json",
  ]);

  if (forIndex) {
    return reportIndexSettings(
      stdout,
      scheme,
      getFlag(args, "--file"),
      hasFlag(args, "--full"),
    );
  }

  const settings = parseSettings(stdout);

  if (all) {
    return renderOutput([
      renderFields({ scheme, settings: Object.keys(settings).length }),
      renderFields({ ...settings }),
    ]);
  }

  const found: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const key of keys) {
    const value = settings[key];
    if (value === undefined) missing.push(key);
    else found[key] = value;
  }

  const blocks = [renderFields({ scheme })];

  if (Object.keys(found).length > 0) {
    blocks.push(renderFields({ settings: found }));
  }

  if (missing.length > 0) {
    // A key that does not exist is an answer, not an error — say so plainly
    // rather than returning an empty block the agent has to re-query to trust.
    blocks.push(renderFields({ unset: missing.join(",") }));
    blocks.push(
      renderHelp([
        `Run \`xcodebuild-axi settings --scheme ${scheme} --all\` to see every key this scheme resolves`,
      ]),
    );
  }

  return renderOutput(blocks);
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
