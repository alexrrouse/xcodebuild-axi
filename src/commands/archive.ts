import { join } from "node:path";
import {
  BUILD_FLAG_HELP,
  reportAction,
  resolveBuildContext,
  runAction,
  SHARED_BUILD_FLAGS,
  SHARED_BUILD_VALUE_FLAGS,
} from "../action.js";
import { readArchiveInfo } from "../archive.js";
import {
  authArgs,
  AUTH_FLAGS,
  AUTH_FLAG_HELP,
  AUTH_VALUE_FLAGS,
} from "../auth.js";
import { artifactDir } from "../xcodebuild.js";
import { tildePath } from "../toon.js";
import { getFlag, rejectUnknownFlags } from "../args.js";

export const ARCHIVE_HELP = `usage: xcodebuild-axi archive [flags]
Archives a scheme and reports the archive's identity — bundle id, version, and
build number — so the next step does not need a second lookup.
flags[46]:
${BUILD_FLAG_HELP}
  --archive-path <path>   where to write the .xcarchive (default: the tool's cache)
${AUTH_FLAG_HELP}
note:
  Archiving signs by default, unlike \`build\` — an unsigned archive cannot be
  exported. Pass --allow-provisioning to let xcodebuild fetch profiles.
exit:
  0 archive succeeded, 1 it failed, 2 usage error
examples:
  xcodebuild-axi archive --scheme MyApp
  xcodebuild-axi archive --scheme MyApp --archive-path build/MyApp.xcarchive
`;

const FLAGS = [...SHARED_BUILD_FLAGS, "--archive-path", ...AUTH_FLAGS] as const;
const VALUE_FLAGS = [
  ...SHARED_BUILD_VALUE_FLAGS,
  "--archive-path",
  ...AUTH_VALUE_FLAGS,
] as const;

export async function archiveCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "archive", FLAGS, VALUE_FLAGS);

  // An archive built with CODE_SIGNING_ALLOWED=NO cannot be exported, so
  // unlike every other build-family command this one signs unless told
  // otherwise. Injecting --sign keeps that in one place.
  const signedArgs = args.includes("--sign") ? args : [...args, "--sign"];
  const context = await resolveBuildContext({
    args: signedArgs,
    command: "archive",
  });

  const archivePath =
    getFlag(args, "--archive-path") ??
    join(artifactDir(context.project), `${context.scheme}.xcarchive`);

  const run = await runAction({
    context,
    command: "archive",
    actions: ["archive"],
    extraArgs: ["-archivePath", archivePath, ...authArgs(args, "archive")],
  });

  const info =
    run.exitCode === 0 ? await readArchiveInfo(archivePath) : undefined;

  return reportAction({
    context,
    run,
    key: "archive",
    ok: "created",
    command: "archive",
    extra: {
      ...(run.exitCode === 0 ? { archive: tildePath(archivePath) } : {}),
      ...(info?.bundleIdentifier ? { bundle_id: info.bundleIdentifier } : {}),
      ...(info?.marketingVersion ? { version: info.marketingVersion } : {}),
      ...(info?.buildNumber ? { build: info.buildNumber } : {}),
    },
  });
}
