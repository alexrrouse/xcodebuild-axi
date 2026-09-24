import { AxiError } from "./errors.js";
import {
  ACTION_COVERAGE,
  OPTION_COVERAGE,
  SIMCTL_COVERAGE,
  XCCOV_COVERAGE,
  XCRESULT_COVERAGE,
  type Exposure,
  type OptionCoverage,
} from "./surface.js";

/**
 * Turning a wrong guess into the right command.
 *
 * An agent that reaches this tool with xcodebuild's vocabulary — `-scheme`,
 * `showBuildSettings`, `xcrun simctl io booted screenshot` — and is told only
 * "unknown command" concludes the tool cannot do it and drops back to raw
 * xcodebuild, which is the one outcome this tool exists to prevent. So a
 * miss answers with the command that does the job, read out of the same
 * coverage map `src/surface.ts` keeps honest, and — when the job really is
 * outside this tool — with the raw command to run instead, spelled out, so
 * falling back is a decision the agent is told about rather than one it
 * makes by guessing.
 */

/** Plain-word guesses, mapped to what they almost certainly meant. */
const VERB_ALIASES: Record<string, readonly string[]> = {
  simulator: ["sim"],
  simulators: ["sim list"],
  simctl: ["sim"],
  devices: ["sim list", "destinations"],
  device: ["destinations"],
  screenshot: ["sim screenshot"],
  video: ["sim video"],
  boot: ['sim boot "<name>"'],
  shutdown: ['sim shutdown "<name>"'],
  uninstall: ["sim uninstall"],
  terminate: ["sim terminate"],
  kill: ["sim terminate"],
  stop: ["sim terminate"],
  open: ["sim open booted <url>"],
  openurl: ["sim open booted <url>"],
  push: ["sim push"],
  install: ["sim install", "build --install"],
  scheme: ["schemes"],
  list: ["schemes"],
  targets: ["schemes", "settings --all-targets --key TARGET_NAME"],
  destination: ["destinations"],
  testplan: ["testplans"],
  "test-plans": ["testplans"],
  plans: ["testplans"],
  setting: ["settings"],
  "build-settings": ["settings"],
  buildsettings: ["settings"],
  package: ["packages"],
  resolve: ["packages --resolve"],
  spm: ["packages"],
  deps: ["packages"],
  dependencies: ["packages"],
  sdk: ["info --sdks"],
  sdks: ["info --sdks"],
  version: ["info"],
  xcode: ["info"],
  doctor: ["info"],
  status: [""],
  dashboard: [""],
  results: ["result"],
  xcresult: ["result"],
  log: ["sim logs", "result <path.xcresult> --log"],
  logs: ["sim logs", "result <path.xcresult> --log"],
  start: ["run"],
  launch: ["run", "sim launch"],
  failures: ["result <path.xcresult> --failures"],
  cov: ["coverage"],
  runtime: ["platforms"],
  runtimes: ["platforms"],
  platform: ["platforms"],
  download: ["platforms download iOS"],
  hooks: ["setup hooks"],
  init: ["setup hooks"],
  localization: ["localize"],
  localizations: ["localize"],
  xliff: ["localize"],
  l10n: ["localize"],
  ipa: ["export"],
  upload: ["export --upload"],
  notarize: ["export --notarized"],
  framework: ["xcframework"],
  which: ["find"],
  "list-tests": ["tests"],
  "test-list": ["tests"],
  analyse: ["analyze"],
  lint: ["analyze"],
  convert: ["migrate"],
};

/** Commands a raw `xcodebuild` run defaults to when it names no action. */
const DEFAULT_ACTION = "build";

/**
 * xcodebuild options that take no value. Everything else consumes the next
 * word unless that word is another option, an action, or a build setting.
 */
const NO_VALUE = new Set([
  "-list",
  "-showsdks",
  "-showBuildSettings",
  "-showBuildSettingsForIndex",
  "-showdestinations",
  "-showTestPlans",
  "-json",
  "-alltargets",
  "-quiet",
  "-verbose",
  "-version",
  "-usage",
  "-help",
  "-license",
  "-skipMacroValidation",
  "-skipPackagePluginValidation",
  "-skipPackageSignatureValidation",
  "-skipPackageUpdates",
  "-skipUnavailableActions",
  "-disableAutomaticPackageResolution",
  "-disablePackageRepositoryCache",
  "-onlyUsePackageVersionsFromResolvedFile",
  "-allowProvisioningUpdates",
  "-allowProvisioningDeviceRegistration",
  "-hideShellScriptEnvironment",
  "-parallelizeTargets",
  "-showBuildTimingSummary",
  "-resolvePackageDependencies",
  "-exportArchive",
  "-exportNotarizedApp",
  "-exportLocalizations",
  "-importLocalizations",
  "-enumerate-tests",
  "-checkFirstLaunchStatus",
  "-runFirstLaunch",
  "-downloadAllPlatforms",
  "-create-xcframework",
  "-prepareDeviceSupport",
  "-retry-tests-on-failure",
  "-run-tests-until-failure",
  "-enableCodesizeProfile",
]);

/** Options that can carry their value after a colon: `-only-testing:A/B`. */
const COLON_FORMS = new Set(["-only-testing", "-skip-testing"]);

/** Dropped without comment: this tool already does what they ask. */
const SILENT = new Set(["-json", "-quiet", "-skipMacroValidation"]);

export interface Translation {
  /** The xcodebuild-axi command line, without the binary name. */
  command: string;
  /** Things worth saying about the translation, one line each. */
  notes: string[];
  /** Options with no equivalent here. Non-empty means fall back. */
  unsupported: string[];
}

/** POSIX-quote a word only when the shell would otherwise split or expand it. */
export function shellQuote(word: string): string {
  if (/^[\w@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Quote a device name the way this tool's own help does. */
function quoteName(name: string): string {
  return /^[\w.-]+$/.test(name) ? name : `"${name.replace(/"/g, '\\"')}"`;
}

function isAction(word: string): boolean {
  return Object.hasOwn(ACTION_COVERAGE, word);
}

function isSetting(word: string): boolean {
  return /^[A-Z_][A-Z0-9_]*=/.test(word);
}

function exposures(coverage: OptionCoverage | undefined): readonly Exposure[] {
  return coverage?.status === "exposed" ? coverage.on : [];
}

/**
 * The command an option alone implies, when every way of reaching it goes
 * through one command: `-showsdks` means `info`, `-xctestrun` means `test`.
 * An option several commands share (`-scheme`, `-exportPath`) implies none.
 */
function impliedCommand(option: string): Exposure | undefined {
  const coverage = OPTION_COVERAGE[option];
  if (coverage?.status !== "exposed" || coverage.surface !== undefined) {
    return undefined;
  }
  const commands = new Set(coverage.on.map((exposure) => exposure.command));
  return commands.size === 1 ? coverage.on[0] : undefined;
}

/** The flag part of a `via`: `"test --only"` → `"--only"`. */
function flagPart(via: string): string {
  return via.split(/\s+/).slice(1).join(" ");
}

/**
 * Spell one option and its value the way `command` takes it, or undefined
 * when `command` does not take it.
 */
function spell(
  option: string,
  value: string | undefined,
  command: string,
): string | undefined {
  const exposure = exposures(OPTION_COVERAGE[option]).find(
    (entry) => entry.command === command,
  );
  if (!exposure) return undefined;
  let flag = flagPart(exposure.via);

  // `-parallel-testing-enabled YES|NO` is exposed as `--parallel / --no-parallel`.
  if (flag.includes(" / ")) {
    const [yes, no] = flag.split(" / ");
    return /^no$/i.test(value ?? "") ? no : yes;
  }
  // A placeholder in the via is where the value goes: `export <path.xcarchive>`.
  if (/<[^>]+>/.test(flag)) {
    return value === undefined
      ? flag
      : flag.replace(/<[^>]+>/, shellQuote(value));
  }
  // YES turns a switch on and NO leaves it off, which is the default.
  if (value !== undefined && /^(yes|no)$/i.test(value)) {
    return /^yes$/i.test(value) ? flag : "";
  }
  // `-enableAddressSanitizer` is `--sanitizer address`: the via carries the value.
  if (flag.includes(" ")) return flag;
  if (flag.length === 0) return "";
  if (value !== undefined) flag += ` ${shellQuote(value)}`;
  return flag;
}

/**
 * `platform=iOS Simulator,name=iPhone 17 Pro[,OS=26.5]` is a name this tool
 * resolves better — to a udid, so the run lands where it says — than the
 * specifier would.
 */
function destinationFlag(value: string): string {
  const fields = Object.fromEntries(
    value.split(",").map((pair) => {
      const at = pair.indexOf("=");
      return [
        pair.slice(0, at).trim().toLowerCase(),
        pair.slice(at + 1).trim(),
      ];
    }),
  );
  const keys = Object.keys(fields);
  if (
    fields["name"] &&
    /Simulator$/.test(fields["platform"] ?? "") &&
    keys.every((key) => ["platform", "name"].includes(key))
  ) {
    return `--device ${quoteName(fields["name"])}`;
  }
  return `--destination ${shellQuote(value)}`;
}

interface ParsedOption {
  option: string;
  value: string | undefined;
}

/** Split an xcodebuild argument list into actions, options and settings. */
function parseXcodebuild(args: string[]): {
  actions: string[];
  options: ParsedOption[];
  settings: string[];
  stray: string[];
} {
  const actions: string[] = [];
  const options: ParsedOption[] = [];
  const settings: string[] = [];
  const stray: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const word = args[i] as string;
    if (isAction(word)) {
      actions.push(word);
    } else if (isSetting(word)) {
      settings.push(word);
    } else if (word.startsWith("-")) {
      const colon = word.indexOf(":");
      const bare = colon > 0 ? word.slice(0, colon) : word;
      if (colon > 0 && COLON_FORMS.has(bare)) {
        options.push({ option: bare, value: word.slice(colon + 1) });
        continue;
      }
      const next = args[i + 1];
      const takesValue =
        !NO_VALUE.has(word) &&
        next !== undefined &&
        !next.startsWith("-") &&
        !isAction(next) &&
        !isSetting(next);
      options.push({ option: word, value: takesValue ? next : undefined });
      if (takesValue) i++;
    } else {
      stray.push(word);
    }
  }
  return { actions, options, settings, stray };
}

/**
 * Translate an xcodebuild argument list into this tool's command line.
 *
 * `forced` pins the command, for a flag that reached a real command in
 * xcodebuild's spelling — `build -scheme MyApp` is still a `build`.
 */
export function translateXcodebuild(
  args: string[],
  forced?: string,
): Translation {
  const { actions, options, settings, stray } = parseXcodebuild(args);
  const notes: string[] = [];
  const unsupported: string[] = [];

  // The command: the action word, else the one command a mode option such
  // as `-showsdks` implies, else xcodebuild's own default.
  let command: string;
  let base: string;
  if (forced !== undefined) {
    command = forced;
    base = forced;
  } else {
    const acted = actions.filter((action) => action !== "clean");
    const action = acted[acted.length - 1] ?? actions[0];
    const implied = options
      .map((entry) => impliedCommand(entry.option))
      .find((exposure) => exposure !== undefined);
    const exposure: Exposure | undefined = action
      ? exposures(ACTION_COVERAGE[action])[0]
      : implied;
    base = exposure?.via ?? DEFAULT_ACTION;
    command = base.split(/\s+/)[0] as string;
    if (actions.includes("clean") && acted.length > 0) {
      if (command === "build") base += " --clean";
      else
        notes.push(
          "Run `xcodebuild-axi clean` first — only `build` takes --clean",
        );
    }
    if (acted.length > 1) {
      notes.push(
        `xcodebuild ran ${acted.join(" then ")}; here each is its own command`,
      );
    }
  }

  const parts: string[] = [base];
  for (const { option, value } of options) {
    const coverage = OPTION_COVERAGE[option];
    if (SILENT.has(option)) continue;

    if (option === "-workspace" || option === "-project") {
      notes.push(
        `${option} is found in the working directory — cd to the one holding ${value ?? "it"} instead of passing it`,
      );
      continue;
    }
    if (option === "-resultBundlePath") {
      notes.push(
        "Every run writes its own result bundle and prints the path; --artifacts-dir <dir> picks the directory",
      );
      continue;
    }
    if (option === "-destination" && value !== undefined) {
      parts.push(destinationFlag(value));
      continue;
    }
    if (coverage?.status === "superseded") {
      notes.push(`${option} is ${coverage.why}`);
      continue;
    }

    const spelled = spell(option, value, command);
    if (spelled !== undefined) {
      if (spelled.length > 0 && !base.split(/\s+/).includes(spelled)) {
        parts.push(spelled);
      }
      continue;
    }

    // Reachable, just not from this command.
    const elsewhere = exposures(coverage)[0];
    if (elsewhere) {
      notes.push(
        `${option} belongs to \`xcodebuild-axi ${elsewhere.via}\`, not \`${command}\``,
      );
      continue;
    }
    unsupported.push(
      coverage && "why" in coverage ? `${option} (${coverage.why})` : option,
    );
  }

  for (const setting of settings)
    parts.push(`--setting ${shellQuote(setting)}`);
  for (const word of stray) unsupported.push(word);

  return { command: parts.join(" "), notes, unsupported };
}

/** The raw command line, quoted so it can be pasted into a shell. */
function raw(tool: string, args: string[]): string {
  return [tool, ...args.map(shellQuote)].join(" ");
}

/**
 * Explain a raw `xcodebuild …` line handed to this tool, and what to run
 * instead.
 */
export function xcodebuildRedirect(args: string[], word?: string): AxiError {
  const translation = translateXcodebuild(args);
  const help = [
    `Run \`xcodebuild-axi ${translation.command}\``,
    ...translation.notes,
  ];
  if (translation.unsupported.length > 0) {
    help.push(
      `Not wrapped here: ${translation.unsupported.join(", ")} — if you need it, run xcodebuild directly: \`${raw("xcodebuild", args)}\``,
    );
  }
  return new AxiError(
    word === undefined
      ? "xcodebuild-axi takes its own commands rather than xcodebuild's flags"
      : `'${word}' is xcodebuild's name for it; xcodebuild-axi spells it differently`,
    "VALIDATION_ERROR",
    help,
  );
}

/**
 * The same for a flag in xcodebuild's spelling that reached a real command:
 * `build -scheme MyApp` becomes `build --scheme MyApp`.
 */
export function xcodebuildFlagHint(
  command: string,
  args: string[],
): string[] | undefined {
  const option = args.find(
    (arg) => /^-[A-Za-z]/.test(arg) && !arg.startsWith("--"),
  );
  if (!option) return undefined;
  const bare = option.split(":")[0] as string;
  if (!Object.hasOwn(OPTION_COVERAGE, bare)) return undefined;

  // Keep this command's own flags and positionals out of the translation.
  const foreign = args.filter((_, index) => {
    const word = args[index] as string;
    const previous = args[index - 1];
    if (word.startsWith("--")) return false;
    if (previous?.startsWith("--") && !word.startsWith("-")) return false;
    return true;
  });
  const translation = translateXcodebuild(foreign, command);
  const own = args.filter((word, index) => {
    if (word.startsWith("--")) return true;
    const previous = args[index - 1];
    return previous?.startsWith("--") === true && !word.startsWith("-");
  });
  const line = [translation.command, ...own.map(shellQuote)].join(" ");
  return [
    `Flags here are spelled with two dashes: \`xcodebuild-axi ${line}\``,
    ...translation.notes,
    ...(translation.unsupported.length > 0
      ? [
          `Not wrapped here: ${translation.unsupported.join(", ")} — if you need it, run xcodebuild directly`,
        ]
      : []),
  ];
}

/** `simctl <sub> …` — the subcommand's place under `sim`, or the raw command. */
export function simctlRedirect(args: string[]): AxiError {
  const [sub, ...rest] = args;
  if (sub === undefined) {
    return new AxiError("simctl is wrapped as `sim`", "VALIDATION_ERROR", [
      "Run `xcodebuild-axi sim --help` to see what it covers",
    ]);
  }
  const coverage = SIMCTL_COVERAGE[sub];
  const exposure = simctlExposure(sub, rest);
  const logs = spawnedLog(sub, rest);
  if (logs) return logs;
  if (exposure) {
    const device = rest.find((word) => !word.startsWith("-"));
    const tail = rest
      .filter((word) => word !== device && !isIoVerb(sub, word))
      .map(shellQuote);
    return new AxiError(
      `simctl ${sub} is \`xcodebuild-axi ${exposure.via}\``,
      "VALIDATION_ERROR",
      [
        `Run \`xcodebuild-axi ${[exposure.via, ...(device ? [quoteName(device)] : []), ...tail].join(" ")}\``,
        `Run \`xcodebuild-axi ${exposure.command} --help\` for the full list`,
      ],
    );
  }
  return notWrapped(
    `simctl ${sub}`,
    coverage,
    raw("xcrun simctl", args),
    "sim",
  );
}

/**
 * `simctl spawn <device> log stream|show` is how everyone reads an app's log,
 * and `spawn` is otherwise declined — so this one use gets its own answer.
 */
function spawnedLog(sub: string, rest: string[]): AxiError | undefined {
  if (sub !== "spawn" || rest[1] !== "log") return undefined;
  const device = rest[0];
  return new AxiError(
    "Reading a simulator's log is `xcodebuild-axi sim logs`",
    "VALIDATION_ERROR",
    [
      `Run \`xcodebuild-axi sim logs${device ? ` ${quoteName(device)}` : ""} [bundle-id] --last 5m\``,
      `A live \`log stream\` blocks, so it is not wrapped — if you need one, run it directly: \`${raw("xcrun simctl", ["spawn", ...rest])}\``,
    ],
  );
}

function isIoVerb(sub: string, word: string): boolean {
  return sub === "io" && /^(screenshot|recordVideo)$/.test(word);
}

function simctlExposure(sub: string, rest: string[]): Exposure | undefined {
  const on = exposures(SIMCTL_COVERAGE[sub]);
  if (sub === "io") {
    const wantsVideo = rest.includes("recordVideo");
    return on.find((entry) =>
      entry.via.endsWith(wantsVideo ? "video" : "screenshot"),
    );
  }
  return on[0];
}

/** `sim <subcommand>` for a simctl subcommand `sim` does not take. */
export function simSubcommandRedirect(
  sub: string,
  rest: string[],
): AxiError | undefined {
  if (!Object.hasOwn(SIMCTL_COVERAGE, sub)) return undefined;
  const logs = spawnedLog(sub, rest);
  if (logs) return logs;
  const exposure = simctlExposure(sub, rest);
  if (exposure && exposure.via !== `sim ${sub}`) {
    return new AxiError(
      `sim ${sub} is spelled \`${exposure.via}\` here`,
      "VALIDATION_ERROR",
      [
        `Run \`xcodebuild-axi ${[exposure.via, ...rest.filter((word) => !isIoVerb(sub, word)).map(shellQuote)].join(" ")}\``,
      ],
    );
  }
  return notWrapped(
    `simctl ${sub}`,
    SIMCTL_COVERAGE[sub],
    raw("xcrun simctl", [sub, ...rest]),
    "sim",
  );
}

/** `xcresulttool …` or `xccov …` — which of `result` and `coverage` answers it. */
export function companionRedirect(tool: string, args: string[]): AxiError {
  const map = tool === "xccov" ? XCCOV_COVERAGE : XCRESULT_COVERAGE;
  const words = args.filter(
    (word) => !word.startsWith("-") && !word.endsWith(".xcresult"),
  );
  // Longest key that the words start with and whose flags were all passed:
  // `get test-results tests` over `get`, and `view --report` over
  // `view --report --functions-for-file` unless that flag is there.
  const key = Object.keys(map)
    .filter((candidate) => {
      const parts = candidate.split(" ");
      const named = parts.filter((part) => !part.startsWith("--"));
      const flags = parts.filter((part) => part.startsWith("--"));
      return (
        named.every((part, index) => words[index] === part) &&
        flags.every((flag) => args.includes(flag))
      );
    })
    .sort((a, b) => b.length - a.length)[0];
  const fallbackCommand = tool === "xccov" ? "coverage" : "result";
  const exposure = key ? exposures(map[key])[0] : undefined;
  if (key && !exposure) {
    return notWrapped(
      `${tool} ${key}`,
      map[key],
      raw(`xcrun ${tool}`, args),
      fallbackCommand,
    );
  }
  const via = exposure?.via ?? fallbackCommand;
  const bundle = args.find((word) => word.endsWith(".xcresult"));
  return new AxiError(
    `${tool} is wrapped as \`xcodebuild-axi ${fallbackCommand}\``,
    "VALIDATION_ERROR",
    [
      `Run \`xcodebuild-axi ${bundle ? via.replace(/^(\w+)/, `$1 ${shellQuote(bundle)}`) : via}\``,
      `Run \`xcodebuild-axi ${fallbackCommand} --help\` for the full list`,
    ],
  );
}

/** A leaf this tool declines, with the reason and the command that does it. */
function notWrapped(
  what: string,
  coverage: OptionCoverage | undefined,
  command: string,
  home: string,
): AxiError {
  const why = coverage && "why" in coverage ? ` — ${coverage.why}` : "";
  return new AxiError(
    `xcodebuild-axi does not wrap ${what}${why}`,
    "VALIDATION_ERROR",
    [
      `Run it directly: \`${command}\``,
      `Run \`xcodebuild-axi ${home} --help\` for what is wrapped`,
    ],
  );
}

/** Levenshtein distance, for "did you mean". */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j] as number;
      row[j] = Math.min(
        (row[j] as number) + 1,
        (row[j - 1] as number) + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = current;
    }
  }
  return row[b.length] as number;
}

/** The closest names within a typo's reach, best first. */
export function nearest(word: string, names: readonly string[]): string[] {
  const lower = word.toLowerCase();
  const limit = lower.length <= 4 ? 1 : 2;
  return names
    .map((name) => ({ name, cost: distance(lower, name.toLowerCase()) }))
    .filter(
      (entry) =>
        entry.cost <= limit ||
        (lower.length >= 3 && entry.name.startsWith(lower)),
    )
    .sort((a, b) => a.cost - b.cost)
    .map((entry) => entry.name);
}

/**
 * Everything the top level can say about a command it does not have.
 *
 * Returns undefined when `argv` is not a miss, so the caller hands it to the
 * SDK untouched.
 */
export function redirectArgv(
  argv: string[],
  commands: readonly string[],
): AxiError | undefined {
  const [first, ...rest] = argv;
  if (first === undefined) return undefined;
  if (commands.includes(first) || first === "update") return undefined;
  if (first === "--help" || /^(-v|-V|--version)$/.test(first)) return undefined;

  if (first === "xcrun") {
    const [tool, ...more] = rest;
    if (tool === "xcodebuild") return xcodebuildRedirect(more);
    if (tool === "simctl") return simctlRedirect(more);
    if (tool === "xcresulttool" || tool === "xccov") {
      return companionRedirect(tool, more);
    }
  }
  if (first === "xcodebuild") return xcodebuildRedirect(rest);
  if (first === "simctl") return simctlRedirect(rest);
  if (first === "xcresulttool" || first === "xccov") {
    return companionRedirect(first, rest);
  }
  if (first.startsWith("-")) return xcodebuildRedirect(argv);

  // An xcodebuild action word or option name, typed as a command:
  // `build-for-testing`, `showBuildSettings`, `list`. A word with an alias
  // means the alias first — `install` is far more often "put it on the
  // simulator" than xcodebuild's install action.
  const aliases = VERB_ALIASES[first.toLowerCase()];
  if (isAction(first) && !aliases) return xcodebuildRedirect(argv, first);
  const asOption = Object.keys(OPTION_COVERAGE).find(
    (option) => option.slice(1).toLowerCase() === first.toLowerCase(),
  );
  if (asOption && impliedCommand(asOption) && !aliases) {
    return xcodebuildRedirect([asOption, ...rest], first);
  }

  const typos = nearest(first, commands);
  const candidates = [...new Set([...(aliases ?? []), ...typos])].slice(0, 3);
  if (candidates.length > 0) {
    return new AxiError(
      `Unknown command '${first}'`,
      "VALIDATION_ERROR",
      candidates.map((candidate) =>
        candidate === ""
          ? "Run `xcodebuild-axi` with no command for the dashboard"
          : `Run \`xcodebuild-axi ${candidate}\``,
      ),
    );
  }

  return new AxiError(`Unknown command '${first}'`, "VALIDATION_ERROR", [
    `commands: ${commands.join(", ")}`,
    "Run `xcodebuild-axi --help` for what each one does",
  ]);
}
