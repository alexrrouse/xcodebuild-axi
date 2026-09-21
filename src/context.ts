import { existsSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { AxiError } from "./errors.js";

export type ProjectKind = "workspace" | "project" | "package";

export interface ProjectContext {
  kind: ProjectKind;
  /** Absolute path to the container (or the directory, for a package). */
  path: string;
  /** Display name: "MyApps" for MyApps.xcworkspace. */
  name: string;
  /** The `-workspace X` / `-project X` pair to pass xcodebuild, if any. */
  flags: string[];
}

/**
 * Find the thing xcodebuild should be pointed at, in the directory the agent
 * is standing in.
 *
 * A workspace wins over a bare project because that is the container Xcode
 * itself opens when both are present, and because a project inside a workspace
 * usually cannot resolve the workspace's package graph on its own.
 *
 * `project.xcworkspace` is skipped: every `.xcodeproj` contains one, and it is
 * an implementation detail rather than something a user ever builds.
 */
export function resolveProject(
  dir = process.cwd(),
): ProjectContext | undefined {
  const root = resolve(dir);
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return undefined;
  }

  const workspaces = entries.filter(
    (entry) =>
      entry.endsWith(".xcworkspace") && entry !== "project.xcworkspace",
  );
  if (workspaces.length > 0) {
    const chosen = pickOne(workspaces, "workspace", root);
    return {
      kind: "workspace",
      path: join(root, chosen),
      name: basename(chosen, ".xcworkspace"),
      flags: ["-workspace", join(root, chosen)],
    };
  }

  const projects = entries.filter((entry) => entry.endsWith(".xcodeproj"));
  if (projects.length > 0) {
    const chosen = pickOne(projects, "project", root);
    return {
      kind: "project",
      path: join(root, chosen),
      name: basename(chosen, ".xcodeproj"),
      flags: ["-project", join(root, chosen)],
    };
  }

  // A Swift package has no container to pass: xcodebuild synthesizes an
  // implicit workspace from Package.swift in the working directory, which is
  // why the runner must never cd away from it.
  if (existsSync(join(root, "Package.swift"))) {
    return { kind: "package", path: root, name: basename(root), flags: [] };
  }

  return undefined;
}

export function requireProject(dir = process.cwd()): ProjectContext {
  const project = resolveProject(dir);
  if (!project) {
    throw new AxiError(
      `No .xcworkspace, .xcodeproj, or Package.swift in ${dir}`,
      "NO_PROJECT",
      ["cd to the directory holding the workspace or project, then re-run"],
    );
  }
  return project;
}

function pickOne(candidates: string[], label: string, root: string): string {
  const sorted = [...candidates].sort();
  const first = sorted[0];
  if (first === undefined) {
    throw new AxiError(`No ${label} found in ${root}`, "NO_PROJECT");
  }
  if (sorted.length > 1) {
    // Ambiguity an agent cannot resolve by guessing: say which ones, so the
    // next call can cd into the right place rather than re-run blind.
    throw new AxiError(
      `${sorted.length} ${label}s in ${root}: ${sorted.join(", ")}`,
      "NO_PROJECT",
      ["cd into the directory holding the one you want, then re-run"],
    );
  }
  return first;
}
