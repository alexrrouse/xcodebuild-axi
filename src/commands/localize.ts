import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { AxiError, mapXcodebuildError } from "../errors.js";
import { requireProject } from "../context.js";
import { artifactDir, runBuild, stripPreamble } from "../xcodebuild.js";
import {
  duration,
  renderFields,
  renderHelp,
  renderOutput,
  tildePath,
} from "../toon.js";
import {
  getFlag,
  getListFlag,
  hasFlag,
  positionals,
  rejectUnknownFlags,
} from "../args.js";

export const LOCALIZE_HELP = `usage: xcodebuild-axi localize export|import [flags]
Moves XLIFF localization catalogs in and out of a project.
flags[6]:
  --path <path>              the .xcloc directory to write, or the one to import (required for import)
  --language <code>          ISO 639-1 language to export; repeatable or comma-separated
  --default-language <code>  the language translations are made from
  --screenshots              include localization screenshots in the export
  --merge                    merge the import into existing translations instead of replacing
  --scheme <name>            limit the export to one scheme's targets
note:
  Export writes one .xcloc bundle per language. Without --path they land in the
  tool's cache and the path is printed.
exit:
  0 succeeded, 1 xcodebuild refused, 2 usage error
examples:
  xcodebuild-axi localize export --language fr,de
  xcodebuild-axi localize export --path build/loc --default-language en
  xcodebuild-axi localize import --path build/loc/fr.xcloc --merge
`;

export const LOCALIZE_FLAGS = [
  "--path",
  "--language",
  "--default-language",
  "--screenshots",
  "--merge",
  "--scheme",
] as const;

const VALUE_FLAGS = [
  "--path",
  "--language",
  "--default-language",
  "--scheme",
] as const;

export async function localizeCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "localize", LOCALIZE_FLAGS, VALUE_FLAGS);

  const [mode] = positionals(args, VALUE_FLAGS);
  if (mode !== "export" && mode !== "import") {
    throw new AxiError(
      mode === undefined
        ? "localize needs either export or import"
        : `Unknown localize mode '${mode}'`,
      "VALIDATION_ERROR",
      [
        "xcodebuild-axi localize export --language fr",
        "xcodebuild-axi localize import --path build/loc/fr.xcloc",
      ],
    );
  }

  const project = requireProject();
  const scheme = getFlag(args, "--scheme");
  const rawPath = getFlag(args, "--path");

  if (mode === "import" && rawPath === undefined) {
    throw new AxiError(
      "localize import needs --path pointing at an .xcloc",
      "VALIDATION_ERROR",
      ["xcodebuild-axi localize import --path build/loc/fr.xcloc"],
    );
  }

  const localizationPath = rawPath
    ? resolve(rawPath)
    : join(artifactDir(project), "localizations");

  if (mode === "import" && !existsSync(localizationPath)) {
    throw new AxiError(`No localization catalog at ${rawPath}`, "NOT_FOUND", [
      "Run `xcodebuild-axi localize export` to produce one",
    ]);
  }

  const languages = getListFlag(args, "--language");
  const defaultLanguage = getFlag(args, "--default-language");

  const run = await runBuild({
    args: [
      ...project.flags,
      ...(scheme ? ["-scheme", scheme] : []),
      mode === "export" ? "-exportLocalizations" : "-importLocalizations",
      "-localizationPath",
      localizationPath,
      ...(mode === "export"
        ? [
            ...(defaultLanguage ? ["-defaultLanguage", defaultLanguage] : []),
            ...languages.flatMap((code) => ["-exportLanguage", code]),
            ...(hasFlag(args, "--screenshots") ? ["-includeScreenshots"] : []),
          ]
        : hasFlag(args, "--merge")
          ? ["-mergeImport"]
          : []),
    ],
    label: `${project.name}-localize-${mode}`,
    project,
  });

  if (run.exitCode !== 0) {
    const mapped = mapXcodebuildError(run.tail);
    process.exitCode = 1;
    return renderOutput([
      renderFields({
        localize: `${mode} failed`,
        error: mapped?.message ?? firstError(run.tail),
        log: tildePath(run.logPath),
      }),
      renderHelp(mapped?.suggestions ?? []),
    ]);
  }

  return renderOutput([
    renderFields({
      localize: `${mode} succeeded`,
      path: tildePath(localizationPath),
      ...(languages.length > 0 ? { languages } : {}),
      duration: duration(run.seconds),
    }),
    renderHelp(
      mode === "export"
        ? [
            "Translate the .xcloc bundles, then `xcodebuild-axi localize import --path <bundle>`",
          ]
        : [],
    ),
  ]);
}

function firstError(tail: string): string {
  return (
    stripPreamble(tail)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /error/i.test(line))
      .pop() ?? "xcodebuild refused the localization request"
  );
}
