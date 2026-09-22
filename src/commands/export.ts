import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { AxiError, mapXcodebuildError } from "../errors.js";
import {
  EXPORT_METHODS,
  EXPORT_METHOD_ALIASES,
  exportOptionsPlist,
  readArchiveInfo,
  type ExportOptions,
} from "../archive.js";
import {
  authArgs,
  AUTH_FLAGS,
  AUTH_FLAG_HELP,
  AUTH_VALUE_FLAGS,
} from "../auth.js";
import { artifactsDirFrom } from "../action.js";
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
import {
  getFlag,
  getListFlag,
  hasFlag,
  positionals,
  rejectUnknownFlags,
} from "../args.js";

/**
 * The flags that exist only to fill in a key of the generated options plist.
 * Named as a group because `--options` supplies the whole plist itself, and
 * silently ignoring these alongside it is how a release ships unsigned.
 */
const PLIST_FLAGS = [
  "--profile",
  "--certificate",
  "--installer-certificate",
  "--distribution-bundle-id",
  "--keep-swift-symbols",
  "--internal-only",
  "--app-store-info",
  "--icloud-env",
  "--thinning",
  "--manifest",
  "--odr-base-url",
  "--no-embed-odr",
] as const;

const PLIST_VALUE_FLAGS = [
  "--profile",
  "--certificate",
  "--installer-certificate",
  "--distribution-bundle-id",
  "--icloud-env",
  "--thinning",
  "--manifest",
  "--odr-base-url",
] as const;

export const EXPORT_HELP = `usage: xcodebuild-axi export <path.xcarchive> [flags]
Exports a built archive into a distributable product.
flags[27]:
  --method <name>         ${EXPORT_METHODS.join(", ")}
  --team <id>             Developer team ID to sign with
  --options <path>        a hand-written export options plist, instead of --method
  --output <path>         where to write the export (default: the tool's cache)
  --artifacts-dir <path>  where to write this run's log (default: the tool's cache)
  --upload                send the build to App Store Connect instead of writing it to disk
  --no-manage-version     keep the archive's own version and build number
  --no-upload-symbols     do not send dSYMs with the build
  --notarized             export an archive Apple has already notarized
  --allow-provisioning    let xcodebuild fetch profiles from the developer portal
  --signing-style <name>  manual or automatic
  --profile <id>=<name>   provisioning profile per bundle id; repeatable (implies manual signing)
  --certificate <name>    signing certificate name or SHA-1 (implies manual signing)
  --installer-certificate <name>  installer certificate for a macOS package
  --distribution-bundle-id <id>   which app to export, when the archive holds several
  --keep-swift-symbols    do not strip Swift symbols from the export
  --internal-only         mark a TestFlight build as internal testing only
  --app-store-info        generate App Store information alongside the upload
  --icloud-env <name>     Development or Production CloudKit containers
  --thinning <variant>    none, thin-for-all-variants, or a device model id
  --manifest <key>=<url>  appURL, displayImageURL, fullSizeImageURL; repeatable
  --odr-base-url <url>    host the on-demand resource asset packs are served from
  --no-embed-odr          do not embed on-demand resource asset packs in the bundle
${AUTH_FLAG_HELP}
note:
  --method writes the export options plist for you, which is otherwise an XML
  file you have to author by hand. Pass --options to supply your own instead --
  the flags that shape the plist are refused alongside it, rather than being
  silently dropped.
  --upload is the difference between an .ipa on disk and a build in App Store
  Connect; with it there are no products to list, which is success, not an
  empty export. --no-manage-version matters whenever the build number is set
  at archive time, because Xcode otherwise picks its own at upload.
  --profile and --certificate are manual signing, so they set --signing-style
  manual when it was not asked for -- naming a profile and then letting Xcode
  pick one is not a thing anyone means.
  --manifest needs all three of appURL, displayImageURL and fullSizeImageURL;
  a partial manifest exports without error and cannot be installed.
  The Xcode 26 method names -- app-store, ad-hoc, development -- still work and
  are reported as the current name they mean.
examples:
  xcodebuild-axi export build/MyApp.xcarchive --method release-testing
  xcodebuild-axi export build/MyApp.xcarchive --method app-store-connect --team ABCDE12345
  xcodebuild-axi export build/MyApp.xcarchive --method app-store-connect --upload --no-manage-version
  xcodebuild-axi export build/MyApp.xcarchive --options ExportOptions.plist
`;

export const EXPORT_FLAGS = [
  "--method",
  "--team",
  "--options",
  "--output",
  "--artifacts-dir",
  "--upload",
  "--no-manage-version",
  "--no-upload-symbols",
  "--notarized",
  "--allow-provisioning",
  "--signing-style",
  ...PLIST_FLAGS,
  ...AUTH_FLAGS,
] as const;

export const EXPORT_VALUE_FLAGS = [
  "--method",
  "--team",
  "--options",
  "--output",
  "--artifacts-dir",
  "--signing-style",
  ...PLIST_VALUE_FLAGS,
  ...AUTH_VALUE_FLAGS,
] as const;

export async function exportCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "export", EXPORT_FLAGS, EXPORT_VALUE_FLAGS);

  const [rawArchive] = positionals(args, EXPORT_VALUE_FLAGS);
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
  const requested = getFlag(args, "--method");
  const method =
    requested === undefined
      ? undefined
      : (EXPORT_METHOD_ALIASES[requested] ?? requested);
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
  if (optionsPath !== undefined) {
    const ignored = [
      "--upload",
      "--no-manage-version",
      "--no-upload-symbols",
      "--team",
      "--signing-style",
      ...PLIST_FLAGS,
    ].filter((flag) => args.includes(flag));
    if (ignored.length > 0) {
      throw new AxiError(
        `${ignored.join(", ")} ${ignored.length === 1 ? "has" : "have"} nothing to write to when --options supplies the plist`,
        "VALIDATION_ERROR",
        [
          "put the key in your own plist, or drop --options and let --method write one",
          "a flag that shapes the plist is refused here rather than silently dropped",
        ],
      );
    }
  }

  const project = requireProject();
  const artifactsDir = artifactsDirFrom(args);
  const outputPath =
    getFlag(args, "--output") ??
    join(artifactDir(project), `${basenameOf(archivePath)}-export`);

  const plistPath =
    optionsPath ??
    (method
      ? writeGeneratedPlist(args, method, artifactDir(project), archivePath)
      : undefined);

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
    ...(artifactsDir !== undefined ? { outDir: artifactsDir } : {}),
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
): ExportOptions {
  const team = getFlag(args, "--team");
  const certificate = getFlag(args, "--certificate");
  const profiles = keyValues(args, "--profile", "<bundle-id>=<profile>");
  const manifest = manifestOf(args);
  const installerCertificate = getFlag(args, "--installer-certificate");
  const distributionBundleId = getFlag(args, "--distribution-bundle-id");
  const icloud = icloudEnvironment(args);
  const thinning = thinningOf(args);
  const odrBaseURL = getFlag(args, "--odr-base-url");

  // Naming a profile or a certificate *is* manual signing; letting Xcode pick
  // one anyway is not a thing anyone means by it, and the export that results
  // is signed with something other than what was asked for.
  const signingStyle =
    getFlag(args, "--signing-style") ??
    (certificate !== undefined || Object.keys(profiles).length > 0
      ? "manual"
      : undefined);

  return {
    method,
    ...(hasFlag(args, "--upload") ? { destination: "upload" } : {}),
    ...(team !== undefined ? { teamID: team } : {}),
    ...(signingStyle !== undefined ? { signingStyle } : {}),
    ...(certificate !== undefined ? { signingCertificate: certificate } : {}),
    ...(installerCertificate !== undefined
      ? { installerSigningCertificate: installerCertificate }
      : {}),
    ...(Object.keys(profiles).length > 0
      ? { provisioningProfiles: profiles }
      : {}),
    ...(distributionBundleId !== undefined
      ? { distributionBundleIdentifier: distributionBundleId }
      : {}),
    ...(hasFlag(args, "--no-upload-symbols") ? { uploadSymbols: false } : {}),
    ...(hasFlag(args, "--keep-swift-symbols")
      ? { stripSwiftSymbols: false }
      : {}),
    ...(hasFlag(args, "--no-manage-version")
      ? { manageAppVersionAndBuildNumber: false }
      : {}),
    ...(hasFlag(args, "--internal-only")
      ? { testFlightInternalTestingOnly: true }
      : {}),
    ...(hasFlag(args, "--app-store-info")
      ? { generateAppStoreInformation: true }
      : {}),
    ...(icloud !== undefined ? { iCloudContainerEnvironment: icloud } : {}),
    ...(thinning !== undefined ? { thinning } : {}),
    ...(manifest !== undefined ? { manifest } : {}),
    ...(hasFlag(args, "--no-embed-odr")
      ? { embedOnDemandResourcesAssetPacksInBundle: false }
      : {}),
    ...(odrBaseURL !== undefined
      ? { onDemandResourcesAssetPacksBaseURL: odrBaseURL }
      : {}),
  };
}

/** `--flag KEY=VALUE`, repeatable, into the dict the plist wants. */
function keyValues(
  args: string[],
  flag: string,
  shape: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of getListFlag(args, flag)) {
    const split = entry.indexOf("=");
    if (split <= 0) {
      throw new AxiError(
        `${flag} expects ${shape}, got '${entry}'`,
        "VALIDATION_ERROR",
        [`xcodebuild-axi export <path.xcarchive> ${flag} ${shape}`],
      );
    }
    out[entry.slice(0, split)] = entry.slice(split + 1);
  }
  return out;
}

/** The three URLs an over-the-web install needs, and Xcode's optional fourth. */
const MANIFEST_KEYS = [
  "appURL",
  "displayImageURL",
  "fullSizeImageURL",
  "assetPackManifestURL",
] as const;

/**
 * A manifest missing one of its three required URLs exports without an error
 * and produces a link that cannot install, which is the worst shape a failure
 * can take: it fails on someone's device, later, silently.
 */
function manifestOf(args: string[]): Record<string, string> | undefined {
  const manifest = keyValues(args, "--manifest", "<key>=<url>");
  if (Object.keys(manifest).length === 0) return undefined;

  const unknown = Object.keys(manifest).filter(
    (key) => !MANIFEST_KEYS.includes(key as (typeof MANIFEST_KEYS)[number]),
  );
  if (unknown.length > 0) {
    throw new AxiError(
      `Unknown manifest key '${unknown[0]}'`,
      "VALIDATION_ERROR",
      [`valid keys: ${MANIFEST_KEYS.join(", ")}`],
    );
  }

  if (
    getFlag(args, "--odr-base-url") !== undefined &&
    !("assetPackManifestURL" in manifest)
  ) {
    throw new AxiError(
      "--manifest needs assetPackManifestURL when asset packs are hosted",
      "VALIDATION_ERROR",
      [
        "xcodebuild requires that sub-key alongside --odr-base-url",
        "--manifest assetPackManifestURL=https://example.com/AssetPackManifest.plist",
      ],
    );
  }

  const missing = MANIFEST_KEYS.slice(0, 3).filter((key) => !(key in manifest));
  if (missing.length > 0) {
    throw new AxiError(
      `--manifest needs ${missing.join(", ")} as well`,
      "VALIDATION_ERROR",
      [
        "all three of appURL, displayImageURL and fullSizeImageURL are required",
        "a partial manifest exports without error and cannot be installed",
      ],
    );
  }
  return manifest;
}

const ICLOUD_ENVIRONMENTS = ["Development", "Production"] as const;

/**
 * The entitlement value is case-sensitive and the options "vary depending on
 * the type of provisioning profile used", per xcodebuild's own help -- so fix
 * the case of the two everybody means and pass anything else through rather
 * than rejecting a value this tool cannot know is invalid.
 */
function icloudEnvironment(args: string[]): string | undefined {
  const value = getFlag(args, "--icloud-env");
  if (value === undefined) return undefined;
  return (
    ICLOUD_ENVIRONMENTS.find(
      (name) => name.toLowerCase() === value.toLowerCase(),
    ) ?? value
  );
}

/**
 * Xcode spells its two named thinning options with angle brackets around them
 * -- `<none>` and `<thin-for-all-variants>` -- which is not a thing anyone
 * types on purpose, and a device model identifier without. Accept both
 * spellings of the named ones and pass a model through untouched.
 */
function thinningOf(args: string[]): string | undefined {
  const value = getFlag(args, "--thinning");
  if (value === undefined) return undefined;
  const bare = value.replace(/^<|>$/g, "");
  return bare === "none" || bare === "thin-for-all-variants"
    ? `<${bare}>`
    : value;
}

/**
 * Write the plist this command generates on the caller's behalf.
 *
 * It lands beside the log and the result bundle rather than in a `mkdtemp`
 * directory, for two reasons: a temp directory per export accumulated one
 * unreachable copy per run and cleaned up none of them, and the plist is the
 * part of an export people most want to read back when a signing choice comes
 * out wrong. Keyed on the archive so two archives in one project do not
 * overwrite each other, and rewritten in place so runs do not pile up.
 */
function writeGeneratedPlist(
  args: string[],
  method: string,
  dir: string,
  archivePath: string,
): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${basenameOf(archivePath)}-ExportOptions.plist`);
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
