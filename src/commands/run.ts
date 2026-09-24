import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  BUILD_FLAG_HELP,
  reportAction,
  resolveBuildContext,
  runAction,
  runLabel,
  SHARED_BUILD_FLAGS,
  SHARED_BUILD_VALUE_FLAGS,
  type BuildContext,
} from "../action.js";
import { hasFlag, rejectUnknownFlags } from "../args.js";
import { AxiError } from "../errors.js";
import {
  failureReason,
  findSimulator,
  listSimulators,
  simctl,
  type Simulator,
} from "../simctl.js";
import { artifactDir, runMetadata } from "../xcodebuild.js";
import { renderFields, renderHelp, renderOutput, tildePath } from "../toon.js";
import { parseAppSettings } from "./settings.js";
import { shellQuote } from "../redirect.js";

/**
 * `--target` and `--all-targets` build without a scheme, and a scheme is what
 * names the app to launch — so `run` does not take them.
 */
const TARGET_FLAGS: readonly string[] = ["--target", "--all-targets"];
const RUN_BUILD_FLAG_HELP = BUILD_FLAG_HELP.split("\n")
  .filter((line) => !TARGET_FLAGS.some((flag) => line.startsWith(`  ${flag} `)))
  .join("\n");

export const RUN_HELP = `usage: xcodebuild-axi run [flags]
Builds a scheme, installs it on a simulator, and launches it — the loop from
an edit to a running app, in one call. A Mac app is opened instead.
flags[43]:
${RUN_BUILD_FLAG_HELP}
  --no-build              install and launch the last build without building again
  --env KEY=VALUE         environment variable for the app; repeatable
  --arg <value>           launch argument for the app; repeatable
note:
  The app's stdout and stderr go to the \`console\` path in the report, so
  print() output is a file away rather than lost. Os_log output is in the
  simulator's unified log: \`xcodebuild-axi sim logs\`.
  Code signing is off, as for \`build\`. Pass --sign if the app needs its
  entitlements at runtime (keychain sharing, app groups).
exit:
  0 launched, 1 the build, install or launch failed, 2 usage error
examples:
  xcodebuild-axi run
  xcodebuild-axi run --scheme MyApp --device "iPhone 17 Pro"
  xcodebuild-axi run --scheme MyApp --env API_BASE=http://localhost:8080 --arg -UITestMode
  xcodebuild-axi run --no-build
`;

export const RUN_FLAGS = [
  ...SHARED_BUILD_FLAGS.filter((flag) => !TARGET_FLAGS.includes(flag)),
  "--no-build",
  "--env",
  "--arg",
] as const;

const RUN_VALUE_FLAGS = [...SHARED_BUILD_VALUE_FLAGS, "--env", "--arg"];

export async function runCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "run", RUN_FLAGS, RUN_VALUE_FLAGS);

  // Repeated, not comma-split: a value or a launch argument can hold a comma.
  const env = repeated(args, "--env");
  for (const pair of env) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(pair)) {
      throw new AxiError(
        `--env expects KEY=VALUE, got '${pair}'`,
        "VALIDATION_ERROR",
        ["xcodebuild-axi run --env API_BASE=http://localhost:8080"],
      );
    }
  }
  const launchArgs = repeated(args, "--arg");

  const context = await resolveBuildContext({ args, command: "run" });
  const target = await targetOf(context);

  let build: Awaited<ReturnType<typeof runAction>> | undefined;
  if (!hasFlag(args, "--no-build")) {
    build = await runAction({ context, command: "run", actions: ["build"] });
    if (build.exitCode !== 0) {
      return reportAction({
        context,
        run: build,
        key: "build",
        ok: "succeeded",
        command: "run",
      });
    }
  }

  const product = await productOf(context);
  if (!existsSync(product.appPath)) {
    throw new AxiError(`No app at ${tildePath(product.appPath)}`, "NOT_FOUND", [
      "Run `xcodebuild-axi run` without --no-build to build it first",
      `Run \`xcodebuild-axi build${context.subject.targetMode ? "" : ` --scheme ${context.scheme}`}\` to see why it is not there`,
    ]);
  }

  const launched =
    target.kind === "mac"
      ? await openMacApp(product.appPath, launchArgs)
      : await launchOnSimulator(
          target.simulator,
          product,
          env,
          launchArgs,
          join(
            artifactDir(context.project),
            `${runLabel(context, "run")}-console.log`,
          ),
        );

  const fields: Record<string, unknown> = {
    app: product.bundleId,
    ...launched.fields,
  };

  if (build) {
    return reportAction({
      context,
      run: build,
      key: "run",
      ok: "launched",
      command: "run",
      extra: fields,
      help: launched.help,
    });
  }

  return renderOutput([
    renderFields({
      run: "launched (without building)",
      scheme: context.scheme,
      ...(context.destination ? { destination: context.destination } : {}),
      ...fields,
    }),
    renderHelp(launched.help),
  ]);
}

/** Every value of a repeatable flag, untouched — no comma splitting. */
function repeated(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === name && args[i + 1] !== undefined) {
      out.push(args[i + 1] as string);
      i++;
    } else if (arg.startsWith(`${name}=`)) {
      out.push(arg.slice(name.length + 1));
    }
  }
  return out;
}

type Target = { kind: "simulator"; simulator: Simulator } | { kind: "mac" };

/**
 * Where the app will run, worked out before the build rather than after it:
 * a physical device is a dead end this tool cannot finish, and finding that
 * out after a five-minute build is five minutes wasted.
 */
async function targetOf(context: BuildContext): Promise<Target> {
  const specifier = context.destinationSpecifier ?? "";
  const fields = Object.fromEntries(
    specifier.split(",").map((pair) => {
      const at = pair.indexOf("=");
      return [
        pair.slice(0, at).trim().toLowerCase(),
        pair.slice(at + 1).trim(),
      ];
    }),
  );
  const platform = fields["platform"] ?? "";

  if (/^macOS$/i.test(platform)) {
    if (fields["variant"] && /designed for/i.test(fields["variant"])) {
      throw new AxiError(
        "run cannot launch the Designed for iPad variant on this Mac",
        "VALIDATION_ERROR",
        ["Build it with `xcodebuild-axi build`, then open it from Xcode"],
      );
    }
    return { kind: "mac" };
  }

  if (!/Simulator/i.test(platform)) {
    throw new AxiError(
      `run launches on a simulator or this Mac, and ${context.destination ?? specifier} is neither`,
      "VALIDATION_ERROR",
      [
        'Pick a simulator: `xcodebuild-axi run --device "iPhone 17 Pro"`',
        "For a physical device, build here and install with devicectl: `xcrun devicectl device install app --device <udid> <path.app>`, then `xcrun devicectl device process launch --device <udid> <bundle-id>`",
      ],
    );
  }

  const simulators = await listSimulators();
  const wanted = fields["id"] ?? fields["name"];
  const simulator = wanted ? findSimulator(simulators, wanted) : undefined;
  if (!simulator) {
    throw new AxiError(
      `No simulator matching '${wanted ?? specifier}'`,
      "SIMULATOR_NOT_FOUND",
      ["Run `xcodebuild-axi sim list` to see the names"],
    );
  }
  return { kind: "simulator", simulator };
}

/**
 * The app the scheme builds, under the same flags the build used — so a
 * `--configuration Release` run installs `Release-iphonesimulator`, not the
 * Debug copy left over from an earlier build.
 */
async function productOf(
  context: BuildContext,
): Promise<{ appPath: string; bundleId: string }> {
  const { stdout, stderr, exitCode } = await runMetadata([
    ...context.xcodebuildArgs,
    "-showBuildSettings",
    "-json",
  ]);
  const settings = exitCode === 0 ? parseAppSettings(stdout) : {};
  const dir = settings["BUILT_PRODUCTS_DIR"];
  const product = settings["FULL_PRODUCT_NAME"];
  const bundleId = settings["PRODUCT_BUNDLE_IDENTIFIER"];

  if (!dir || !product || !bundleId || !product.endsWith(".app")) {
    throw new AxiError(
      `'${context.scheme}' does not build an app, so there is nothing to launch`,
      "VALIDATION_ERROR",
      [
        ...(exitCode !== 0 ? [failureReason(stderr)] : []),
        ...(product ? [`it builds ${product}`] : []),
        "Run `xcodebuild-axi schemes` and pick the scheme that builds the app",
      ],
    );
  }
  return { appPath: `${dir}/${product}`, bundleId };
}

interface Launched {
  fields: Record<string, unknown>;
  help: string[];
}

async function launchOnSimulator(
  simulator: Simulator,
  product: { appPath: string; bundleId: string },
  env: string[],
  launchArgs: string[],
  consolePath: string,
): Promise<Launched> {
  // `bootstatus -b` boots when needed and returns once the device can take an
  // install; a bare `boot` returns while it is still coming up, and the
  // install that follows fails half the time.
  if (simulator.state !== "booted") {
    const booted = await simctl(["bootstatus", simulator.udid, "-b"]);
    if (booted.exitCode !== 0) {
      throw new AxiError(`Could not boot ${simulator.name}`, "UNKNOWN", [
        failureReason(booted.stderr || booted.stdout),
      ]);
    }
  }

  const installed = await simctl(["install", simulator.udid, product.appPath]);
  if (installed.exitCode !== 0) {
    throw new AxiError(
      `Built, but could not install on ${simulator.name}`,
      "UNKNOWN",
      [failureReason(installed.stderr)],
    );
  }

  mkdirSync(join(consolePath, ".."), { recursive: true });
  rmSync(consolePath, { force: true });
  // Xcode sets NSUnbufferedIO for the same reason: stdout redirected to a
  // file is block-buffered, and print() from an app that is still running
  // never reaches the console file at all. Verified empty without it.
  const childEnv = Object.fromEntries([
    ["SIMCTL_CHILD_NSUnbufferedIO", "YES"],
    ...env.map((pair) => {
      const at = pair.indexOf("=");
      return [`SIMCTL_CHILD_${pair.slice(0, at)}`, pair.slice(at + 1)];
    }),
  ]);
  const launched = await simctl(
    [
      "launch",
      "--terminate-running-process",
      `--stdout=${consolePath}`,
      `--stderr=${consolePath}`,
      simulator.udid,
      product.bundleId,
      ...launchArgs,
    ],
    undefined,
    childEnv,
  );
  if (launched.exitCode !== 0) {
    throw new AxiError(
      `Installed, but could not launch ${product.bundleId}`,
      "UNKNOWN",
      [failureReason(launched.stderr)],
    );
  }

  const pid = Number(launched.stdout.trim().split(":").pop()?.trim());
  const name = /^[\w.-]+$/.test(simulator.name)
    ? simulator.name
    : `"${simulator.name}"`;
  return {
    fields: {
      sim: simulator.name,
      ...(Number.isFinite(pid) ? { pid } : {}),
      console: tildePath(consolePath),
    },
    help: [
      `Run \`xcodebuild-axi sim screenshot ${name}\` to see it`,
      `Run \`xcodebuild-axi sim logs ${name} ${product.bundleId}\` for its unified log`,
      `Run \`xcodebuild-axi sim terminate ${name} ${product.bundleId}\` to stop it`,
    ],
  };
}

/** A Mac app has nothing to install; `open` is the launch. */
async function openMacApp(
  appPath: string,
  launchArgs: string[],
): Promise<Launched> {
  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(
      "open",
      [
        "-n",
        appPath,
        ...(launchArgs.length > 0 ? ["--args", ...launchArgs] : []),
      ],
      { stdio: "ignore" },
    );
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
  if (exitCode !== 0) {
    throw new AxiError(
      `Built, but could not open ${tildePath(appPath)}`,
      "UNKNOWN",
      [`Try it by hand: \`open ${shellQuote(appPath)}\``],
    );
  }
  return {
    fields: { opened: tildePath(appPath) },
    help: [],
  };
}
