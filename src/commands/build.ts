import {
  BUILD_FLAG_HELP,
  reportAction,
  resolveBuildContext,
  runAction,
  SHARED_BUILD_FLAGS,
  SHARED_BUILD_VALUE_FLAGS,
} from "../action.js";
import { AxiError, mapXcodebuildError } from "../errors.js";
import { getFlag, hasFlag, rejectUnknownFlags } from "../args.js";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve as resolvePath } from "node:path";
import { requireProject } from "../context.js";
import type { ProjectContext } from "../context.js";
import { artifactDir, runBuild } from "../xcodebuild.js";
import {
  byteSize,
  duration,
  renderFields,
  renderHelp,
  renderOutput,
  tildePath,
} from "../toon.js";

export const BUILD_HELP = `usage: xcodebuild-axi build [flags]
Builds a scheme and reports only what failed, with exact source locations.
flags[49]:
${BUILD_FLAG_HELP}
  --clean                 clean before building
  --for-testing           build the tests too and emit an .xctestrun (build-for-testing)
  --install               run the install action instead of build
  --docs                  build documentation (docbuild) instead of build
  --install-src           copy the project's sources out instead of building (installsrc)
  --src-root <path>       with --install-src: where to copy them; needs --yes
  --yes                   required to copy sources anywhere but the cache
exit:
  0 build succeeded, 1 build failed, 2 usage error
examples:
  xcodebuild-axi build
  xcodebuild-axi build --scheme MyApp --device "iPhone 17 Pro"
  xcodebuild-axi build --scheme MyApp --configuration Release --clean
  xcodebuild-axi build --scheme MyApp --for-testing
  xcodebuild-axi build --install-src
`;

export const BUILD_FLAGS = [
  ...SHARED_BUILD_FLAGS,
  "--clean",
  "--for-testing",
  "--install",
  "--docs",
  "--install-src",
  "--src-root",
  "--yes",
] as const;

const BUILD_VALUE_FLAGS = [...SHARED_BUILD_VALUE_FLAGS, "--src-root"] as const;

export async function buildCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "build", BUILD_FLAGS, BUILD_VALUE_FLAGS);

  if (hasFlag(args, "--install-src")) return installSources(args);

  const action = pickAction(args);
  const context = await resolveBuildContext({ args, command: "build" });
  const run = await runAction({
    context,
    command: action === "build" ? "build" : action,
    actions: [...(hasFlag(args, "--clean") ? ["clean"] : []), action],
  });

  return reportAction({
    context,
    run,
    key: "build",
    ok: "succeeded",
    command: "build",
  });
}

/**
 * The build family's four actions are mutually exclusive: xcodebuild would
 * accept two action words and quietly run both, which is not what `--install
 * --docs` means to anyone typing it.
 */
function pickAction(args: string[]): string {
  const chosen = [
    hasFlag(args, "--for-testing") ? "build-for-testing" : undefined,
    hasFlag(args, "--install") ? "install" : undefined,
    hasFlag(args, "--docs") ? "docbuild" : undefined,
  ].filter((action): action is string => action !== undefined);

  if (chosen.length > 1) {
    throw new AxiError(
      "--for-testing, --install, and --docs each select a different action, so only one can be used at a time",
      "VALIDATION_ERROR",
      ["pick one, or run `xcodebuild-axi build` for a plain build"],
    );
  }

  return chosen[0] ?? "build";
}

/**
 * `installsrc`, xcodebuild's own source-copy action.
 *
 * Three things about it are worth knowing before reading this, all verified
 * against a real project:
 *
 * - **It cannot run against a workspace.** `-scheme` is rejected outright
 *   ("Cannot use the installsrc action with -scheme") and a workspace refuses
 *   to do anything without one, so the only form that works is `-project`.
 * - **It refuses a destination that already exists**, with "Cannot determine
 *   install sources to path", the same shape as its refusal to overwrite a
 *   result bundle.
 * - **It copies the whole project directory**, build products included — a
 *   271 MB checkout came out as 270 MB, of which most was DerivedData. It is
 *   a packaging step rather than a source export, and the report says so.
 *
 * The default destination is this project's cache directory, because
 * everything else here writes only there. A caller who wants it somewhere
 * else says where and confirms, the way `migrate --format` does.
 */
async function installSources(args: string[]): Promise<string> {
  const conflict = ["--for-testing", "--install", "--docs", "--clean"].find(
    (flag) => hasFlag(args, flag),
  );
  if (conflict !== undefined) {
    throw new AxiError(
      `Copying sources is not a build and cannot be combined with ${conflict}`,
      "VALIDATION_ERROR",
      ["Run the two as separate commands"],
    );
  }

  const project = requireProject();
  const container = installSrcContainer(project);
  const destination = sourceDestination(args, project);

  const run = await runBuild({
    args: ["-project", container, "installsrc", `SRCROOT=${destination}`],
    label: `${project.name}-installsrc`,
    project,
  });

  if (run.exitCode !== 0) {
    const mapped = mapXcodebuildError(run.tail);
    throw new AxiError(
      mapped?.message ?? `Could not copy the sources of ${project.name}`,
      mapped?.code ?? "UNKNOWN",
      [
        ...(mapped?.suggestions ?? []),
        `full transcript: ${tildePath(run.logPath)}`,
      ],
    );
  }

  const { files, bytes } = measure(destination);
  return renderOutput([
    renderFields({
      installsrc: "copied",
      project: project.name,
      files,
      size: byteSize(bytes),
      to: tildePath(destination),
      duration: duration(run.seconds),
    }),
    renderHelp([
      "installsrc copies the whole project directory, build products included — it is xcodebuild's packaging step rather than a source export",
    ]),
  ]);
}

/** The `.xcodeproj` installsrc needs, which is not always what we build with. */
function installSrcContainer(project: ProjectContext): string {
  if (project.kind === "project") return project.path;

  if (project.kind === "package") {
    throw new AxiError(
      "installsrc needs an Xcode project and a Swift package has none",
      "VALIDATION_ERROR",
      [
        "`git archive HEAD` copies a package's sources and leaves the build products behind",
      ],
    );
  }

  // A workspace is a dead end for this action, not a harder case: it demands
  // a scheme and installsrc rejects one. The .xcodeproj beside it is the
  // thing xcodebuild would have picked with no workspace present.
  const dir = resolvePath(project.path, "..");
  const sibling = readdirSync(dir).filter((entry) =>
    entry.endsWith(".xcodeproj"),
  );
  const only = sibling[0];
  if (sibling.length !== 1 || only === undefined) {
    throw new AxiError(
      `installsrc cannot run against ${basename(project.path)}`,
      "VALIDATION_ERROR",
      [
        "xcodebuild rejects `-scheme` with installsrc, and a workspace will not act without one",
        sibling.length === 0
          ? "cd to a directory holding a single .xcodeproj, then re-run"
          : `${sibling.length} projects sit beside it: ${sibling.join(", ")}`,
      ],
    );
  }
  return join(dir, only);
}

/** Where the copy lands: this project's cache, or a path the caller stands behind. */
function sourceDestination(args: string[], project: ProjectContext): string {
  const requested = getFlag(args, "--src-root");

  if (requested === undefined) {
    const cached = join(artifactDir(project), "src");
    // Ours to clear, the way the result bundle is: installsrc will not write
    // into a directory that already exists.
    rmSync(cached, { recursive: true, force: true });
    return cached;
  }

  if (!hasFlag(args, "--yes")) {
    throw new AxiError(
      `Copying ${project.name} outside the tool's cache needs --yes as well as --src-root`,
      "VALIDATION_ERROR",
      [
        `xcodebuild-axi build --install-src --src-root ${requested} --yes`,
        "Without --src-root the copy lands in ~/Library/Caches/xcodebuild-axi",
      ],
    );
  }

  const path = resolvePath(requested);
  if (existsSync(path)) {
    throw new AxiError(
      `Something is already at ${tildePath(path)}`,
      "VALIDATION_ERROR",
      [
        "installsrc refuses a destination that exists, and deleting one you named is not this tool's call",
        "Pass an empty path, or remove it yourself first",
      ],
    );
  }
  return path;
}

/** What actually landed, since installsrc reports only that it started. */
function measure(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile()) {
        files += 1;
        bytes += statSync(child).size;
      }
    }
  };
  walk(dir);
  return { files, bytes };
}
