import { execFile } from "node:child_process";
import { AxiError } from "../errors.js";
import { runMetadata } from "../xcodebuild.js";
import { listSimulators } from "../simctl.js";
import { renderFields, renderHelp, renderOutput, tildePath } from "../toon.js";
import { getFlag, hasFlag, rejectUnknownFlags } from "../args.js";

export const INFO_HELP = `usage: xcodebuild-axi info [flags]
Reports the toolchain this machine will build with.
flags[3]:
  --sdks             list every installed SDK
  --platform <name>  filter the SDK list, e.g. iphoneos
  --sdk <name>       everything about one SDK: its path, platform, and versions
note:
  --sdks answers "which SDKs are here", --sdk answers "where is this one and
  what is in it" -- the paths a build script needs and the build version an
  agent is asked to report. A canonical name (iphonesimulator27.0) or a bare
  platform name (iphonesimulator) both work.
examples:
  xcodebuild-axi info
  xcodebuild-axi info --sdks --platform iphonesimulator
  xcodebuild-axi info --sdk iphonesimulator
`;

export const INFO_FLAGS = ["--sdks", "--platform", "--sdk"] as const;

interface RawSdk {
  canonicalName?: string;
  displayName?: string;
  platform?: string;
  sdkVersion?: string;
  isBaseSdk?: boolean;
}

/** What `-version -sdk <name> -json` adds on top of the list entry. */
interface FullSdk extends RawSdk {
  platformPath?: string;
  platformVersion?: string;
  productBuildVersion?: string;
  productName?: string;
  productVersion?: string;
  sdkPath?: string;
}

export async function infoCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "info", INFO_FLAGS, ["--platform", "--sdk"]);

  const named = getFlag(args, "--sdk");
  if (named !== undefined) return reportSdk(named);

  const [version, developerDir, sdks, simulators] = await Promise.all([
    readVersion(),
    readDeveloperDir(),
    readSdks(),
    listSimulators().catch(() => []),
  ]);

  const platform = getFlag(args, "--platform")?.toLowerCase();
  const filtered = platform
    ? sdks.filter((sdk) =>
        (sdk.platform ?? "").toLowerCase().includes(platform),
      )
    : sdks;

  const runtimes = [
    ...new Set(simulators.map((simulator) => simulator.runtime)),
  ].sort();

  // `--sdks` is a different question from `info`, so it answers only that
  // one. Reprinting the toolchain header cost more than the SDK list itself
  // when this was measured — and a canonical name already carries its own
  // platform and version, so one column says what three did.
  if (hasFlag(args, "--sdks") || platform !== undefined) {
    const names = [
      ...new Set(
        filtered.map((sdk) => sdk.canonicalName).filter((name) => !!name),
      ),
    ].sort() as string[];

    if (names.length === 0) {
      return renderOutput([
        renderFields({
          sdks: `0 of ${sdks.length} installed SDKs match platform '${platform}'`,
        }),
        renderHelp(["Run `xcodebuild-axi info --sdks` to list them all"]),
      ]);
    }

    return renderOutput([
      renderFields({
        ...(platform ? { platform } : {}),
        sdks: names,
      }),
    ]);
  }

  return renderOutput([
    renderFields({
      xcode: version.version,
      build: version.build,
      developer_dir: tildePath(developerDir),
      sdks: sdks.length,
      simulators: simulators.length,
      ...(runtimes.length > 0 ? { runtimes } : {}),
    }),
    renderHelp(["Run `xcodebuild-axi info --sdks` to list the installed SDKs"]),
  ]);
}

/**
 * One SDK, in full.
 *
 * `xcodebuild -version -sdk <name> <infoitem>` answers one field per
 * invocation and only if you already know the field names; the JSON form
 * carries all of them, so this asks once and reports the lot.
 */
async function reportSdk(name: string): Promise<string> {
  const { stdout } = await runMetadata(["-version", "-sdk", name, "-json"]);
  const start = stdout.indexOf("[");
  let parsed: FullSdk[] = [];
  if (start !== -1) {
    try {
      parsed = JSON.parse(stdout.slice(start)) as FullSdk[];
    } catch {
      parsed = [];
    }
  }

  const sdk = parsed[0];
  if (!sdk) {
    // xcodebuild exits *zero* for an SDK it cannot locate, so the absence of a
    // payload is the only signal that the name was wrong.
    throw new AxiError(`No SDK named '${name}'`, "NOT_FOUND", [
      "Run `xcodebuild-axi info --sdks` to list the installed SDKs",
    ]);
  }

  return renderOutput([
    renderFields({
      sdk: sdk.canonicalName ?? name,
      ...(sdk.displayName ? { name: sdk.displayName } : {}),
      ...(sdk.platform ? { platform: sdk.platform } : {}),
      ...(sdk.sdkVersion ? { sdk_version: sdk.sdkVersion } : {}),
      ...(sdk.productVersion ? { product_version: sdk.productVersion } : {}),
      ...(sdk.productBuildVersion ? { build: sdk.productBuildVersion } : {}),
      ...(sdk.sdkPath ? { path: tildePath(sdk.sdkPath) } : {}),
      ...(sdk.platformPath
        ? { platform_path: tildePath(sdk.platformPath) }
        : {}),
    }),
  ]);
}

async function readVersion(): Promise<{ version: string; build: string }> {
  const { stdout } = await runMetadata(["-version"]);
  const lines = stdout.trim().split("\n");
  return {
    version: (lines[0] ?? "unknown").replace(/^Xcode\s*/, ""),
    build: (lines[1] ?? "").replace(/^Build version\s*/, ""),
  };
}

async function readSdks(): Promise<RawSdk[]> {
  const { stdout } = await runMetadata(["-showsdks", "-json"]);
  const start = stdout.indexOf("[");
  if (start === -1) return [];
  try {
    // Only the base SDKs matter for choosing what to build against; the
    // sub-SDK entries triple the row count and answer nothing.
    return (JSON.parse(stdout.slice(start)) as RawSdk[]).filter(
      (sdk) => sdk.isBaseSdk !== false,
    );
  } catch {
    return [];
  }
}

function readDeveloperDir(): Promise<string> {
  return new Promise((resolvePromise) => {
    execFile("xcode-select", ["-p"], { encoding: "utf-8" }, (error, stdout) => {
      resolvePromise(
        error ? (process.env["DEVELOPER_DIR"] ?? "unknown") : stdout.trim(),
      );
    });
  });
}
