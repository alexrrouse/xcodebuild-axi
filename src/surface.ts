/**
 * How much of `xcodebuild` this tool actually covers.
 *
 * Wrapping a CLI silently narrows it, and the narrowing is invisible until an
 * agent needs the one flag that got left out. So the mapping is declared here
 * rather than inferred: every option `xcodebuild -help` prints is classified,
 * and `npm run coverage -- --check` fails if a new Xcode adds one this file
 * has never heard of.
 */

export type OptionCoverage =
  /** Reachable through an xcodebuild-axi flag or command. */
  | { status: "exposed"; via: string }
  /** The tool always sets it, so there is nothing for a caller to pass. */
  | { status: "always"; why: string }
  /** Deliberately not wrapped, for the stated reason. */
  | { status: "n/a"; why: string };

export const OPTION_COVERAGE: Record<string, OptionCoverage> = {
  "-allowProvisioningDeviceRegistration": {
    status: "exposed",
    via: "archive --allow-device-registration",
  },
  "-allowProvisioningUpdates": {
    status: "exposed",
    via: "build --allow-provisioning",
  },
  "-alltargets": { status: "exposed", via: "build --all-targets" },
  "-arch": { status: "exposed", via: "build --arch" },
  "-architecture": {
    status: "exposed",
    via: "platforms device-support --architecture",
  },
  "-archivePath": { status: "exposed", via: "archive --archive-path" },
  "-authenticationKeyID": { status: "exposed", via: "archive --auth-key-id" },
  "-authenticationKeyIssuerID": {
    status: "exposed",
    via: "archive --auth-key-issuer",
  },
  "-authenticationKeyPath": {
    status: "exposed",
    via: "archive --auth-key-path",
  },
  "-checkFirstLaunchStatus": {
    status: "exposed",
    via: "platforms first-launch --status",
  },
  "-clonedSourcePackagesDirPath": {
    status: "exposed",
    via: "packages --cache",
  },
  "-codesizeProfileOutputDir": { status: "exposed", via: "build --codesize" },
  "-collect-test-diagnostics": { status: "exposed", via: "test --diagnostics" },
  "-configuration": { status: "exposed", via: "build --configuration" },
  "-create-xcframework": { status: "exposed", via: "xcframework" },
  "-default-test-execution-time-allowance": {
    status: "exposed",
    via: "test --default-test-timeout",
  },
  "-defaultLanguage": {
    status: "exposed",
    via: "localize export --default-language",
  },
  "-defaultPackageRegistryURL": {
    status: "exposed",
    via: "packages --registry-url",
  },
  "-deleteComponent": { status: "exposed", via: "platforms component delete" },
  "-derivedDataPath": { status: "exposed", via: "build --derived-data" },
  "-destination": { status: "exposed", via: "build --destination" },
  "-destination-timeout": {
    status: "exposed",
    via: "build --destination-timeout",
  },
  "-disableAutomaticPackageResolution": {
    status: "exposed",
    via: "build --no-auto-resolve",
  },
  "-disablePackageRepositoryCache": {
    status: "exposed",
    via: "build --no-package-cache",
  },
  "-downloadAllPlatforms": {
    status: "exposed",
    via: "platforms download --all",
  },
  "-downloadComponent": {
    status: "exposed",
    via: "platforms component download",
  },
  "-downloadPlatform": { status: "exposed", via: "platforms download" },
  "-enableAddressSanitizer": {
    status: "exposed",
    via: "build --sanitizer address",
  },
  "-enableCodeCoverage": { status: "exposed", via: "test --coverage" },
  "-enableCodesizeProfile": { status: "exposed", via: "build --codesize" },
  "-enablePerformanceTestsDiagnostics": {
    status: "exposed",
    via: "test --perf-diagnostics",
  },
  "-enableThreadSanitizer": {
    status: "exposed",
    via: "build --sanitizer thread",
  },
  "-enableUndefinedBehaviorSanitizer": {
    status: "exposed",
    via: "build --sanitizer undefined",
  },
  "-enumerate-tests": { status: "exposed", via: "tests" },
  "-exportArchive": { status: "exposed", via: "export" },
  "-exportLanguage": { status: "exposed", via: "localize export --language" },
  "-exportLocalizations": { status: "exposed", via: "localize export" },
  "-exportNotarizedApp": { status: "exposed", via: "export --notarized" },
  "-exportOptionsPlist": { status: "exposed", via: "export --options" },
  "-exportPath": { status: "exposed", via: "export --output" },
  "-find-executable": { status: "exposed", via: "find" },
  "-find-library": { status: "exposed", via: "find --library" },
  "-hideShellScriptEnvironment": {
    status: "exposed",
    via: "build --hide-script-env",
  },
  "-importComponent": { status: "exposed", via: "platforms component import" },
  "-importLocalizations": { status: "exposed", via: "localize import" },
  "-importPath": {
    status: "exposed",
    via: "platforms component import --import-path",
  },
  "-importPlatform": { status: "exposed", via: "platforms import" },
  "-jobs": { status: "exposed", via: "build --jobs" },
  "-list": { status: "exposed", via: "schemes" },
  "-localizationPath": { status: "exposed", via: "localize --path" },
  "-maximum-concurrent-test-device-destinations": {
    status: "exposed",
    via: "test --max-device-destinations",
  },
  "-maximum-concurrent-test-simulator-destinations": {
    status: "exposed",
    via: "test --max-sim-destinations",
  },
  "-maximum-parallel-testing-workers": {
    status: "exposed",
    via: "test --max-workers",
  },
  "-maximum-test-execution-time-allowance": {
    status: "exposed",
    via: "test --test-timeout",
  },
  "-modelCode": {
    status: "exposed",
    via: "platforms device-support --model-code",
  },
  "-only-test-configuration": {
    status: "exposed",
    via: "test --only-configuration",
  },
  "-only-testing": { status: "exposed", via: "test --only" },
  "-onlyUsePackageVersionsFromResolvedFile": {
    status: "exposed",
    via: "packages --offline",
  },
  "-osVersion": {
    status: "exposed",
    via: "platforms device-support --os-version",
  },
  "-packageAuthorizationProvider": {
    status: "exposed",
    via: "packages --package-auth",
  },
  "-packageCachePath": { status: "exposed", via: "packages --package-cache" },
  "-packageDependencySCMToRegistryTransformation": {
    status: "exposed",
    via: "packages --scm-to-registry",
  },
  "-packageFingerprintPolicy": {
    status: "exposed",
    via: "packages --fingerprint-policy",
  },
  "-packageSigningEntityPolicy": {
    status: "exposed",
    via: "packages --signing-entity-policy",
  },
  "-parallel-testing-enabled": {
    status: "exposed",
    via: "test --parallel / --no-parallel",
  },
  "-parallel-testing-worker-count": {
    status: "exposed",
    via: "test --max-workers",
  },
  "-parallelizeTargets": {
    status: "exposed",
    via: "build --parallelize-targets",
  },
  "-platform": {
    status: "exposed",
    via: "platforms device-support --platform",
  },
  "-prepareDeviceSupport": {
    status: "exposed",
    via: "platforms device-support",
  },
  "-resolvePackageDependencies": {
    status: "exposed",
    via: "packages --resolve",
  },
  "-retry-tests-on-failure": { status: "exposed", via: "test --retry" },
  "-run-tests-until-failure": {
    status: "exposed",
    via: "test --until-failure",
  },
  "-runFirstLaunch": { status: "exposed", via: "platforms first-launch" },
  "-scheme": { status: "exposed", via: "build --scheme" },
  "-scmProvider": { status: "exposed", via: "packages --scm-provider" },
  "-sdk": { status: "exposed", via: "build --sdk" },
  "-showBuildSettings": { status: "exposed", via: "settings" },
  "-showBuildSettingsForIndex": {
    status: "exposed",
    via: "settings --for-index",
  },
  "-showBuildTimingSummary": { status: "exposed", via: "build --timing" },
  "-showComponent": { status: "exposed", via: "platforms component show" },
  "-showdestinations": { status: "exposed", via: "destinations" },
  "-showsdks": { status: "exposed", via: "info --sdks" },
  "-showTestPlans": { status: "exposed", via: "testplans" },
  "-skip-test-configuration": {
    status: "exposed",
    via: "test --skip-configuration",
  },
  "-skip-testing": { status: "exposed", via: "test --skip" },
  "-skipPackagePluginValidation": {
    status: "exposed",
    via: "build --skip-plugin-validation",
  },
  "-skipPackageSignatureValidation": {
    status: "exposed",
    via: "build --skip-signature-validation",
  },
  "-skipPackageUpdates": {
    status: "exposed",
    via: "build --skip-package-updates",
  },
  "-skipUnavailableActions": {
    status: "exposed",
    via: "build --skip-unavailable-actions",
  },
  "-target": { status: "exposed", via: "build --target" },
  "-test-iterations": { status: "exposed", via: "test --iterations" },
  "-test-repetition-relaunch-enabled": {
    status: "exposed",
    via: "test --relaunch",
  },
  "-test-timeouts-enabled": { status: "exposed", via: "test --test-timeout" },
  "-testLanguage": { status: "exposed", via: "test --language" },
  "-testPlan": { status: "exposed", via: "test --test-plan" },
  "-testProductsPath": { status: "exposed", via: "test --test-products" },
  "-testRegion": { status: "exposed", via: "test --region" },
  "-toolchain": { status: "exposed", via: "build --toolchain" },
  "-version": { status: "exposed", via: "info" },
  "-xcconfig": { status: "exposed", via: "build --xcconfig" },
  "-xctestrun": { status: "exposed", via: "test --xctestrun" },
  "-json": {
    status: "always",
    why: "every read-only query asks for JSON, then reports TOON",
  },
  "-project": {
    status: "always",
    why: "set from the .xcodeproj found in the working directory",
  },
  "-resultBundlePath": {
    status: "always",
    why: "every action writes a bundle to the tool's cache — that bundle is what the report is read from",
  },
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
  "-convert-project": {
    status: "n/a",
    why: "rewrites project files in place — an editor operation, not a build",
  },
  "-help": {
    status: "n/a",
    why: "`xcodebuild-axi --help` answers the same question in a fraction of the tokens",
  },
  "-license": {
    status: "n/a",
    why: "an interactive sudo prompt, which an AXI must never issue",
  },
  "-quiet": {
    status: "n/a",
    why: "verbosity is not a knob here: the full transcript always goes to a log and the summary always comes from the result bundle",
  },
  "-resultBundleVersion": {
    status: "n/a",
    why: "the tool owns the bundle and pins the version its reader understands",
  },
  "-resultStreamPath": {
    status: "n/a",
    why: "a live NSSecureCoding event stream has no agent-readable consumer",
  },
  "-usage": { status: "n/a", why: "same as -help" },
  "-verbose": { status: "n/a", why: "same as -quiet" },
};

/** The build actions, classified the same way. */
export const ACTION_COVERAGE: Record<string, OptionCoverage> = {
  build: { status: "exposed", via: "build" },
  "build-for-testing": { status: "exposed", via: "build --for-testing" },
  analyze: { status: "exposed", via: "analyze" },
  archive: { status: "exposed", via: "archive" },
  test: { status: "exposed", via: "test" },
  "test-without-building": {
    status: "exposed",
    via: "test --without-building",
  },
  docbuild: { status: "exposed", via: "build --docs" },
  clean: { status: "exposed", via: "clean" },
  install: { status: "exposed", via: "build --install" },
  installsrc: {
    status: "n/a",
    why: "copies sources into SRCROOT as root; a packaging step, not an agent loop",
  },
};

export interface CoverageTally {
  total: number;
  exposed: number;
  always: number;
  na: number;
  /** Reachable or handled for you — what the README quotes. */
  covered: number;
  percent: number;
}

export function tally(map: Record<string, OptionCoverage>): CoverageTally {
  const values = Object.values(map);
  const count = (status: OptionCoverage["status"]) =>
    values.filter((entry) => entry.status === status).length;

  const exposed = count("exposed");
  const always = count("always");
  const na = count("n/a");
  const covered = exposed + always;

  return {
    total: values.length,
    exposed,
    always,
    na,
    covered,
    // `n/a` options stay in the denominator on purpose. Declining to wrap
    // something is a choice this number should have to pay for.
    percent: Math.round((covered / values.length) * 1000) / 10,
  };
}
