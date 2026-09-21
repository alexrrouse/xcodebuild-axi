import { reportAction, resolveBuildContext, runAction } from "../action.js";
import { getFlag, rejectUnknownFlags } from "../args.js";

export const CLEAN_HELP = `usage: xcodebuild-axi clean [flags]
Removes a scheme's build products and intermediates.
flags[3]:
  --scheme <name>         scheme to clean (required only when the project has more than one)
  --configuration <name>  configuration to clean (default: the scheme's own)
  --derived-data <path>   derived data directory to clean within
examples:
  xcodebuild-axi clean
  xcodebuild-axi clean --scheme MyApp --configuration Release
`;

const FLAGS = ["--scheme", "--configuration", "--derived-data"] as const;

export async function cleanCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "clean", FLAGS, FLAGS);

  // Cleaning needs no destination, and resolving one costs a whole
  // `-showdestinations` subprocess against a scheme we are about to wipe.
  const context = await resolveBuildContext({
    args,
    command: "clean",
    needsDestination: false,
  });
  const run = await runAction({
    context,
    command: "clean",
    actions: ["clean"],
  });

  return reportAction({
    context,
    run,
    key: "clean",
    ok: "succeeded",
    command: "clean",
    ...(getFlag(args, "--configuration") !== undefined
      ? { extra: { configuration: getFlag(args, "--configuration") as string } }
      : {}),
  });
}
