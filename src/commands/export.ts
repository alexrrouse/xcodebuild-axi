import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AxiError, mapXcodebuildError } from "../errors.js";
import {
  EXPORT_METHODS,
  exportOptionsPlist,
  readArchiveInfo,
} from "../archive.js";
import {
  authArgs,
  AUTH_FLAGS,
  AUTH_FLAG_HELP,
  AUTH_VALUE_FLAGS,
} from "../auth.js";
import { requireProject } from "../context.js";
import { artifactDir, runBuild } from "../xcodebuild.js";
import { transcriptTail } from "../report.js";
import {
  duration,
  renderFields,
  renderHelp,
  renderOutput,
  tildePath,
} from "../toon.js";
import { getFlag, hasFlag, positionals, rejectUnknownFlags } from "../args.js";

export const EXPORT_HELP = `usage: xcodebuild-axi export <path.xcarchive> [flags]
Exports a built archive into a distributable product.
flags[14]:
  --method <name>         ${EXPORT_METHODS.join(", ")}
  --team <id>             Developer team ID to sign with
  --options <path>        a hand-written export options plist, instead of --method
  --output <path>         where to write the export (default: the tool's cache)
  --upload                send the build to App Store Connect instead of writing it to disk
  --no-manage-version     keep the archive's own version and build number
  --no-upload-symbols     do not send dSYMs with the build
  --notarized             export an archive Apple has already notarized
  --allow-provisioning    let xcodebuild fetch profiles from the developer portal
  --signing-style <name>  manual or automatic
${AUTH_FLAG_HELP}
note:
  --method writes the export options plist for you, which is otherwise an XML
  file you have to author by hand. Pass --options to supply your own instead.
  --upload is the difference between an .ipa on disk and a build in App Store
  Connect; with it there are no products to list, which is success, not an
  empty export. --no-manage-version matters whenever the build number is set
  at archive time, because Xcode otherwise picks its own at upload.
examples:
  xcodebuild-axi export build/MyApp.xcarchive --method release-testing
  xcodebuild-axi export build/MyApp.xcarchive --method app-store-connect --team ABCDE12345
  xcodebuild-axi export build/MyApp.xcarchive --method app-store-connect --upload --no-manage-version
  xcodebuild-axi export build/MyApp.xcarchive --options ExportOptions.plist
`;

const FLAGS = [
  "--method",
  "--team",
  "--options",
  "--output",
  "--upload",
  "--no-manage-version",
  "--no-upload-symbols",
  "--notarized",
  "--allow-provisioning",
  "--signing-style",
  ...AUTH_FLAGS,
] as const;

const VALUE_FLAGS = [
  "--method",
  "--team",
  "--options",
  "--output",
  "--signing-style",
  ...AUTH_VALUE_FLAGS,
] as const;

export async function exportCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "export", FLAGS, VALUE_FLAGS);

  const [rawArchive] = positionals(args, VALUE_FLAGS);
  if (rawArchive === undefined) {
    throw new AxiError(
      "export needs a path to an .xcarchive",
      "VALIDATION_ERROR",
      [
        "xcodebuild-axi export <path.xcarchive> --method release-testing",
        "`xcodebuild-axi archive` prints the path it wrote",
      ],
    );
  }

  const archivePath = resolve(expandTilde(rawArchive));
  if (!existsSync(archivePath)) {
    throw new AxiError(`No archive at ${rawArchive}`, "RESULT_NOT_FOUND", [
      "Run `xcodebuild-axi archive --scheme <name>` to create one",
    ]);
  }

  const notarized = hasFlag(args, "--notarized");
  const method = getFlag(args, "--method");
  const optionsPath = getFlag(args, "--options");

  if (!notarized && method === undefined && optionsPath === undefined) {
    throw new AxiError(
      "export needs --method or --options",
      "VALIDATION_ERROR",
      [
        `valid methods: ${EXPORT_METHODS.join(", ")}`,
        "xcodebuild-axi export <path.xcarchive> --method release-testing",
      ],
    );
  }

  if (
    method !== undefined &&
    !EXPORT_METHODS.includes(method as (typeof EXPORT_METHODS)[number])
  ) {
    throw new AxiError(
      `Unknown export method '${method}'`,
      "VALIDATION_ERROR",
      [`valid methods: ${EXPORT_METHODS.join(", ")}`],
    );
  }

  const uploading = hasFlag(args, "--upload");
  if (uploading && optionsPath !== undefined) {
    throw new AxiError(
      "--upload has nothing to write to when --options supplies the plist",
      "VALIDATION_ERROR",
      [
        "add `<key>destination</key><string>upload</string>` to your own plist",
        "or drop --options and let --method write one",
      ],
    );
  }

  const project = requireProject();
  const outputPath =
    getFlag(args, "--output") ??
    join(artifactDir(project), `${basenameOf(archivePath)}-export`);

  const plistPath =
    optionsPath ?? (method ? writeGeneratedPlist(args, method) : undefined);

  // An upload leaves nothing on disk, so the empty-export warning below would
  // call a successful ship a silently wrong options plist. Read it back rather
  // than trusting the flag: --options supplies a plist this command did not
  // write, and uploading is the usual reason to bring one.
  const sendsToAppStoreConnect =
    uploading ||
    (plistPath !== undefined && plistUploads(readFileSync(plistPath, "utf8")));

  const run = await runBuild({
    args: [
      notarized ? "-exportNotarizedApp" : "-exportArchive",
      "-archivePath",
      archivePath,
      "-exportPath",
      outputPath,
      ...(plistPath ? ["-exportOptionsPlist", plistPath] : []),
      ...(hasFlag(args, "--allow-provisioning")
        ? ["-allowProvisioningUpdates"]
        : []),
      ...authArgs(args, "export"),
    ],
    label: `${basenameOf(archivePath)}-export`,
    project,
  });

  const succeeded = run.exitCode === 0;

  if (!succeeded) {
    const mapped = mapXcodebuildError(run.tail);
    if (mapped) {
      throw new AxiError(mapped.message, mapped.code, [
        ...mapped.suggestions,
        `full transcript: ${tildePath(run.logPath)}`,
      ]);
    }
  }

  const info = await readArchiveInfo(archivePath);
  const products = succeeded ? listProducts(outputPath) : [];

  const blocks = [
    renderFields({
      export: succeeded ? "succeeded" : "failed",
      archive: tildePath(archivePath),
      ...(method ? { method } : {}),
      ...(sendsToAppStoreConnect ? { destination: "App Store Connect" } : {}),
      ...(info?.bundleIdentifier ? { bundle_id: info.bundleIdentifier } : {}),
      ...(info?.marketingVersion ? { version: info.marketingVersion } : {}),
      duration: duration(run.seconds),
    }),
  ];

  if (products.length > 0) {
    blocks.push(renderFields({ products }));
    blocks.push(renderFields({ output: tildePath(outputPath) }));
  } else if (succeeded && sendsToAppStoreConnect) {
    // Nothing on disk is the whole point here, so saying "0 files written"
    // would report a delivered build as a broken one.
    blocks.push(renderFields({ uploaded: "the build was sent, not written" }));
  } else if (succeeded) {
    // Exit zero with an empty export directory is the shape a silently wrong
    // options plist produces; say so rather than implying a product exists.
    blocks.push(
      renderFields({ products: `0 files written to ${tildePath(outputPath)}` }),
    );
  }

  if (!succeeded) {
    const tail = transcriptTail(run.tail);
    if (tail) blocks.push(tail);
  }

  blocks.push(renderFields({ log: tildePath(run.logPath) }));

  if (!succeeded) {
    process.exitCode = 1;
    blocks.push(
      renderHelp([
        "Signing is the usual cause — pass `--team <id>`, or `--allow-provisioning` to fetch profiles",
      ]),
    );
  }

  return renderOutput(blocks);
}

export function generatedPlistOptions(
  args: string[],
  method: string,
): Parameters<typeof exportOptionsPlist>[0] {
  const team = getFlag(args, "--team");
  const signingStyle = getFlag(args, "--signing-style");
  return {
    method,
    ...(hasFlag(args, "--upload") ? { destination: "upload" } : {}),
    ...(team !== undefined ? { teamID: team } : {}),
    ...(signingStyle !== undefined ? { signingStyle } : {}),
    ...(hasFlag(args, "--no-upload-symbols") ? { uploadSymbols: false } : {}),
    ...(hasFlag(args, "--no-manage-version")
      ? { manageAppVersionAndBuildNumber: false }
      : {}),
  };
}

function writeGeneratedPlist(args: string[], method: string): string {
  const dir = mkdtempSync(join(tmpdir(), "xcodebuild-axi-export-"));
  const path = join(dir, "ExportOptions.plist");
  writeFileSync(path, exportOptionsPlist(generatedPlistOptions(args, method)));
  return path;
}

/**
 * Does this plist upload rather than write a product?
 *
 * Asked of a hand-written `--options` file too, because the empty-export
 * warning below is wrong in exactly the same way for one of those — and a
 * plist that uploads is the common reason someone brings their own.
 */
export function plistUploads(contents: string): boolean {
  return /<key>\s*destination\s*<\/key>\s*<string>\s*upload\s*<\/string>/i.test(
    contents,
  );
}

function listProducts(outputPath: string): string[] {
  try {
    return readdirSync(outputPath).filter((entry) => !entry.startsWith("."));
  } catch {
    return [];
  }
}

function basenameOf(path: string): string {
  const last = path.split("/").filter(Boolean).pop() ?? "archive";
  return last.replace(/\.xcarchive$/, "");
}

function expandTilde(path: string): string {
  const home = process.env["HOME"];
  return home && path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}
