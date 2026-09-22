import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AxiError } from "../errors.js";
import { simctl } from "../simctl.js";
import {
  globalArtifactDir,
  runBuild,
  runMetadata,
  stripPreamble,
} from "../xcodebuild.js";
import {
  duration,
  renderFields,
  renderHelp,
  renderList,
  renderOutput,
  tildePath,
} from "../toon.js";
import { getFlag, hasFlag, positionals, rejectUnknownFlags } from "../args.js";

export const PLATFORMS_HELP = `usage: xcodebuild-axi platforms [subcommand] [flags]
Installed simulator runtimes, and the toolchain downloads that add more.
subcommands[7]:
  (none)                     list the installed runtimes
  download <platform>        iOS, watchOS, tvOS, visionOS, or --all
  import <path.dmg>          install a runtime from a downloaded disk image
  component <op> <name>      show, download, import, or delete a component
  device-support             prepare symbols for a physical device
  first-launch               install bundled packages and accept the license
  license                    report whether the Xcode license has been accepted
flags[11]:
  --all                 with download: every platform Xcode offers
  --export-path <path>  download to this directory instead of installing
  --build-version <v>   a specific OS or asset build to fetch
  --arch-variant <v>    universal or arm64
  --import-path <path>  with \`component import\`: the bundle to install
  --platform <name>     with device-support: iOS, macOS, and so on
  --os-version <v>      with device-support: e.g. 26.0
  --model-code <code>   with device-support: e.g. iPhone16,1
  --architecture <arch> with device-support: e.g. arm64e
  --status              with first-launch: report whether it is needed, and stop
  --check-updates       with first-launch: also check for newer components
note:
  Downloads are multi-gigabyte and stream to a log rather than to stdout; the
  log path is printed either way. Known component: MetalToolchain.
exit:
  0 succeeded, 1 the download or install failed, 2 usage error
examples:
  xcodebuild-axi platforms
  xcodebuild-axi platforms download iOS
  xcodebuild-axi platforms component show MetalToolchain
  xcodebuild-axi platforms device-support --platform iOS --os-version 26.0
  xcodebuild-axi platforms license
`;

export const PLATFORMS_FLAGS = [
  "--all",
  "--export-path",
  "--build-version",
  "--arch-variant",
  "--import-path",
  "--platform",
  "--os-version",
  "--model-code",
  "--architecture",
  "--check-updates",
  "--status",
] as const;

const VALUE_FLAGS = [
  "--export-path",
  "--build-version",
  "--arch-variant",
  "--import-path",
  "--platform",
  "--os-version",
  "--model-code",
  "--architecture",
] as const;

const PLATFORMS = ["iOS", "watchOS", "tvOS", "visionOS"] as const;
const COMPONENT_OPS = ["show", "download", "import", "delete"] as const;

export async function platformsCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "platforms", PLATFORMS_FLAGS, VALUE_FLAGS);

  const [subcommand, ...rest] = positionals(args, VALUE_FLAGS);

  switch (subcommand) {
    case undefined:
      return listInstalled();
    case "download":
      return download(args, rest[0]);
    case "import":
      return importPlatform(rest[0]);
    case "component":
      return component(args, rest[0], rest[1]);
    case "device-support":
      return deviceSupport(args);
    case "first-launch":
      return firstLaunch(args);
    case "license":
      return license();
    default:
      throw new AxiError(
        `Unknown platforms subcommand '${subcommand}'`,
        "VALIDATION_ERROR",
        [
          "subcommands: download, import, component, device-support, first-launch",
        ],
      );
  }
}

interface Runtime {
  name?: string;
  platform?: string;
  version?: string;
  buildversion?: string;
  isAvailable?: boolean;
}

async function listInstalled(): Promise<string> {
  const { stdout, exitCode } = await simctl(["list", "runtimes", "-j"]);
  if (exitCode !== 0) {
    throw new AxiError("Could not read the installed runtimes", "UNKNOWN", [
      "Run `xcodebuild-axi platforms first-launch` if Xcode has never been opened",
    ]);
  }

  // Each runtime carries a `supportedDeviceTypes` array of ~100 entries; the
  // whole payload is ~200 KB and none of it answers "what is installed".
  const runtimes = (JSON.parse(stdout).runtimes ?? []) as Runtime[];

  if (runtimes.length === 0) {
    return renderOutput([
      renderFields({ runtimes: "0 installed" }),
      renderHelp([`Run \`xcodebuild-axi platforms download iOS\``]),
    ]);
  }

  const missing = PLATFORMS.filter(
    (platform) => !runtimes.some((runtime) => runtime.platform === platform),
  );

  return renderOutput([
    renderFields({ count: runtimes.length }),
    renderList(
      "runtimes",
      runtimes.map((runtime) => ({
        runtime: runtime.name ?? `${runtime.platform} ${runtime.version}`,
        build: runtime.buildversion ?? "unknown",
        available: runtime.isAvailable === false ? "no" : "yes",
      })),
    ),
    ...(missing.length > 0
      ? [renderFields({ not_installed: [...missing] })]
      : []),
    renderHelp([
      ...(missing.length > 0
        ? [`Run \`xcodebuild-axi platforms download ${missing[0]}\` to add one`]
        : []),
      "Run `xcodebuild-axi destinations` to see the devices these runtimes provide",
    ]),
  ]);
}

async function download(
  args: string[],
  platform: string | undefined,
): Promise<string> {
  const all = hasFlag(args, "--all");
  if (!all && platform === undefined) {
    throw new AxiError(
      "platforms download needs a platform or --all",
      "VALIDATION_ERROR",
      [
        `platforms: ${PLATFORMS.join(", ")}`,
        "xcodebuild-axi platforms download iOS",
      ],
    );
  }
  if (
    platform !== undefined &&
    !PLATFORMS.includes(platform as (typeof PLATFORMS)[number])
  ) {
    throw new AxiError(`Unknown platform '${platform}'`, "VALIDATION_ERROR", [
      `platforms: ${PLATFORMS.join(", ")}`,
    ]);
  }

  const buildVersion = getFlag(args, "--build-version");

  return longRun({
    args: [
      ...(all
        ? ["-downloadAllPlatforms"]
        : ["-downloadPlatform", platform as string]),
      ...exportPathArgs(args),
      ...(buildVersion ? ["-buildVersion", buildVersion] : []),
      ...archVariantArgs(args),
    ],
    label: `download-${all ? "all" : platform}`,
    key: "download",
    subject: all ? "all platforms" : (platform as string),
  });
}

async function importPlatform(path: string | undefined): Promise<string> {
  if (path === undefined) {
    throw new AxiError(
      "platforms import needs a path to a .dmg",
      "VALIDATION_ERROR",
      ["xcodebuild-axi platforms import ~/Downloads/iOS_26.dmg"],
    );
  }
  const full = resolve(path);
  if (!existsSync(full)) {
    throw new AxiError(`No disk image at ${path}`, "NOT_FOUND", [
      "Download one first with `xcodebuild-axi platforms download iOS --export-path <dir>`",
    ]);
  }

  return longRun({
    args: ["-importPlatform", full],
    label: "import-platform",
    key: "import",
    subject: tildePath(full),
  });
}

async function component(
  args: string[],
  op: string | undefined,
  name: string | undefined,
): Promise<string> {
  if (
    op === undefined ||
    !COMPONENT_OPS.includes(op as (typeof COMPONENT_OPS)[number])
  ) {
    throw new AxiError(
      op === undefined
        ? "platforms component needs an operation"
        : `Unknown component operation '${op}'`,
      "VALIDATION_ERROR",
      [
        `operations: ${COMPONENT_OPS.join(", ")}`,
        "xcodebuild-axi platforms component show MetalToolchain",
      ],
    );
  }
  if (name === undefined) {
    throw new AxiError(
      "platforms component needs a component name",
      "VALIDATION_ERROR",
      ["known component: MetalToolchain"],
    );
  }

  if (op === "show") {
    // -showComponent is fast and its JSON is two fields, so it can buffer.
    const { stdout, stderr, exitCode } = await runMetadata([
      "-showComponent",
      name,
      "-json",
    ]);
    if (exitCode !== 0) {
      throw new AxiError(
        firstLine(stderr) || `Could not read component '${name}'`,
        "NOT_FOUND",
        ["known component: MetalToolchain"],
      );
    }
    const parsed = parseJson(stdout);
    return renderOutput([
      renderFields({
        component: name,
        status: (parsed["status"] as string) ?? "unknown",
        ...(parsed["buildVersion"]
          ? { build: parsed["buildVersion"] as string }
          : {}),
      }),
      renderHelp(
        parsed["status"] === "uninstalled"
          ? [`Run \`xcodebuild-axi platforms component download ${name}\``]
          : [],
      ),
    ]);
  }

  if (op === "import") {
    const importPath = getFlag(args, "--import-path");
    if (importPath === undefined) {
      throw new AxiError(
        "component import needs --import-path",
        "VALIDATION_ERROR",
        [
          `xcodebuild-axi platforms component import ${name} --import-path <bundle>`,
        ],
      );
    }
    return longRun({
      args: ["-importComponent", name, "-importPath", resolve(importPath)],
      label: `component-import-${name}`,
      key: "component",
      subject: `${name} imported`,
    });
  }

  if (op === "delete") {
    return longRun({
      args: ["-deleteComponent", name],
      label: `component-delete-${name}`,
      key: "component",
      subject: `${name} deleted`,
    });
  }

  const buildVersion = getFlag(args, "--build-version");
  return longRun({
    args: [
      "-downloadComponent",
      name,
      ...exportPathArgs(args),
      ...(buildVersion ? ["-buildVersion", buildVersion] : []),
    ],
    label: `component-download-${name}`,
    key: "component",
    subject: `${name} downloaded`,
  });
}

async function deviceSupport(args: string[]): Promise<string> {
  const platform = getFlag(args, "--platform");
  const osVersion = getFlag(args, "--os-version");
  if (platform === undefined || osVersion === undefined) {
    throw new AxiError(
      "device-support needs both --platform and --os-version",
      "VALIDATION_ERROR",
      [
        "xcodebuild-axi platforms device-support --platform iOS --os-version 26.0",
      ],
    );
  }

  const modelCode = getFlag(args, "--model-code");
  const architecture = getFlag(args, "--architecture");

  return longRun({
    args: [
      "-prepareDeviceSupport",
      "-platform",
      platform,
      "-osVersion",
      osVersion,
      ...(modelCode ? ["-modelCode", modelCode] : []),
      ...(architecture ? ["-architecture", architecture] : []),
    ],
    label: `device-support-${platform}-${osVersion}`,
    key: "device_support",
    subject: `${platform} ${osVersion}`,
  });
}

async function firstLaunch(args: string[]): Promise<string> {
  if (hasFlag(args, "--status")) {
    // A question, not a mutation — and it needs no sudo, unlike the install.
    const { exitCode } = await runMetadata(["-checkFirstLaunchStatus"]);
    return renderOutput([
      renderFields({
        first_launch: exitCode === 0 ? "complete" : "required",
      }),
      renderHelp(
        exitCode === 0
          ? []
          : [
              "Run `sudo xcodebuild -runFirstLaunch` to install the bundled packages",
            ],
      ),
    ]);
  }

  return longRun({
    args: [
      "-runFirstLaunch",
      ...(hasFlag(args, "--check-updates") ? ["-checkForNewerComponents"] : []),
    ],
    label: "first-launch",
    key: "first_launch",
    subject: "bundled packages installed",
  });
}

/**
 * `-license` on its own opens the agreement in a pager and then asks for sudo.
 * `-license check` answers the only part of that an agent can act on — whether
 * the license is already accepted — and exits without printing or prompting.
 */
async function license(): Promise<string> {
  const { exitCode } = await runMetadata(["-license", "check"]);
  const accepted = exitCode === 0;
  if (!accepted) process.exitCode = 1;

  return renderOutput([
    renderFields({ license: accepted ? "accepted" : "not accepted" }),
    renderHelp(
      accepted
        ? []
        : [
            "Run `sudo xcodebuild -license accept` yourself — it needs a terminal this tool does not have",
          ],
    ),
  ]);
}

interface LongRunOptions {
  args: string[];
  label: string;
  key: string;
  subject: string;
}

/**
 * These invocations download gigabytes and need sudo for some components, so
 * they stream to a log like a build does rather than buffering.
 */
async function longRun(options: LongRunOptions): Promise<string> {
  const run = await runBuild({
    args: options.args,
    label: options.label,
    outDir: globalArtifactDir(),
  });

  if (run.exitCode !== 0) {
    process.exitCode = 1;
    return renderOutput([
      renderFields({
        [options.key]: "failed",
        error: firstError(run.tail),
        duration: duration(run.seconds),
        log: tildePath(run.logPath),
      }),
      renderHelp([
        "Some platform operations need `sudo`; rerun the printed xcodebuild command directly if so",
      ]),
    ]);
  }

  return renderOutput([
    renderFields({
      [options.key]: "succeeded",
      detail: options.subject,
      duration: duration(run.seconds),
      log: tildePath(run.logPath),
    }),
    renderHelp(["Run `xcodebuild-axi platforms` to confirm what is installed"]),
  ]);
}

function exportPathArgs(args: string[]): string[] {
  const path = getFlag(args, "--export-path");
  return path ? ["-exportPath", resolve(path)] : [];
}

function archVariantArgs(args: string[]): string[] {
  const variant = getFlag(args, "--arch-variant");
  return variant ? ["-architectureVariant", variant] : [];
}

function parseJson(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  if (start < 0) return {};
  try {
    return JSON.parse(text.slice(start)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function firstLine(text: string): string {
  return (
    stripPreamble(text)
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

function firstError(tail: string): string {
  return (
    stripPreamble(tail)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /error|failed|denied/i.test(line))
      .pop() ?? "xcodebuild reported no detail"
  );
}
