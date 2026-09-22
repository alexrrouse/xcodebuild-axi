import {
  BUILD_FLAG_HELP,
  reportAction,
  resolveBuildContext,
  runAction,
  SHARED_BUILD_FLAGS,
  SHARED_BUILD_VALUE_FLAGS,
} from "../action.js";
import { AxiError } from "../errors.js";
import { hasFlag, rejectUnknownFlags } from "../args.js";

export const BUILD_HELP = `usage: xcodebuild-axi build [flags]
Builds a scheme and reports only what failed, with exact source locations.
flags[46]:
${BUILD_FLAG_HELP}
  --clean                 clean before building
  --for-testing           build the tests too and emit an .xctestrun (build-for-testing)
  --install               run the install action instead of build
  --docs                  build documentation (docbuild) instead of build
exit:
  0 build succeeded, 1 build failed, 2 usage error
examples:
  xcodebuild-axi build
  xcodebuild-axi build --scheme MyApp --device "iPhone 17 Pro"
  xcodebuild-axi build --scheme MyApp --configuration Release --clean
  xcodebuild-axi build --scheme MyApp --for-testing
`;

export const BUILD_FLAGS = [
  ...SHARED_BUILD_FLAGS,
  "--clean",
  "--for-testing",
  "--install",
  "--docs",
] as const;

export async function buildCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "build", BUILD_FLAGS, SHARED_BUILD_VALUE_FLAGS);

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
