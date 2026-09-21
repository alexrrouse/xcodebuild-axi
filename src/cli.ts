import { encode } from "@toon-format/toon";
import { runAxiCli } from "axi-sdk-js";
import { AxiError, exitCodeForError } from "./errors.js";
import { VERSION } from "./version.js";
import { homeCommand } from "./commands/home.js";
import { buildCommand, BUILD_HELP } from "./commands/build.js";
import { testCommand, TEST_HELP } from "./commands/test.js";
import { schemesCommand, SCHEMES_HELP } from "./commands/schemes.js";
import {
  destinationsCommand,
  DESTINATIONS_HELP,
} from "./commands/destinations.js";
import { settingsCommand, SETTINGS_HELP } from "./commands/settings.js";
import { resultCommand, RESULT_HELP } from "./commands/result.js";
import { setupCommand, SETUP_HELP } from "./commands/setup.js";

export const DESCRIPTION =
  "Agent-ergonomic wrapper around xcodebuild. Prefer this over raw `xcodebuild` for building, testing, and inspecting Xcode projects.";

export const TOP_HELP = `usage: xcodebuild-axi [command] [flags]
commands[8]:
  (none)=dashboard, build, test, schemes, destinations, settings, result, setup
flags[2]:
  --help, -v/-V/--version
env[2]:
  XCODEBUILD_BIN  override the wrapped xcodebuild binary
  DEVELOPER_DIR   select an Xcode, as xcodebuild itself reads it
exit:
  0 success, 1 the build or tests failed, 2 usage error
examples:
  xcodebuild-axi
  xcodebuild-axi build --scheme Futures
  xcodebuild-axi test --scheme Futures --device "iPhone 17 Pro"
  xcodebuild-axi settings --key PRODUCT_BUNDLE_IDENTIFIER
  xcodebuild-axi setup hooks
`;

const COMMAND_HELP: Record<string, string> = {
  build: BUILD_HELP,
  test: TEST_HELP,
  schemes: SCHEMES_HELP,
  destinations: DESTINATIONS_HELP,
  settings: SETTINGS_HELP,
  result: RESULT_HELP,
  setup: SETUP_HELP,
};

const COMMANDS = {
  build: (args: string[]) => buildCommand(args),
  test: (args: string[]) => testCommand(args),
  schemes: (args: string[]) => schemesCommand(args),
  destinations: (args: string[]) => destinationsCommand(args),
  settings: (args: string[]) => settingsCommand(args),
  result: (args: string[]) => resultCommand(args),
  setup: (args: string[]) => setupCommand(args),
};

type CliStdout = { write: (chunk: string) => unknown };

interface MainOptions {
  argv?: string[];
  stdout?: CliStdout;
}

/**
 * Errors are data: same TOON shape as a normal answer, on stdout, so the agent
 * reads them instead of guessing from an exit code (AXI principle 6).
 */
export function formatCliError(error: unknown): {
  output: string;
  exitCode: number;
} {
  const axiError =
    error instanceof AxiError
      ? error
      : new AxiError(
          error instanceof Error ? error.message : String(error),
          "UNKNOWN",
        );

  const blocks = [encode({ error: axiError.message, code: axiError.code })];
  if (axiError.suggestions.length > 0) {
    blocks.push(
      `help[${axiError.suggestions.length}]:\n${axiError.suggestions.map((line) => `  ${line}`).join("\n")}`,
    );
  }

  return {
    output: `${blocks.join("\n")}\n`,
    exitCode: exitCodeForError(axiError),
  };
}

export async function main(options: MainOptions = {}): Promise<void> {
  await runAxiCli({
    ...(options.argv ? { argv: options.argv } : {}),
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    ...(options.stdout ? { stdout: options.stdout } : {}),
    home: () => homeCommand(),
    commands: COMMANDS,
    getCommandHelp: (command) => COMMAND_HELP[command],
    formatError: formatCliError,
  }).catch((error) => {
    const formatted = formatCliError(error);
    (options.stdout ?? process.stdout).write(formatted.output);
    process.exitCode = formatted.exitCode;
  });
}
