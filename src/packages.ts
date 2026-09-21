import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectContext } from "./context.js";
import { getFlag, hasFlag } from "./args.js";

/**
 * Read the pinned package versions out of `Package.resolved`.
 *
 * Xcode hides this file in a different place depending on the container, and
 * an agent asking "what version of X am I on?" otherwise has to know all of
 * them. Reading it needs no subprocess at all, which makes this the cheapest
 * useful answer in the whole tool.
 */

export interface Pin {
  identity: string;
  version: string;
  kind: string;
  location: string;
  revision: string;
}

interface RawResolved {
  pins?: {
    identity?: string;
    kind?: string;
    location?: string;
    state?: { version?: string; revision?: string; branch?: string };
  }[];
}

/** Every place Xcode and SwiftPM keep the file, most specific first. */
export function resolvedFileCandidates(project: ProjectContext): string[] {
  const root =
    project.kind === "package" ? project.path : dirname(project.path);
  return [
    // Workspace- and project-scoped copies, which win when both exist.
    join(project.path, "xcshareddata", "swiftpm", "Package.resolved"),
    join(
      project.path,
      "project.xcworkspace",
      "xcshareddata",
      "swiftpm",
      "Package.resolved",
    ),
    join(root, "Package.resolved"),
    // Tuist keeps the workspace's graph here rather than inside the generated
    // workspace, which is regenerated and so cannot hold source of truth.
    join(root, "Tuist", "Package.resolved"),
  ];
}

export function findResolvedFile(project: ProjectContext): string | undefined {
  return resolvedFileCandidates(project).find((candidate) =>
    existsSync(candidate),
  );
}

export function readPins(path: string): Pin[] {
  let parsed: RawResolved;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8")) as RawResolved;
  } catch {
    return [];
  }

  return (parsed.pins ?? [])
    .map((pin) => ({
      identity: pin.identity ?? "unknown",
      // A branch pin has no version; reporting an empty cell would read as
      // "unpinned" when it is in fact pinned to a moving target.
      version:
        pin.state?.version ??
        (pin.state?.branch ? `branch ${pin.state.branch}` : "revision"),
      kind: (pin.kind ?? "")
        .replace("remoteSourceControl", "remote")
        .replace("localSourceControl", "local"),
      location: pin.location ?? "",
      revision: (pin.state?.revision ?? "").slice(0, 7),
    }))
    .sort((a, b) => a.identity.localeCompare(b.identity));
}

/**
 * Package-resolution behavior, shared by the build family and `packages`.
 *
 * These are the flags that decide whether xcodebuild is allowed to reach the
 * network mid-build. An agent on a flaky or offline runner needs them, and
 * they are otherwise eleven long camelCase names to remember.
 */

export const PACKAGE_FLAGS = [
  "--offline",
  "--cache",
  "--package-cache",
  "--no-auto-resolve",
  "--skip-package-updates",
  "--no-package-cache",
  "--skip-plugin-validation",
  "--skip-signature-validation",
  "--package-auth",
  "--registry-url",
  "--scm-to-registry",
  "--fingerprint-policy",
  "--signing-entity-policy",
  "--scm-provider",
] as const;

export const PACKAGE_VALUE_FLAGS = [
  "--cache",
  "--package-cache",
  "--package-auth",
  "--registry-url",
  "--scm-to-registry",
  "--fingerprint-policy",
  "--signing-entity-policy",
  "--scm-provider",
] as const;

export const PACKAGE_FLAG_HELP = `  --offline               resolve using only the versions already in Package.resolved
  --cache <path>          clone remote packages into this directory
  --package-cache <path>  shared package cache directory (across projects)
  --no-auto-resolve       never resolve automatically; fail if Package.resolved is stale
  --skip-package-updates  use the packages already cloned, without checking for updates
  --no-package-cache      ignore the shared package repository cache
  --skip-plugin-validation      trust build plugins without prompting
  --skip-signature-validation   do not verify package signatures
  --package-auth <kind>   keychain or netrc
  --registry-url <url>    default package registry
  --scm-to-registry <kind>      none, identity, or swift-package-registry
  --fingerprint-policy <kind>   strict or warn
  --signing-entity-policy <kind>  strict or warn
  --scm-provider <kind>   system or xcode`;

const SWITCHES: Array<[string, string]> = [
  ["--offline", "-onlyUsePackageVersionsFromResolvedFile"],
  ["--no-auto-resolve", "-disableAutomaticPackageResolution"],
  ["--skip-package-updates", "-skipPackageUpdates"],
  ["--no-package-cache", "-disablePackageRepositoryCache"],
  ["--skip-plugin-validation", "-skipPackagePluginValidation"],
  ["--skip-signature-validation", "-skipPackageSignatureValidation"],
];

const VALUES: Array<[string, string]> = [
  ["--cache", "-clonedSourcePackagesDirPath"],
  ["--package-cache", "-packageCachePath"],
  ["--package-auth", "-packageAuthorizationProvider"],
  ["--registry-url", "-defaultPackageRegistryURL"],
  ["--scm-to-registry", "-packageDependencySCMToRegistryTransformation"],
  ["--fingerprint-policy", "-packageFingerprintPolicy"],
  ["--signing-entity-policy", "-packageSigningEntityPolicy"],
  ["--scm-provider", "-scmProvider"],
];

export function packageArgs(args: string[]): string[] {
  return [
    ...SWITCHES.filter(([flag]) => hasFlag(args, flag)).map(([, name]) => name),
    ...VALUES.flatMap(([flag, name]) => {
      const value = getFlag(args, flag);
      return value === undefined ? [] : [name, value];
    }),
  ];
}
