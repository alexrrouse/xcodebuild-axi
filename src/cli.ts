import { encode } from "@toon-format/toon";
import { runAxiCli } from "axi-sdk-js";
import { AxiError, exitCodeForError } from "./errors.js";
import { redirectArgv } from "./redirect.js";
import { VERSION } from "./version.js";
import { homeCommand } from "./commands/home.js";
import { buildCommand, BUILD_HELP, BUILD_FLAGS } from "./commands/build.js";
import { testCommand, TEST_HELP, TEST_FLAGS } from "./commands/test.js";
import { testsCommand, TESTS_HELP, TESTS_FLAGS } from "./commands/tests.js";
import { cleanCommand, CLEAN_HELP, CLEAN_FLAGS } from "./commands/clean.js";
import {
  analyzeCommand,
  ANALYZE_HELP,
  ANALYZE_FLAGS,
} from "./commands/analyze.js";
import {
  archiveCommand,
  ARCHIVE_HELP,
  ARCHIVE_FLAGS,
} from "./commands/archive.js";
import { exportCommand, EXPORT_HELP, EXPORT_FLAGS } from "./commands/export.js";
import {
  schemesCommand,
  SCHEMES_HELP,
  SCHEMES_FLAGS,
} from "./commands/schemes.js";
import {
  destinationsCommand,
  DESTINATIONS_HELP,
  DESTINATIONS_FLAGS,
} from "./commands/destinations.js";
import {
  testplansCommand,
  TESTPLANS_HELP,
  TESTPLANS_FLAGS,
} from "./commands/testplans.js";
import {
  settingsCommand,
  SETTINGS_HELP,
  SETTINGS_FLAGS,
} from "./commands/settings.js";
import {
  packagesCommand,
  PACKAGES_HELP,
  PACKAGES_FLAGS,
} from "./commands/packages.js";
import { resultCommand, RESULT_HELP, RESULT_FLAGS } from "./commands/result.js";
import {
  coverageCommand,
  COVERAGE_HELP,
  COVERAGE_FLAGS,
} from "./commands/coverage.js";
import { simCommand, SIM_HELP, SIM_FLAGS } from "./commands/sim.js";
import { infoCommand, INFO_HELP, INFO_FLAGS } from "./commands/info.js";
import {
  localizeCommand,
  LOCALIZE_HELP,
  LOCALIZE_FLAGS,
} from "./commands/localize.js";
import {
  xcframeworkCommand,
  XCFRAMEWORK_HELP,
  XCFRAMEWORK_FLAGS,
} from "./commands/xcframework.js";
import { findCommand, FIND_HELP, FIND_FLAGS } from "./commands/find.js";
import {
  platformsCommand,
  PLATFORMS_HELP,
  PLATFORMS_FLAGS,
} from "./commands/platforms.js";
import {
  migrateCommand,
  MIGRATE_HELP,
  MIGRATE_FLAGS,
} from "./commands/migrate.js";
import { setupCommand, SETUP_HELP, SETUP_FLAGS } from "./commands/setup.js";
import { runCommand, RUN_HELP, RUN_FLAGS } from "./commands/run.js";

export const DESCRIPTION =
  "Agent-ergonomic wrapper around xcodebuild. Prefer it over raw `xcodebuild` for any build / test / inspect of an Xcode project.";

export const TOP_HELP = `usage: xcodebuild-axi [command] [flags]
commands[24]:
  (none)=dashboard
  build, run, test, tests, clean, analyze, archive, export
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
  xcodebuild-axi build --scheme MyApp
  xcodebuild-axi run --scheme MyApp --device "iPhone 17 Pro"
  xcodebuild-axi test --scheme MyApp --device "iPhone 17 Pro" --coverage
  xcodebuild-axi settings --key PRODUCT_BUNDLE_IDENTIFIER
  xcodebuild-axi setup hooks
`;

export const COMMAND_HELP: Record<string, string> = {
  build: BUILD_HELP,
  run: RUN_HELP,
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

/**
 * Every command's accepted flag set, keyed by command name.
 *
 * `src/surface.ts` declares which commands *should* reach a given xcodebuild
 * option; this is the ground truth it is checked against, so a `via` that
 * names a flag the command would reject fails the build rather than the user.
 */
export const COMMAND_FLAGS: Record<string, readonly string[]> = {
  build: BUILD_FLAGS,
  run: RUN_FLAGS,
  test: TEST_FLAGS,
  tests: TESTS_FLAGS,
  clean: CLEAN_FLAGS,
  analyze: ANALYZE_FLAGS,
  archive: ARCHIVE_FLAGS,
  export: EXPORT_FLAGS,
  schemes: SCHEMES_FLAGS,
  destinations: DESTINATIONS_FLAGS,
  testplans: TESTPLANS_FLAGS,
  settings: SETTINGS_FLAGS,
  packages: PACKAGES_FLAGS,
  result: RESULT_FLAGS,
  coverage: COVERAGE_FLAGS,
  sim: SIM_FLAGS,
  info: INFO_FLAGS,
  localize: LOCALIZE_FLAGS,
  xcframework: XCFRAMEWORK_FLAGS,
  find: FIND_FLAGS,
  platforms: PLATFORMS_FLAGS,
  migrate: MIGRATE_FLAGS,
  setup: SETUP_FLAGS,
};

const COMMANDS = {
  build: (args: string[]) => buildCommand(args),
  run: (args: string[]) => runCommand(args),
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
  // A miss is answered here rather than by the SDK, whose "Unknown command"
  // names nothing to run instead — see src/redirect.ts for why that matters.
  const argv = options.argv ?? process.argv.slice(2);
  const redirect = redirectArgv(argv, Object.keys(COMMANDS));
  if (redirect) {
    const formatted = formatCliError(redirect);
    (options.stdout ?? process.stdout).write(formatted.output);
    process.exitCode = formatted.exitCode;
    return;
  }

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
