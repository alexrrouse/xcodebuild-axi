/**
 * How much of `xcodebuild` this tool actually covers.
 *
 * Wrapping a CLI silently narrows it, and the narrowing is invisible until an
 * agent needs the one flag that got left out. So the mapping is declared here
 * rather than inferred: every option `xcodebuild -help` prints is classified,
 * and `npm run coverage -- --check` fails if a new Xcode adds one this file
 * has never heard of.
 *
 * "Covered" is asked along four axes, because for a long time it was only
 * asked along the first and the misses all landed on the other three:
 *
 * 1. **Options** — does any command reach this option at all.
 * 2. **Reach** — does every command xcodebuild accepts it on reach it. An
 *    option exposed on `build` and missing from `settings` is not covered for
 *    anyone asking `settings`, and nothing used to say so.
 * 3. **Forms and sub-surfaces** — the options behind an option: the keys of
 *    `-exportOptionsPlist`, the arguments of `-create-xcframework`, the second
 *    modes that `-help` documents only inside a usage line.
 * 4. **Companion tools** — `xcresulttool`, `xccov`, `simctl`. Not xcodebuild,
 *    so not in its headline number, but this tool wraps them and an agent that
 *    has to shell out to one directly has dropped back down.
 */

/**
 * The Xcode whose `xcodebuild -help` this map was written against.
 *
 * The option list is not stable across Xcode releases — 26 listed `-dry-run`
 * and `-downloadAllPreviouslySelectedPlatforms`, 27 dropped both and added the
 * `platforms` and codesize families. So a machine running a different Xcode
 * will legitimately disagree with this file, and only a machine running this
 * one can say the map is actually stale. `scripts/coverage.ts` fails on a
 * mismatch here and merely reports one elsewhere.
 */
export const AUTHORED_AGAINST = "27.0";

/** One command that reaches a thing, and the words that reach it. */
export interface Exposure {
  /** The `xcodebuild-axi` command. */
  command: string;
  /** How it is reached, e.g. `settings --for-index`. */
  via: string;
}

/** A command that could reach a thing and does not. */
export interface Gap {
  command: string;
  why: string;
}

export type OptionCoverage =
  /** Reachable through an xcodebuild-axi flag or command. */
  | {
      status: "exposed";
      on: readonly Exposure[];
      /** The command set this option applies to, when it is more than `on`. */
      surface?: SurfaceName;
      /** Commands in that set it will never reach, and why not. */
      declined?: readonly Gap[];
      /** Commands in that set it should reach and does not, yet. */
      missing?: readonly Gap[];
    }
  /** The tool always sets it, so there is nothing for a caller to pass. */
  | { status: "always"; why: string }
  /** Answered better by something xcodebuild-axi already does. */
  | { status: "superseded"; why: string }
  /**
   * Not wrapped yet. A gap being paid down, not a boundary — `from` names the
   * command that will grow it, so the open list reads as a work plan.
   */
  | { status: "missing"; why: string; from?: string }
  /** Deliberately not wrapped, for the stated reason. */
  | { status: "n/a"; why: string };

/**
 * The commands an option can apply to, by kind.
 *
 * xcodebuild's own usage lines are the authority: `-target` and `-alltargets`
 * sit on the same line as `-showBuildSettings`, so `settings` is expected to
 * take them; `-showdestinations` appears only on the `-scheme` lines, so
 * `destinations` is not expected to take a target.
 */
export const BUILD_FAMILY = [
  "build",
  "test",
  "tests",
  "analyze",
  "archive",
] as const;

export const SURFACES = {
  /** Shapes compilation, so only the commands that compile something. */
  build: BUILD_FAMILY,
  /** Applies to any action word, `clean` included. */
  action: [...BUILD_FAMILY, "clean"],
  /** Changes what the project resolves to, which `settings` reports on. */
  resolution: [...BUILD_FAMILY, "clean", "settings"],
  /** Package resolution, which `packages` drives on its own. */
  package: [...BUILD_FAMILY, "packages"],
  /** Selects a scheme to act on. */
  scheme: [
    ...BUILD_FAMILY,
    "clean",
    "settings",
    "destinations",
    "testplans",
    "packages",
    "localize",
  ],
  /** Constrains which tests are run, and so which tests are enumerated. */
  testing: ["test", "tests"],
} as const;

export type SurfaceName = keyof typeof SURFACES;

/** `"settings --for-index"` -> `{ command: "settings", via: "settings --for-index" }`. */
export function at(via: string): Exposure {
  return { command: via.split(/\s+/)[0] as string, via };
}

/** The same flag on several commands, which is the common case. */
function sameFlag(commands: readonly string[], flag: string): Exposure[] {
  return commands.map((command) => at(`${command} ${flag}`));
}

interface EverywhereOptions {
  /** Commands outside the surface that also reach it, as full `via` strings. */
  also?: readonly string[];
  missing?: readonly Gap[];
  declined?: readonly Gap[];
}

/**
 * An option every command in a surface reaches by the same flag name, minus
 * whichever of them is listed as a gap.
 */
function everywhere(
  surface: SurfaceName,
  flag: string,
  options: EverywhereOptions = {},
): OptionCoverage {
  const absent = new Set([
    ...(options.missing ?? []).map((gap) => gap.command),
    ...(options.declined ?? []).map((gap) => gap.command),
  ]);
  return {
    status: "exposed",
    surface,
    on: [
      ...sameFlag(
        SURFACES[surface].filter((command) => !absent.has(command)),
        flag,
      ),
      ...(options.also ?? []).map(at),
    ],
    ...(options.missing ? { missing: options.missing } : {}),
    ...(options.declined ? { declined: options.declined } : {}),
  };
}

/** An option reached from one place, which needs no surface. */
function only(...via: readonly string[]): OptionCoverage {
  return { status: "exposed", on: via.map(at) };
}

const gap = (command: string, why: string): Gap => ({ command, why });

/** The gaps this file exists to make visible, phrased once and shared. */

export const OPTION_COVERAGE: Record<string, OptionCoverage> = {
  "-allowProvisioningDeviceRegistration": only(
    "archive --allow-device-registration",
    "export --allow-device-registration",
  ),
  "-allowProvisioningUpdates": everywhere("build", "--allow-provisioning", {
    also: ["export --allow-provisioning"],
  }),
  "-alltargets": everywhere("resolution", "--all-targets"),
  "-arch": everywhere("resolution", "--arch"),
  "-architecture": only("platforms device-support --architecture"),
  "-archivePath": only("archive --archive-path", "export <path.xcarchive>"),
  "-authenticationKeyID": only("archive --auth-key-id", "export --auth-key-id"),
  "-authenticationKeyIssuerID": only(
    "archive --auth-key-issuer",
    "export --auth-key-issuer",
  ),
  "-authenticationKeyPath": only(
    "archive --auth-key-path",
    "export --auth-key-path",
  ),
  "-checkFirstLaunchStatus": only("platforms first-launch --status"),
  "-clonedSourcePackagesDirPath": everywhere("package", "--cache"),
  "-codesizeProfileOutputDir": everywhere("build", "--codesize"),
  "-collect-test-diagnostics": only("test --diagnostics"),
  "-configuration": everywhere("resolution", "--configuration"),
  "-create-xcframework": only("xcframework"),
  "-default-test-execution-time-allowance": only("test --default-test-timeout"),
  "-defaultLanguage": only("localize export --default-language"),
  "-defaultPackageRegistryURL": everywhere("package", "--registry-url"),
  "-deleteComponent": only("platforms component delete"),
  "-derivedDataPath": everywhere("resolution", "--derived-data", {
    also: ["packages --derived-data"],
  }),
  "-destination": everywhere("resolution", "--destination"),
  "-destination-timeout": everywhere("resolution", "--destination-timeout"),
  "-disableAutomaticPackageResolution": everywhere(
    "package",
    "--no-auto-resolve",
  ),
  "-disablePackageRepositoryCache": everywhere("package", "--no-package-cache"),
  "-downloadAllPlatforms": only("platforms download --all"),
  "-downloadComponent": only("platforms component download"),
  "-downloadPlatform": only("platforms download"),
  "-enableAddressSanitizer": everywhere("build", "--sanitizer address"),
  "-enableCodeCoverage": only("test --coverage"),
  "-enableCodesizeProfile": everywhere("build", "--codesize"),
  "-enablePerformanceTestsDiagnostics": only("test --perf-diagnostics"),
  "-enableThreadSanitizer": everywhere("build", "--sanitizer thread"),
  "-enableUndefinedBehaviorSanitizer": everywhere(
    "build",
    "--sanitizer undefined",
  ),
  "-enumerate-tests": only("tests"),
  "-exportArchive": only("export"),
  "-exportLanguage": only("localize export --language"),
  "-exportLocalizations": only("localize export"),
  "-exportNotarizedApp": only("export --notarized"),
  "-exportOptionsPlist": only("export --options"),
  "-exportPath": only(
    "export --output",
    "platforms download --export-path",
    "platforms component download --export-path",
  ),
  "-find-executable": only("find"),
  "-find-library": only("find --library"),
  "-hideShellScriptEnvironment": everywhere("build", "--hide-script-env"),
  "-importComponent": only("platforms component import"),
  "-importLocalizations": only("localize import"),
  "-importPath": only("platforms component import --import-path"),
  "-importPlatform": only("platforms import"),
  "-jobs": everywhere("build", "--jobs"),
  "-list": only("schemes"),
  "-localizationPath": only("localize --path"),
  "-maximum-concurrent-test-device-destinations": only(
    "test --max-device-destinations",
  ),
  "-maximum-concurrent-test-simulator-destinations": only(
    "test --max-sim-destinations",
  ),
  "-maximum-parallel-testing-workers": only("test --max-workers"),
  "-maximum-test-execution-time-allowance": only("test --test-timeout"),
  "-modelCode": only("platforms device-support --model-code"),
  "-only-test-configuration": only("test --only-configuration"),
  "-only-testing": everywhere("testing", "--only"),
  "-onlyUsePackageVersionsFromResolvedFile": everywhere("package", "--offline"),
  "-osVersion": only("platforms device-support --os-version"),
  "-packageAuthorizationProvider": everywhere("package", "--package-auth"),
  "-packageCachePath": everywhere("package", "--package-cache"),
  "-packageDependencySCMToRegistryTransformation": everywhere(
    "package",
    "--scm-to-registry",
  ),
  "-packageFingerprintPolicy": everywhere("package", "--fingerprint-policy"),
  "-packageSigningEntityPolicy": everywhere(
    "package",
    "--signing-entity-policy",
  ),
  "-parallel-testing-enabled": only("test --parallel / --no-parallel"),
  "-parallel-testing-worker-count": only("test --max-workers"),
  "-parallelizeTargets": everywhere("build", "--parallelize-targets"),
  "-platform": only("platforms device-support --platform"),
  "-prepareDeviceSupport": only("platforms device-support"),
  "-resolvePackageDependencies": only("packages --resolve"),
  "-retry-tests-on-failure": only("test --retry"),
  "-run-tests-until-failure": only("test --until-failure"),
  "-runFirstLaunch": only("platforms first-launch"),
  "-scheme": everywhere("scheme", "--scheme"),
  "-scmProvider": everywhere("package", "--scm-provider"),
  "-sdk": everywhere("resolution", "--sdk", {
    also: ["find --sdk"],
  }),
  "-showBuildSettings": only("settings"),
  "-showBuildSettingsForIndex": only("settings --for-index"),
  "-showBuildTimingSummary": everywhere("build", "--timing"),
  "-showComponent": only("platforms component show"),
  "-showdestinations": only("destinations"),
  "-showsdks": only("info --sdks"),
  "-showTestPlans": only("testplans"),
  "-skip-test-configuration": only("test --skip-configuration"),
  "-skip-testing": everywhere("testing", "--skip"),
  "-skipPackagePluginValidation": everywhere(
    "package",
    "--skip-plugin-validation",
  ),
  "-skipPackageSignatureValidation": everywhere(
    "package",
    "--skip-signature-validation",
  ),
  "-skipPackageUpdates": everywhere("package", "--skip-package-updates"),
  "-skipUnavailableActions": everywhere("build", "--skip-unavailable-actions"),
  "-target": everywhere("resolution", "--target"),
  "-test-iterations": only("test --iterations"),
  "-test-repetition-relaunch-enabled": only("test --relaunch"),
  "-test-timeouts-enabled": only("test --test-timeout"),
  "-testLanguage": only("test --language"),
  "-testPlan": everywhere("testing", "--test-plan"),
  "-testProductsPath": only("test --test-products"),
  "-testRegion": only("test --region"),
  "-toolchain": everywhere("resolution", "--toolchain", {
    also: ["find --toolchain"],
  }),
  "-version": only("info"),
  "-xcconfig": everywhere("resolution", "--xcconfig"),
  "-xctestrun": only("test --xctestrun"),
  "-json": {
    status: "always",
    why: "every read-only query asks for JSON, then reports TOON",
  },
  "-project": {
    status: "always",
    why: "set from the .xcodeproj found in the working directory",
  },
  "-resultBundlePath": everywhere("action", "--artifacts-dir"),
  "-skipMacroValidation": {
    status: "always",
    why: "macro trust is an interactive prompt in disguise, and an agent cannot answer it",
  },
  "-test-enumeration-format": {
    status: "always",
    why: "always json, so `tests` can parse it",
  },
  "-test-enumeration-output-path": {
    status: "always",
    why: "written to the tool's cache and read back, never printed",
  },
  "-test-enumeration-style": {
    status: "always",
    why: "always flat; `tests` does its own grouping by target and suite",
  },
  "-workspace": {
    status: "always",
    why: "set from the .xcworkspace found in the working directory",
  },
  "-convert-project": only("migrate --format"),
  "-help": {
    status: "superseded",
    why: "`xcodebuild-axi --help`, which answers it in a fraction of the tokens",
  },
  "-license": only("platforms license"),
  "-quiet": everywhere("action", "--log-level quiet"),
  "-resultBundleVersion": everywhere("build", "--bundle-version"),
  "-resultStreamPath": everywhere("build", "--stream"),
  "-usage": {
    status: "superseded",
    why: "`xcodebuild-axi <command> --help`, per command rather than all 117 at once",
  },
  "-verbose": everywhere("action", "--log-level verbose"),
};

/** The build actions, classified the same way. */
export const ACTION_COVERAGE: Record<string, OptionCoverage> = {
  build: only("build"),
  "build-for-testing": only("build --for-testing"),
  analyze: only("analyze"),
  archive: only("archive"),
  test: only("test"),
  "test-without-building": only("test --without-building"),
  docbuild: only("build --docs"),
  clean: only("clean"),
  install: only("build --install"),
  installsrc: {
    status: "n/a",
    why: "copies sources into SRCROOT as root; a packaging step, not an agent loop",
  },
};

/**
 * The second forms of an option, which `-help` documents only inside a usage
 * line or a sentence. Nothing enumerates these, so they are the easiest kind
 * of gap to ship: `-runFirstLaunch -checkForNewerComponents` is a flag on a
 * flag, mentioned once, in prose.
 */
export const FORM_COVERAGE: Record<string, OptionCoverage> = {
  "-version -sdk <name> <infoitem>": {
    status: "missing",
    from: "info",
    why: "`info --sdks` lists canonical names; an SDK's Path or ProductBuildVersion cannot be asked for",
  },
  "-runFirstLaunch -checkForNewerComponents": only(
    "platforms first-launch --check-updates",
  ),
  "-license check": only("platforms license"),
  "<buildsetting>=<value>": {
    status: "exposed",
    on: [{ command: "settings", via: "settings --setting" }],
    missing: [
      gap(
        "build",
        "an override can be resolved but not built with, so `--setting` answers a question it cannot then act on",
      ),
    ],
  },
  "-only-testing @<response-file>": only("test --only"),
  "-skip-testing @<response-file>": only("test --skip"),
  "-showBuildSettings -json": {
    status: "always",
    why: "always asked for as JSON, then reported as TOON",
  },
  "-create-xcframework -help": {
    status: "superseded",
    why: "`xcodebuild-axi xcframework --help`",
  },
};

/**
 * `-exportOptionsPlist` keys.
 *
 * The plist is the whole configuration surface of `-exportArchive`, and
 * authoring one by hand is exactly the side quest `--method` exists to remove
 * — so a key with no flag is a key that sends the agent back to writing XML.
 */
export const EXPORT_OPTION_COVERAGE: Record<string, OptionCoverage> = {
  method: only("export --method"),
  destination: only("export --upload"),
  teamID: only("export --team"),
  signingStyle: only("export --signing-style"),
  uploadSymbols: only("export --no-upload-symbols"),
  manageAppVersionAndBuildNumber: only("export --no-manage-version"),
  provisioningProfiles: {
    status: "missing",
    from: "export",
    why: "manual signing can be asked for but not completed — the profile per executable has no flag",
  },
  signingCertificate: {
    status: "missing",
    from: "export",
    why: "manual signing cannot name the certificate to sign with",
  },
  installerSigningCertificate: {
    status: "missing",
    from: "export",
    why: "a macOS installer package cannot name its signing certificate",
  },
  thinning: {
    status: "missing",
    from: "export",
    why: "non-App Store exports cannot be thinned for a device variant",
  },
  stripSwiftSymbols: {
    status: "missing",
    from: "export",
    why: "Swift symbols are always stripped, with no way to keep them",
  },
  testFlightInternalTestingOnly: {
    status: "missing",
    from: "export",
    why: "a build cannot be marked internal-only, which is what a PR build wants",
  },
  distributionBundleIdentifier: {
    status: "missing",
    from: "export",
    why: "an archive with several apps cannot pick which one to export",
  },
  generateAppStoreInformation: {
    status: "missing",
    from: "export",
    why: "App Store information cannot be generated for an upload",
  },
  iCloudContainerEnvironment: {
    status: "missing",
    from: "export",
    why: "a CloudKit app cannot choose the Development or Production container",
  },
  manifest: {
    status: "missing",
    from: "export",
    why: "an over-the-web distribution manifest cannot be written",
  },
  embedOnDemandResourcesAssetPacksInBundle: {
    status: "missing",
    from: "export",
    why: "on-demand resource asset packs cannot be embedded for testing",
  },
  onDemandResourcesAssetPacksBaseURL: {
    status: "missing",
    from: "export",
    why: "on-demand resource asset packs cannot be pointed at a host",
  },
};

/** `-create-xcframework`'s own options, which only its `-help` prints. */
export const XCFRAMEWORK_COVERAGE: Record<string, OptionCoverage> = {
  "-framework": only("xcframework --framework"),
  "-library": only("xcframework --library"),
  "-headers": only("xcframework --headers"),
  "-output": only("xcframework --output"),
  "-archive": only("xcframework --archive"),
  "-debug-symbols": only("xcframework --debug-symbols"),
  "-allow-internal-distribution": only(
    "xcframework --allow-internal-distribution",
  ),
  "-help": {
    status: "superseded",
    why: "`xcodebuild-axi xcframework --help`",
  },
};

/**
 * `xcresulttool`, which owns every answer about a run that already happened.
 *
 * The result bundle is this tool's source of truth (see AGENTS.md), so a leaf
 * missing here is an answer the bundle holds and the tool cannot read out —
 * `test --diagnostics` collecting a report nothing can open, for instance.
 */
export const XCRESULT_COVERAGE: Record<string, OptionCoverage> = {
  "get build-results": only("result", "build", "test"),
  "get test-results summary": only("result", "test"),
  "get test-results tests": {
    status: "missing",
    from: "result",
    why: "the full test tree of a finished run cannot be listed",
  },
  "get test-results test-details": only("result", "test"),
  "get test-results activities": {
    status: "missing",
    from: "result",
    why: "the step-by-step activity trail of a failing test cannot be read",
  },
  "get test-results insights": {
    status: "missing",
    from: "result",
    why: "Xcode's own diagnosis of a run is left on the floor",
  },
  "get test-results metrics": {
    status: "missing",
    from: "result",
    why: "`test --perf-diagnostics` collects performance metrics nothing can read back",
  },
  "get log": {
    status: "missing",
    from: "result",
    why: "the build log inside the bundle is reachable only as the raw transcript file",
  },
  "get content-availability": {
    status: "missing",
    from: "result",
    why: "whether a bundle even has coverage or test results is found out by failing to read it",
  },
  "export diagnostics": {
    status: "missing",
    from: "result",
    why: "`test --diagnostics` collects a diagnostics report that cannot be extracted",
  },
  "export attachments": {
    status: "missing",
    from: "result",
    why: "UI test screenshots and attachments cannot be got out of the bundle",
  },
  "export metrics": {
    status: "missing",
    from: "result",
    why: "performance measurements cannot be exported as CSV",
  },
  "export evaluations": {
    status: "missing",
    from: "result",
    why: "evaluation attachments cannot be exported",
  },
  compare: {
    status: "missing",
    from: "result",
    why: "two runs cannot be diffed, which is the question CI asks most",
  },
  merge: {
    status: "missing",
    from: "result",
    why: "the bundles of a sharded test run cannot be combined",
  },
  metadata: {
    status: "missing",
    from: "result",
    why: "a bundle's own metadata cannot be read",
  },
  "export coverage": {
    status: "superseded",
    why: "`coverage` reads the report with xccov rather than exporting an archive",
  },
  "get object": {
    status: "n/a",
    why: "deprecated by Xcode in favour of the typed subcommands",
  },
  "export object": {
    status: "n/a",
    why: "deprecated by Xcode in favour of get attachments|diagnostics|coverage",
  },
  graph: { status: "n/a", why: "deprecated by Xcode" },
  formatDescription: { status: "n/a", why: "deprecated by Xcode" },
};

/** `xccov`, which owns coverage. */
export const XCCOV_COVERAGE: Record<string, OptionCoverage> = {
  "view --report": only("coverage"),
  "view --report --only-targets": only("coverage"),
  "view --report --files-for-target": only("coverage --target"),
  "view --report --file-list": only("coverage --files"),
  "view --report --functions-for-file": {
    status: "missing",
    from: "coverage",
    why: "coverage stops at the file, so the uncovered function has no name",
  },
  "view --archive": {
    status: "missing",
    from: "coverage",
    why: "a standalone .xccovarchive cannot be read, only a result bundle",
  },
  "view --file": {
    status: "missing",
    from: "coverage",
    why: "the per-line coverage of one file cannot be printed",
  },
  diff: {
    status: "missing",
    from: "coverage",
    why: "'did coverage drop' cannot be answered from two bundles this tool wrote",
  },
  merge: {
    status: "missing",
    from: "coverage",
    why: "the coverage of a sharded run cannot be combined",
  },
};

/**
 * `simctl`, which owns simulators.
 *
 * `sim` exists to put a destination into the state a build or test run needs,
 * and stops there. The rest is classified so the boundary is a decision on
 * the record rather than an omission.
 */
export const SIMCTL_COVERAGE: Record<string, OptionCoverage> = {
  list: only("sim list"),
  boot: only("sim boot"),
  shutdown: only("sim shutdown"),
  erase: only("sim erase"),
  install: {
    status: "missing",
    from: "sim",
    why: "a built .app cannot be put on the simulator it was built for",
  },
  launch: {
    status: "missing",
    from: "sim",
    why: "the app a build just produced cannot be run",
  },
  terminate: { status: "missing", why: "a running app cannot be stopped" },
  uninstall: { status: "missing", why: "an installed app cannot be removed" },
  listapps: {
    status: "missing",
    from: "sim",
    why: "what is installed on a simulator cannot be listed",
  },
  create: { status: "missing", why: "a missing device cannot be created" },
  delete: {
    status: "missing",
    from: "sim",
    why: "stale devices cannot be reclaimed, and they cost gigabytes",
  },
  io: {
    status: "missing",
    from: "sim",
    why: "a screenshot of a failing UI cannot be taken",
  },
  openurl: {
    status: "missing",
    from: "sim",
    why: "a deep link cannot be opened, which is how deep links are tested",
  },
  privacy: {
    status: "missing",
    from: "sim",
    why: "a permission prompt cannot be granted ahead of a UI test",
  },
  push: {
    status: "missing",
    from: "sim",
    why: "a push notification cannot be simulated",
  },
  status_bar: {
    status: "missing",
    from: "sim",
    why: "the status bar cannot be pinned, which screenshot tests need",
  },
  ui: {
    status: "missing",
    from: "sim",
    why: "dark mode and content size cannot be set for a test run",
  },
  spawn: {
    status: "n/a",
    why: "running arbitrary processes on a device is not this tool's job",
  },
  diagnose: {
    status: "n/a",
    why: "a sysdiagnose is an Apple support artifact, not an agent loop",
  },
  addmedia: {
    status: "n/a",
    why: "photo library fixtures belong to a test target, not a build wrapper",
  },
  appinfo: {
    status: "n/a",
    why: "`listapps` answers the same question for an agent",
  },
  get_app_container: {
    status: "n/a",
    why: "a container path is a debugging detail, not a build output",
  },
  getenv: {
    status: "n/a",
    why: "device environment variables are a simctl debugging tool",
  },
  clone: {
    status: "n/a",
    why: "device farming is outside a build and test loop",
  },
  rename: { status: "n/a", why: "device naming is a Simulator.app concern" },
  upgrade: {
    status: "n/a",
    why: "runtime migration is a Simulator.app concern",
  },
  reboot: { status: "n/a", why: "shutdown and boot cover what a run needs" },
  runtime: {
    status: "n/a",
    why: "`platforms` downloads runtimes through xcodebuild",
  },
  location: {
    status: "n/a",
    why: "simulated location belongs to a test target",
  },
  keychain: {
    status: "n/a",
    why: "seeding a keychain belongs to a test target",
  },
  logverbose: { status: "n/a", why: "a simctl debugging switch" },
  icloud_sync: {
    status: "n/a",
    why: "an iCloud testing concern, not a build one",
  },
  install_app_data: {
    status: "n/a",
    why: "app data fixtures belong to a test target",
  },
  personalization: {
    status: "n/a",
    why: "personalization manifests are a device provisioning concern",
  },
  pair: { status: "n/a", why: "watch pairing is a Simulator.app concern" },
  pair_activate: {
    status: "n/a",
    why: "watch pairing is a Simulator.app concern",
  },
  unpair: { status: "n/a", why: "watch pairing is a Simulator.app concern" },
  pbcopy: {
    status: "n/a",
    why: "pasteboard plumbing belongs to a test target",
  },
  pbpaste: {
    status: "n/a",
    why: "pasteboard plumbing belongs to a test target",
  },
  pbsync: {
    status: "n/a",
    why: "pasteboard plumbing belongs to a test target",
  },
  help: { status: "superseded", why: "`xcodebuild-axi sim --help`" },
};

/** Every non-xcodebuild surface this tool wraps, for one combined number. */
export const COMPANION_SURFACES: Record<
  string,
  Record<string, OptionCoverage>
> = {
  xcresulttool: XCRESULT_COVERAGE,
  xccov: XCCOV_COVERAGE,
  simctl: SIMCTL_COVERAGE,
};

export interface CoverageTally {
  total: number;
  exposed: number;
  always: number;
  superseded: number;
  missing: number;
  na: number;
  /** Reachable, handled for you, or answered better — what the README quotes. */
  covered: number;
  percent: number;
}

export function tally(map: Record<string, OptionCoverage>): CoverageTally {
  const values = Object.values(map);
  const count = (status: OptionCoverage["status"]) =>
    values.filter((entry) => entry.status === status).length;

  const exposed = count("exposed");
  const always = count("always");
  const superseded = count("superseded");
  const missing = count("missing");
  const na = count("n/a");
  const covered = exposed + always + superseded;

  return {
    total: values.length,
    exposed,
    always,
    superseded,
    missing,
    na,
    covered,
    // `n/a` options stay in the denominator on purpose. Declining to wrap
    // something is a choice this number should have to pay for.
    percent: percent(covered, values.length),
  };
}

export function percent(part: number, whole: number): number {
  return whole === 0 ? 100 : Math.round((part / whole) * 1000) / 10;
}

/** Every command an option applies to, whether or not it reaches it. */
export function applicable(entry: OptionCoverage): string[] {
  if (entry.status !== "exposed") return [];
  const commands = new Set<string>(
    entry.surface ? SURFACES[entry.surface] : [],
  );
  for (const exposure of entry.on) commands.add(exposure.command);
  for (const item of entry.declined ?? []) commands.add(item.command);
  for (const item of entry.missing ?? []) commands.add(item.command);
  return [...commands];
}

export interface ReachTally {
  /** Command-and-option pairs that could exist. */
  pairs: number;
  reached: number;
  declined: number;
  missing: number;
  percent: number;
}

/**
 * Coverage counted per command rather than per option.
 *
 * The headline number asks whether an option is reachable at all; this one
 * asks whether it is reachable from where you are standing, which is the
 * question an agent that just got `unknown flag --target` was asking.
 */
export function reach(map: Record<string, OptionCoverage>): ReachTally {
  let reached = 0;
  let declined = 0;
  let missing = 0;

  for (const entry of Object.values(map)) {
    if (entry.status !== "exposed") continue;
    reached += new Set(entry.on.map((exposure) => exposure.command)).size;
    declined += entry.declined?.length ?? 0;
    missing += entry.missing?.length ?? 0;
  }

  const pairs = reached + declined + missing;
  return {
    pairs,
    reached,
    declined,
    missing,
    percent: percent(reached, pairs),
  };
}

/** Every gap in a map, as `option` -> the commands that should reach it. */
export function gaps(
  map: Record<string, OptionCoverage>,
): Array<{ option: string; command: string; why: string }> {
  const out: Array<{ option: string; command: string; why: string }> = [];
  for (const [option, entry] of Object.entries(map)) {
    if (entry.status !== "exposed") continue;
    for (const item of entry.missing ?? []) {
      out.push({ option, command: item.command, why: item.why });
    }
  }
  return out;
}

/** The README's one-line answer to "how do I reach this?". */
export function describe(entry: OptionCoverage): string {
  return entry.status === "exposed"
    ? entry.on.map((exposure) => exposure.via).join(", ")
    : entry.why;
}
