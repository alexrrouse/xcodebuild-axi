import { AxiError } from "../errors.js";
import { requireProject } from "../context.js";
import { requireScheme } from "../scheme.js";
import { runMetadata } from "../xcodebuild.js";
import { renderFields, renderHelp, renderOutput } from "../toon.js";
import { getFlag, getListFlag, hasFlag, rejectUnknownFlags } from "../args.js";

export const SETTINGS_HELP = `usage: xcodebuild-axi settings [flags]
Reads resolved build settings. Asking for the keys you want turns a 40 KB dump
into a few lines.
flags[4]:
  --scheme <name>         scheme to resolve against (required only when the project has more than one)
  --key <NAME>            setting to read; repeatable or comma-separated
  --configuration <name>  build configuration to resolve against
  --all                   dump every setting (large — hundreds of keys)
examples:
  xcodebuild-axi settings --key PRODUCT_BUNDLE_IDENTIFIER,MARKETING_VERSION
  xcodebuild-axi settings --scheme Tides --key SWIFT_VERSION
`;

const FLAGS = ["--scheme", "--key", "--configuration", "--all"] as const;
const VALUE_FLAGS = ["--scheme", "--key", "--configuration"] as const;

export async function settingsCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "settings", FLAGS, VALUE_FLAGS);

  const keys = getListFlag(args, "--key");
  const all = hasFlag(args, "--all");

  if (keys.length === 0 && !all) {
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
    "-showBuildSettings",
    "-json",
  ]);

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
