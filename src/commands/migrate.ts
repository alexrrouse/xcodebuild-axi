import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AxiError } from "../errors.js";
import { requireProject, type ProjectContext } from "../context.js";
import { runMetadata, stripPreamble } from "../xcodebuild.js";
import { renderFields, renderHelp, renderOutput, tildePath } from "../toon.js";
import { getFlag, hasFlag, rejectUnknownFlags } from "../args.js";

export const MIGRATE_HELP = `usage: xcodebuild-axi migrate [flags]
Reports the project file format, and converts it to a newer one.
flags[3]:
  --format <name>   the format to convert to, e.g. "Xcode 27.0"
  --project <path>  which .xcodeproj, when the workspace holds more than one
  --yes             actually convert; without it this only reports
note:
  This converts a .xcodeproj, not a workspace — a workspace has no format of
  its own. In a workspace directory the single contained project is picked
  automatically, and named for you when there is more than one.

  It also rewrites the .pbxproj in place, so it is the one command here that
  changes files you track. Run it with a clean working tree, and without --yes
  first to see the current format and what is available.
exit:
  0 reported or converted, 1 xcodebuild refused, 2 usage error
examples:
  xcodebuild-axi migrate
  xcodebuild-axi migrate --format "Xcode 27.0" --yes
  xcodebuild-axi migrate --project App/App.xcodeproj --format "Xcode 27.0" --yes
`;

const FLAGS = ["--format", "--project", "--yes"] as const;
const VALUE_FLAGS = ["--format", "--project"] as const;

/** A name no Xcode will ever ship, used to make xcodebuild list the real ones. */
const IMPOSSIBLE_FORMAT = "__xcodebuild-axi-probe__";

export async function migrateCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "migrate", FLAGS, VALUE_FLAGS);

  const context = requireProject();
  if (context.kind === "package") {
    throw new AxiError(
      "A Swift package has no project file format to convert",
      "VALIDATION_ERROR",
      ["`migrate` applies to an .xcodeproj, which Package.swift does not have"],
    );
  }

  // `-convert-project` acts on a project file. Passing `-workspace` makes
  // xcodebuild demand a scheme and then fail at something unrelated, so the
  // workspace is resolved down to the .xcodeproj it contains.
  const projectPath = resolveProjectFile(context, getFlag(args, "--project"));
  const projectName = projectPath.split("/").pop() ?? projectPath;

  const format = getFlag(args, "--format");
  const current = readObjectVersion(projectPath);

  if (format === undefined) {
    const available = await availableFormats();
    return renderOutput([
      renderFields({
        project: tildePath(projectPath),
        ...(current ? { object_version: current } : {}),
        formats: available,
      }),
      renderHelp([
        `Run \`xcodebuild-axi migrate --format "${available.at(-1) ?? "Xcode 27.0"}" --yes\` to convert`,
      ]),
    ]);
  }

  if (!hasFlag(args, "--yes")) {
    // Rewriting a tracked file on the strength of one flag is the kind of
    // surprise an agent cannot undo for the user, so it takes two.
    throw new AxiError(
      `migrate would rewrite ${projectName} in place — pass --yes to confirm`,
      "VALIDATION_ERROR",
      [
        `xcodebuild-axi migrate --format "${format}" --yes`,
        "Commit or stash first; this edits the .pbxproj your repo tracks",
      ],
    );
  }

  const { stdout, stderr, exitCode } = await runMetadata([
    "-project",
    projectPath,
    "-convert-project",
    format,
  ]);

  if (exitCode !== 0) {
    const message = errorLine(`${stderr}\n${stdout}`);
    const available = await availableFormats();
    throw new AxiError(
      message || `Could not convert to '${format}'`,
      "UNKNOWN",
      available.length > 0 ? [`formats: ${available.join(", ")}`] : [],
    );
  }

  return renderOutput([
    renderFields({
      migrate: "converted",
      project: tildePath(projectPath),
      format,
      ...(current ? { was_object_version: current } : {}),
      object_version: readObjectVersion(projectPath) ?? "unknown",
    }),
    renderHelp([
      "Review the .pbxproj diff before committing — this changed a tracked file",
    ]),
  ]);
}

/**
 * The format list is only ever printed inside a rejection, so asking for a
 * name that cannot exist is the cheapest way to read it. xcodebuild validates
 * the format before it touches the project, so nothing is converted.
 */
async function availableFormats(): Promise<string[]> {
  const { stdout, stderr } = await runMetadata([
    "-convert-project",
    IMPOSSIBLE_FORMAT,
  ]);
  return parseFormats(`${stderr}\n${stdout}`);
}

/** Exported for tests: the list only ever appears inside a rejection. */
export function parseFormats(output: string): string[] {
  const match =
    /Pass a project format by name or version number:\s*(.+?)\.\s*$/m.exec(
      output,
    );
  if (!match?.[1]) return [];
  // xcodebuild lists "Xcode 3.0" twice; a duplicate in a help list is noise.
  return [...new Set(match[1].split(",").map((entry) => entry.trim()))].filter(
    (entry) => entry.length > 0,
  );
}

/**
 * Pick the .xcodeproj to convert.
 *
 * A workspace is a list of projects, so it has no format of its own. One
 * contained project is unambiguous; more than one is a question only the
 * caller can answer, and the answer is cheaper to give with the names in hand.
 */
function resolveProjectFile(
  context: ProjectContext,
  explicit: string | undefined,
): string {
  if (explicit !== undefined) return resolve(explicit);
  if (context.kind === "project") return context.path;

  const contained = projectsInWorkspace(context.path);
  if (contained.length === 1) return contained[0] as string;

  if (contained.length === 0) {
    throw new AxiError(
      `${context.name} references no .xcodeproj to convert`,
      "VALIDATION_ERROR",
      ["Pass `--project <path.xcodeproj>` to name one directly"],
    );
  }

  throw new AxiError(
    `${context.name} holds ${contained.length} projects — pass --project to pick one`,
    "VALIDATION_ERROR",
    contained.map(
      (path) => `xcodebuild-axi migrate --project ${tildePath(path)}`,
    ),
  );
}

/** The workspace file is XML listing `location = "group:Some.xcodeproj"`. */
function projectsInWorkspace(workspacePath: string): string[] {
  let contents: string;
  try {
    contents = readFileSync(
      join(workspacePath, "contents.xcworkspacedata"),
      "utf-8",
    );
  } catch {
    return [];
  }
  return parseWorkspaceProjects(contents, dirname(workspacePath));
}

/** Exported for tests. */
export function parseWorkspaceProjects(
  contents: string,
  baseDir: string,
): string[] {
  const found: string[] = [];
  for (const match of contents.matchAll(/location\s*=\s*"([^"]+)"/g)) {
    const location = match[1];
    if (location === undefined || !location.endsWith(".xcodeproj")) continue;
    const relative = location.replace(/^(group|container|self):/, "");
    // Locations are relative to the workspace's own directory.
    found.push(resolve(baseDir, relative));
  }
  return [...new Set(found)];
}

/** `objectVersion` in the pbxproj is the format, without running anything. */
function readObjectVersion(projectPath: string): string | undefined {
  try {
    const match = /objectVersion\s*=\s*(\d+)/.exec(
      readFileSync(join(projectPath, "project.pbxproj"), "utf-8").slice(
        0,
        2000,
      ),
    );
    return match?.[1];
  } catch {
    return undefined;
  }
}

/** Exported for tests. */
export function errorLine(output: string): string {
  return (
    stripPreamble(output)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("xcodebuild: error:"))
      .map((line) => line.replace(/^xcodebuild: error:\s*/, ""))
      // xcodebuild appends the whole format list to its rejection, and the
      // suggestions already carry a deduplicated copy.
      .map((line) => line.split("Pass a project format")[0]?.trim() ?? line)
      .pop() ?? ""
  );
}
