import { execFile } from "node:child_process";
import { runMetadata } from "../xcodebuild.js";
import { listSimulators } from "../simctl.js";
import {
  renderFields,
  renderHelp,
  renderList,
  renderOutput,
  tildePath,
} from "../toon.js";
import { getFlag, hasFlag, rejectUnknownFlags } from "../args.js";

export const INFO_HELP = `usage: xcodebuild-axi info [flags]
Reports the toolchain this machine will build with.
flags[2]:
  --sdks             list every installed SDK
  --platform <name>  filter the SDK list, e.g. iphoneos
examples:
  xcodebuild-axi info
  xcodebuild-axi info --sdks --platform iphonesimulator
`;

const FLAGS = ["--sdks", "--platform"] as const;

interface RawSdk {
  canonicalName?: string;
  displayName?: string;
  platform?: string;
  sdkVersion?: string;
  isBaseSdk?: boolean;
}

export async function infoCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "info", FLAGS, ["--platform"]);

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

  const blocks = [
    renderFields({
      xcode: version.version,
      build: version.build,
      developer_dir: tildePath(developerDir),
      sdks: sdks.length,
      simulators: simulators.length,
      ...(runtimes.length > 0 ? { runtimes } : {}),
    }),
  ];

  if (hasFlag(args, "--sdks") || platform !== undefined) {
    if (filtered.length === 0) {
      blocks.push(
        renderFields({ sdk_list: `0 SDKs match platform '${platform}'` }),
      );
    } else {
      blocks.push(
        renderList(
          "sdk_list",
          filtered.map((sdk) => ({
            name: sdk.canonicalName ?? "",
            platform: sdk.platform ?? "",
            version: sdk.sdkVersion ?? "",
          })),
        ),
      );
    }
  } else {
    blocks.push(
      renderHelp([
        "Run `xcodebuild-axi info --sdks` to list the installed SDKs",
      ]),
    );
  }

  return renderOutput(blocks);
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
