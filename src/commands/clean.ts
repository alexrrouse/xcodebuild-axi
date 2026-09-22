import { reportAction, resolveBuildContext, runAction } from "../action.js";
import { getFlag, rejectUnknownFlags } from "../args.js";

export const CLEAN_HELP = `usage: xcodebuild-axi clean [flags]
Removes a scheme's build products and intermediates.
flags[14]:
  --scheme <name>         scheme to clean (required only when the project has more than one)
  --target <name>         clean a target instead of a scheme; repeatable (project only)
  --all-targets           clean every target in the project (project only)
  --configuration <name>  configuration to clean (default: the scheme's own)
  --destination <spec>    raw xcodebuild destination specifier, passed through untouched
  --device <name>         clean the products for this simulator or device by name
  --destination-timeout <secs>  how long to wait for the destination device
  --sdk <name>            base SDK whose products to clean, e.g. iphonesimulator
  --arch <arch>           architecture to clean; repeatable or comma-separated
  --toolchain <name>      toolchain identifier or name
  --xcconfig <path>       apply build settings from this file as overrides
  --derived-data <path>   derived data directory to clean within
  --artifacts-dir <path>  where to write this run's log and .xcresult (default: the tool's cache)
  --log-level <level>     quiet, normal, or verbose — how much lands in the log file
note:
  A clean is scoped by the same things a build is. Without a destination or an
  --sdk it cleans the products for xcodebuild's default, which is not what a
  simulator build wrote -- so "cleaned" and "still there" are both true answers
  to different questions.
examples:
  xcodebuild-axi clean
  xcodebuild-axi clean --scheme MyApp --configuration Release
  xcodebuild-axi clean --all-targets --derived-data build/dd
`;

export const CLEAN_FLAGS = [
  "--scheme",
  "--target",
  "--all-targets",
  "--configuration",
  "--destination",
  "--device",
  "--destination-timeout",
  "--sdk",
  "--arch",
  "--toolchain",
  "--xcconfig",
  "--derived-data",
  "--artifacts-dir",
  "--log-level",
] as const;

const VALUE_FLAGS = CLEAN_FLAGS.filter(
  (flag) => flag !== "--all-targets",
) as readonly string[];

export async function cleanCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "clean", CLEAN_FLAGS, VALUE_FLAGS);

  // Cleaning needs no destination, and resolving one costs a whole
  // `-showdestinations` subprocess against a scheme we are about to wipe. One
  // named explicitly is still resolved, because then it is the answer.
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
