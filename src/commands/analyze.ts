import {
  BUILD_FLAG_HELP,
  reportAction,
  resolveBuildContext,
  runAction,
  SHARED_BUILD_FLAGS,
  SHARED_BUILD_VALUE_FLAGS,
} from "../action.js";
import { rejectUnknownFlags } from "../args.js";

export const ANALYZE_HELP = `usage: xcodebuild-axi analyze [flags]
Runs the static analyzer and reports its findings with exact source locations.
Analyzer findings are the payload here, not a count — unlike \`build\`, where
they are noise alongside compiler warnings.
flags[41]:
${BUILD_FLAG_HELP}
exit:
  0 the analyze action succeeded (findings do not fail it), 1 it failed, 2 usage error
examples:
  xcodebuild-axi analyze
  xcodebuild-axi analyze --scheme Tides --full
`;

export async function analyzeCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(
    args,
    "analyze",
    SHARED_BUILD_FLAGS,
    SHARED_BUILD_VALUE_FLAGS,
  );

  const context = await resolveBuildContext({ args, command: "analyze" });
  const run = await runAction({
    context,
    command: "analyze",
    actions: ["analyze"],
  });

  return reportAction({
    context,
    run,
    key: "analyze",
    ok: "succeeded",
    command: "analyze",
    analyzer: true,
  });
}
