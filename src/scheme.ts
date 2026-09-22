import { AxiError } from "./errors.js";
import type { ProjectContext } from "./context.js";
import { runMetadata } from "./xcodebuild.js";

interface ListJson {
  workspace?: { name?: string; schemes?: string[] };
  project?: {
    name?: string;
    schemes?: string[];
    targets?: string[];
    configurations?: string[];
  };
}

export interface SchemeInfo {
  name: string;
  schemes: string[];
  targets: string[];
  configurations: string[];
}

/**
 * `-list -json`, which unlike the plain form emits no package-graph preamble
 * and no prose. Still worth going through `runMetadata` so a missing Xcode is
 * reported as a structured error rather than an ENOENT stack.
 */
export async function listSchemes(
  project: ProjectContext,
): Promise<SchemeInfo> {
  const { stdout, stderr, exitCode } = await runMetadata([
    ...project.flags,
    "-list",
    "-json",
  ]);

  const start = stdout.indexOf("{");
  if (start === -1) {
    throw (
      mapListFailure(`${stdout}\n${stderr}`) ??
      new AxiError(
        `xcodebuild could not read ${project.name} (exit ${exitCode})`,
        "NO_PROJECT",
      )
    );
  }

  const parsed = JSON.parse(stdout.slice(start)) as ListJson;
  const container = parsed.workspace ?? parsed.project ?? {};
  return {
    name: container.name ?? project.name,
    schemes: container.schemes ?? [],
    targets: parsed.project?.targets ?? [],
    configurations: parsed.project?.configurations ?? [],
  };
}

function mapListFailure(output: string): AxiError | undefined {
  if (/does not contain a scheme/.test(output)) return undefined;
  const match = output.match(/xcodebuild: error: (.+)/);
  return match?.[1] ? new AxiError(match[1].trim(), "NO_PROJECT") : undefined;
}

/**
 * Resolve the scheme to act on.
 *
 * With one scheme there is nothing to ask about, so we use it — a required
 * flag whose value can only be one thing is a wasted round trip. With several,
 * refusing is right, but the refusal carries the list so the next call is
 * correct rather than another lookup (AXI principle 6).
 */
export async function requireScheme(
  project: ProjectContext,
  requested: string | undefined,
  command: string,
): Promise<string> {
  const { schemes } = await listSchemes(project);

  if (requested) {
    if (schemes.length > 0 && !schemes.includes(requested)) {
      const near = schemes.filter((s) =>
        s.toLowerCase().includes(requested.toLowerCase()),
      );
      throw new AxiError(
        `No scheme named '${requested}' in ${project.name}`,
        "SCHEME_NOT_FOUND",
        near.length > 0
          ? [`did you mean: ${near.join(", ")}`]
          : [`schemes in ${project.name}: ${schemes.join(", ")}`],
      );
    }
    return requested;
  }

  const only = schemes[0];
  if (schemes.length === 1 && only !== undefined) return only;

  if (schemes.length === 0) {
    throw new AxiError(
      `${project.name} declares no shared schemes`,
      "SCHEME_NOT_FOUND",
      [
        "Open the project in Xcode and mark a scheme as Shared, or pass `--scheme <name>`",
      ],
    );
  }

  throw new AxiError(
    `${project.name} has ${schemes.length} schemes — pass --scheme`,
    "VALIDATION_ERROR",
    [
      `xcodebuild-axi ${command} --scheme <name>`,
      `schemes: ${schemes.join(", ")}`,
    ],
  );
}

/** What a command was asked to act on: a scheme, some targets, or all of them. */
export interface Subject {
  /** How to name it in a report — the scheme, the targets, or "all targets". */
  label: string;
  /** `-scheme X`, `-target A -target B`, or `-alltargets`. */
  flags: string[];
  /**
   * A filesystem-safe stem for artifacts. `label` is written for a reader and
   * can hold spaces and commas; a log file named `all targets-clean.log`
   * is a path every shell needs quoting for.
   */
  slug: string;
  /**
   * The same selection spelled as this tool's own flags, for a rerun hint.
   * Not derivable from `label`: "all targets" is prose, and a hint that says
   * `--target all targets` is a command that does not run.
   */
  rerun: string;
  /** True when targets were named instead of a scheme. */
  targetMode: boolean;
}

/**
 * Resolve `--scheme` / `--target` / `--all-targets` into what to pass and what
 * to call it.
 *
 * Shared because the rules are xcodebuild's rather than any one command's:
 * targets need a project, they cannot be combined with a scheme, and a scheme
 * is inferred when the project has only one.
 */
export async function resolveSubject(
  project: ProjectContext,
  args: { scheme?: string; targets: string[]; allTargets: boolean },
  command: string,
): Promise<Subject> {
  const targetMode = args.targets.length > 0 || args.allTargets;

  if (targetMode && project.kind === "workspace") {
    // xcodebuild's own refusal here is "-target is not supported with
    // -workspace", issued only after it has resolved the package graph.
    throw new AxiError(
      "--target and --all-targets work against a project, not a workspace",
      "VALIDATION_ERROR",
      [
        "Pass `--scheme <name>` instead, or cd to the directory holding the .xcodeproj",
      ],
    );
  }
  if (targetMode && args.scheme !== undefined) {
    throw new AxiError(
      "--scheme and --target select different things to build, so only one can be used",
      "VALIDATION_ERROR",
      ["Drop one — a scheme already names the targets it builds"],
    );
  }

  if (targetMode) {
    return args.allTargets
      ? {
          label: "all targets",
          slug: "all-targets",
          flags: ["-alltargets"],
          rerun: "--all-targets",
          targetMode,
        }
      : {
          label: args.targets.join(","),
          slug: args.targets.join("-"),
          flags: args.targets.flatMap((target) => ["-target", target]),
          rerun: args.targets.map((target) => `--target ${target}`).join(" "),
          targetMode,
        };
  }

  const scheme = await requireScheme(project, args.scheme, command);
  return {
    label: scheme,
    slug: scheme,
    flags: ["-scheme", scheme],
    rerun: `--scheme ${scheme}`,
    targetMode,
  };
}
