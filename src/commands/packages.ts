import { AxiError, mapXcodebuildError } from "../errors.js";
import { requireProject } from "../context.js";
import { requireScheme } from "../scheme.js";
import {
  findResolvedFile,
  packageArgs,
  PACKAGE_FLAG_HELP,
  PACKAGE_FLAGS,
  PACKAGE_VALUE_FLAGS,
  readPins,
  resolvedFileCandidates,
} from "../packages.js";
import { runBuild } from "../xcodebuild.js";
import {
  duration,
  renderFields,
  renderHelp,
  renderList,
  renderOutput,
  tildePath,
} from "../toon.js";
import { getFlag, hasFlag, rejectUnknownFlags } from "../args.js";

export const PACKAGES_HELP = `usage: xcodebuild-axi packages [flags]
Reports the Swift package versions this project is pinned to, read straight
from Package.resolved — no build, no subprocess.
flags[18]:
  --resolve               actually resolve dependencies first (network, slow)
  --filter <text>         only packages whose identity contains this
  --scheme <name>         with --resolve against a workspace: the scheme to resolve for
  --derived-data <path>   with --resolve: derived data directory to resolve into
${PACKAGE_FLAG_HELP}
note:
  The resolution flags only matter alongside --resolve; reading the pins is a
  file read either way.
examples:
  xcodebuild-axi packages
  xcodebuild-axi packages --filter swift-composable
  xcodebuild-axi packages --resolve --offline
`;

export const PACKAGES_FLAGS = [
  "--resolve",
  "--filter",
  "--scheme",
  "--derived-data",
  ...PACKAGE_FLAGS,
] as const;
const VALUE_FLAGS = [
  "--filter",
  "--scheme",
  "--derived-data",
  ...PACKAGE_VALUE_FLAGS,
] as const;

export async function packagesCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "packages", PACKAGES_FLAGS, VALUE_FLAGS);

  const project = requireProject();
  const blocks: string[] = [];

  if (hasFlag(args, "--resolve")) {
    // Two reasons xcodebuild needs a scheme named up front: it refuses
    // `-resolvePackageDependencies -workspace` without one and says so only
    // after loading the whole workspace, and it refuses `-derivedDataPath`
    // without one at all. `requireScheme` picks it when there is only one, so
    // neither refusal has to reach the caller.
    const derivedData = getFlag(args, "--derived-data");
    const scheme =
      project.kind === "workspace" || derivedData !== undefined
        ? await requireScheme(
            project,
            getFlag(args, "--scheme"),
            "packages --resolve",
          )
        : getFlag(args, "--scheme");

    const run = await runBuild({
      args: [
        ...project.flags,
        ...(scheme ? ["-scheme", scheme] : []),
        "-resolvePackageDependencies",
        ...(derivedData ? ["-derivedDataPath", derivedData] : []),
        ...packageArgs(args),
      ],
      label: `${project.name}-resolve`,
      project,
    });

    if (run.exitCode !== 0) {
      const mapped = mapXcodebuildError(run.tail);
      throw new AxiError(
        mapped?.message ?? "Package resolution failed",
        mapped?.code ?? "UNKNOWN",
        [
          ...(mapped?.suggestions ?? []),
          `full transcript: ${tildePath(run.logPath)}`,
        ],
      );
    }

    blocks.push(
      renderFields({ resolve: "succeeded", duration: duration(run.seconds) }),
    );
  }

  const resolvedPath = findResolvedFile(project);
  if (!resolvedPath) {
    return renderOutput([
      ...blocks,
      renderFields({
        packages: `no Package.resolved found for ${project.name}`,
      }),
      renderHelp([
        "Run `xcodebuild-axi packages --resolve` to create one",
        `looked in: ${resolvedFileCandidates(project).map(tildePath).join(", ")}`,
      ]),
    ]);
  }

  const filter = getFilter(args);
  let pins = readPins(resolvedPath);
  const total = pins.length;
  if (filter) {
    pins = pins.filter(
      (pin) =>
        pin.identity.includes(filter) ||
        pin.location.toLowerCase().includes(filter),
    );
  }

  if (pins.length === 0) {
    return renderOutput([
      ...blocks,
      renderFields({
        packages: filter
          ? `0 of ${total} packages match '${getFlag(args, "--filter")}'`
          : "0 packages pinned",
      }),
      renderFields({ resolved: tildePath(resolvedPath) }),
    ]);
  }

  return renderOutput([
    ...blocks,
    renderFields({
      count: filter ? `${pins.length} of ${total}` : total,
      resolved: tildePath(resolvedPath),
    }),
    renderList(
      "packages",
      pins.map((pin) => ({
        package: pin.identity,
        version: pin.version,
        revision: pin.revision,
      })),
    ),
    renderHelp(
      filter
        ? []
        : [
            "Run `xcodebuild-axi packages --resolve` to update them from the network",
          ],
    ),
  ]);
}

function getFilter(args: string[]): string | undefined {
  return getFlag(args, "--filter")?.toLowerCase();
}
