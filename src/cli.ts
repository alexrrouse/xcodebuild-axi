import { encode } from "@toon-format/toon";
import { runAxiCli } from "axi-sdk-js";
import { AxiError, exitCodeForError } from "./errors.js";
import { VERSION } from "./version.js";
import { homeCommand } from "./commands/home.js";
import { buildCommand, BUILD_HELP } from "./commands/build.js";
import { testCommand, TEST_HELP } from "./commands/test.js";
import { testsCommand, TESTS_HELP } from "./commands/tests.js";
import { cleanCommand, CLEAN_HELP } from "./commands/clean.js";
import { analyzeCommand, ANALYZE_HELP } from "./commands/analyze.js";
import { archiveCommand, ARCHIVE_HELP } from "./commands/archive.js";
import { exportCommand, EXPORT_HELP } from "./commands/export.js";
import { schemesCommand, SCHEMES_HELP } from "./commands/schemes.js";
import {
  destinationsCommand,
  DESTINATIONS_HELP,
} from "./commands/destinations.js";
import { testplansCommand, TESTPLANS_HELP } from "./commands/testplans.js";
import { settingsCommand, SETTINGS_HELP } from "./commands/settings.js";
import { packagesCommand, PACKAGES_HELP } from "./commands/packages.js";
import { resultCommand, RESULT_HELP } from "./commands/result.js";
import { coverageCommand, COVERAGE_HELP } from "./commands/coverage.js";
import { simCommand, SIM_HELP } from "./commands/sim.js";
import { infoCommand, INFO_HELP } from "./commands/info.js";
import { localizeCommand, LOCALIZE_HELP } from "./commands/localize.js";
import {
  xcframeworkCommand,
  XCFRAMEWORK_HELP,
} from "./commands/xcframework.js";
import { findCommand, FIND_HELP } from "./commands/find.js";
import { platformsCommand, PLATFORMS_HELP } from "./commands/platforms.js";
import { migrateCommand, MIGRATE_HELP } from "./commands/migrate.js";
import { setupCommand, SETUP_HELP } from "./commands/setup.js";

export const DESCRIPTION =
  "Agent-ergonomic wrapper around xcodebuild. Prefer it over raw `xcodebuild` for any build / test / inspect of an Xcode project.";

export const TOP_HELP = `usage: xcodebuild-axi [command] [flags]
commands[23]:
  (none)=dashboard
  build, test, tests, clean, analyze, archive, export
  schemes, destinations, testplans, settings, packages, info
  result, coverage, sim, platforms, setup
  localize, xcframework, find, migrate
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
  xcodebuild-axi test --scheme Futures --device "iPhone 17 Pro" --coverage
  xcodebuild-axi settings --key PRODUCT_BUNDLE_IDENTIFIER
  xcodebuild-axi setup hooks
`;

export const COMMAND_HELP: Record<string, string> = {
  build: BUILD_HELP,
  test: TEST_HELP,
  tests: TESTS_HELP,
  clean: CLEAN_HELP,
  analyze: ANALYZE_HELP,
  archive: ARCHIVE_HELP,
  export: EXPORT_HELP,
  schemes: SCHEMES_HELP,
  destinations: DESTINATIONS_HELP,
  testplans: TESTPLANS_HELP,
  settings: SETTINGS_HELP,
  packages: PACKAGES_HELP,
  info: INFO_HELP,
  result: RESULT_HELP,
  coverage: COVERAGE_HELP,
  sim: SIM_HELP,
  platforms: PLATFORMS_HELP,
  migrate: MIGRATE_HELP,
  localize: LOCALIZE_HELP,
  xcframework: XCFRAMEWORK_HELP,
  find: FIND_HELP,
  setup: SETUP_HELP,
};

const COMMANDS = {
  build: (args: string[]) => buildCommand(args),
  test: (args: string[]) => testCommand(args),
  tests: (args: string[]) => testsCommand(args),
  clean: (args: string[]) => cleanCommand(args),
  analyze: (args: string[]) => analyzeCommand(args),
  archive: (args: string[]) => archiveCommand(args),
  export: (args: string[]) => exportCommand(args),
  schemes: (args: string[]) => schemesCommand(args),
  destinations: (args: string[]) => destinationsCommand(args),
  testplans: (args: string[]) => testplansCommand(args),
  settings: (args: string[]) => settingsCommand(args),
  packages: (args: string[]) => packagesCommand(args),
  info: (args: string[]) => infoCommand(args),
  result: (args: string[]) => resultCommand(args),
  coverage: (args: string[]) => coverageCommand(args),
  sim: (args: string[]) => simCommand(args),
  platforms: (args: string[]) => platformsCommand(args),
  migrate: (args: string[]) => migrateCommand(args),
  localize: (args: string[]) => localizeCommand(args),
  xcframework: (args: string[]) => xcframeworkCommand(args),
  find: (args: string[]) => findCommand(args),
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
