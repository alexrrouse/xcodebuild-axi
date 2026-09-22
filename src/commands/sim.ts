import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AxiError } from "../errors.js";
import { resolveProject } from "../context.js";
import { requireScheme } from "../scheme.js";
import { runMetadata } from "../xcodebuild.js";
import { parseSettings } from "./settings.js";
import {
  findSimulator,
  listApps,
  listSimulators,
  simctl,
  type InstalledApp,
  type Simulator,
} from "../simctl.js";
import {
  renderFields,
  renderHelp,
  renderList,
  renderOutput,
  tildePath,
} from "../toon.js";
import { getFlag, hasFlag, positionals, rejectUnknownFlags } from "../args.js";

export const SIM_HELP = `usage: xcodebuild-axi sim [subcommand] [name|udid] [app] [flags]
Inspects and drives simulators. With no subcommand, lists the booted ones.
subcommands[9]:
  list                 every available simulator
  boot <name|udid>     boot one, or no-op if it is already booted
  shutdown <name|udid> shut one down, or no-op if it already is; --all for every booted one
  erase <name|udid>    erase one back to factory state; --all for every shut-down one
  apps <name|udid>     the apps installed on it; --system to include Apple's
  install <name|udid> [path.app]   install an app; without a path, the one
                       this project builds for that simulator
  launch <name|udid> [bundle-id]   launch it; without an id, this project's
  terminate <name|udid> [bundle-id] stop it, or no-op if it is not running
  uninstall <name|udid> [bundle-id] remove it
flags[6]:
  --runtime <name>     filter the list, e.g. "iOS 26.5"
  --booted             list only booted simulators
  --all                apply shutdown or erase to every eligible simulator
  --system             include Apple's own apps in \`apps\`
  --scheme <name>      which scheme's app to install or launch
  --relaunch           with launch: stop a running copy first
note:
  install, launch, terminate and uninstall take the app as a path or a bundle
  id, and work it out from the project in the current directory when it is
  left off — the point of them is the loop from a build to a running app, and
  a DerivedData path is not something worth typing.
examples:
  xcodebuild-axi sim
  xcodebuild-axi sim list --runtime "iOS 26.5"
  xcodebuild-axi sim boot "iPhone 17 Pro"
  xcodebuild-axi sim install "iPhone 17 Pro"
  xcodebuild-axi sim launch "iPhone 17 Pro" --relaunch
  xcodebuild-axi sim apps "iPhone 17 Pro"
`;

export const SIM_FLAGS = [
  "--runtime",
  "--booted",
  "--all",
  "--system",
  "--scheme",
  "--relaunch",
] as const;
const VALUE_FLAGS = ["--runtime", "--scheme"] as const;

export async function simCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "sim", SIM_FLAGS, VALUE_FLAGS);

  const [subcommand, target, app] = positionals(args, VALUE_FLAGS);

  switch (subcommand ?? "booted") {
    case "booted":
      return listBooted();
    case "list":
      return listAll(args);
    case "boot":
      return boot(target);
    case "shutdown":
      return shutdown(args, target);
    case "erase":
      return erase(args, target);
    case "apps":
      return apps(args, target);
    case "install":
      return install(args, target, app);
    case "launch":
      return launch(args, target, app);
    case "terminate":
      return terminate(args, target, app);
    case "uninstall":
      return uninstall(args, target, app);
    default:
      throw new AxiError(
        `Unknown sim subcommand '${subcommand}'`,
        "VALIDATION_ERROR",
        [
          "valid subcommands are list, boot, shutdown, erase, apps, install, launch, terminate, uninstall",
        ],
      );
  }
}

function toRows(simulators: Simulator[]): Record<string, unknown>[] {
  return simulators.map((simulator) => ({
    name: simulator.name,
    runtime: simulator.runtime,
    state: simulator.state,
    udid: simulator.udid,
  }));
}

/** The no-subcommand view: what is running right now, which is the thing that costs money. */
async function listBooted(): Promise<string> {
  const booted = (await listSimulators()).filter(
    (simulator) => simulator.state === "booted",
  );

  if (booted.length === 0) {
    return renderOutput([
      renderFields({ booted: "0 simulators running" }),
      renderHelp([
        'Run `xcodebuild-axi sim boot "<name>"` to start one',
        "Run `xcodebuild-axi sim list` to see what is available",
      ]),
    ]);
  }

  return renderOutput([
    renderList("booted", toRows(booted)),
    renderHelp(["Run `xcodebuild-axi sim shutdown --all` to stop them"]),
  ]);
}

async function listAll(args: string[]): Promise<string> {
  const runtime = getFlag(args, "--runtime")?.toLowerCase();
  let simulators = await listSimulators();
  if (runtime) {
    simulators = simulators.filter((simulator) =>
      simulator.runtime.toLowerCase().includes(runtime),
    );
  }
  if (hasFlag(args, "--booted")) {
    simulators = simulators.filter((simulator) => simulator.state === "booted");
  }

  if (simulators.length === 0) {
    return renderOutput([
      renderFields({
        simulators: runtime
          ? `0 simulators match runtime '${runtime}'`
          : "0 simulators available",
      }),
      renderHelp(["Install a runtime in Xcode > Settings > Components"]),
    ]);
  }

  const booted = simulators.filter(
    (simulator) => simulator.state === "booted",
  ).length;
  return renderOutput([
    renderFields({ count: simulators.length, booted }),
    renderList("simulators", toRows(simulators)),
    renderHelp(['Run `xcodebuild-axi sim boot "<name>"` to start one']),
  ]);
}

async function resolveTarget(
  target: string | undefined,
  verb: string,
): Promise<Simulator> {
  if (target === undefined) {
    throw new AxiError(
      `sim ${verb} needs a simulator name or udid`,
      "VALIDATION_ERROR",
      [
        `xcodebuild-axi sim ${verb} "iPhone 17 Pro"`,
        "Run `xcodebuild-axi sim list` to see the names",
      ],
    );
  }

  const simulators = await listSimulators();
  const found = findSimulator(simulators, target);
  if (!found) {
    const names = [
      ...new Set(simulators.map((simulator) => simulator.name)),
    ].slice(0, 12);
    throw new AxiError(
      `No simulator matching '${target}'`,
      "SIMULATOR_NOT_FOUND",
      [`available: ${names.join(", ")}`],
    );
  }
  return found;
}

// Mutations are idempotent: booting a booted simulator is the state the agent
// asked for, so it is a no-op at exit 0, not an error (AXI principle 6).
async function boot(target: string | undefined): Promise<string> {
  const simulator = await resolveTarget(target, "boot");

  if (simulator.state === "booted") {
    return renderFields({
      sim: `${simulator.name} already booted (no-op)`,
      udid: simulator.udid,
    });
  }

  const { exitCode, stderr } = await simctl(["boot", simulator.udid]);
  if (exitCode !== 0 && !/current state: Booted/i.test(stderr)) {
    throw new AxiError(`Could not boot ${simulator.name}`, "UNKNOWN", [
      firstLine(stderr),
    ]);
  }

  return renderOutput([
    renderFields({
      sim: `${simulator.name} booted`,
      runtime: simulator.runtime,
      udid: simulator.udid,
    }),
    renderHelp([
      `Run \`xcodebuild-axi test --device "${simulator.name}"\` to test on it`,
    ]),
  ]);
}

async function shutdown(
  args: string[],
  target: string | undefined,
): Promise<string> {
  if (hasFlag(args, "--all")) {
    const booted = (await listSimulators()).filter(
      (simulator) => simulator.state === "booted",
    );
    if (booted.length === 0) {
      return renderFields({ sim: "0 simulators were running (no-op)" });
    }
    await simctl(["shutdown", "all"]);
    return renderFields({
      sim: `${booted.length} shut down`,
      names: booted.map((s) => s.name),
    });
  }

  const simulator = await resolveTarget(target, "shutdown");
  if (simulator.state !== "booted") {
    return renderFields({ sim: `${simulator.name} already shut down (no-op)` });
  }

  const { exitCode, stderr } = await simctl(["shutdown", simulator.udid]);
  if (exitCode !== 0 && !/current state: Shutdown/i.test(stderr)) {
    throw new AxiError(`Could not shut down ${simulator.name}`, "UNKNOWN", [
      firstLine(stderr),
    ]);
  }
  return renderFields({ sim: `${simulator.name} shut down` });
}

async function erase(
  args: string[],
  target: string | undefined,
): Promise<string> {
  if (hasFlag(args, "--all")) {
    const { exitCode, stderr } = await simctl(["erase", "all"]);
    if (exitCode !== 0) {
      throw new AxiError("Could not erase all simulators", "UNKNOWN", [
        firstLine(stderr),
      ]);
    }
    return renderFields({ sim: "all shut-down simulators erased" });
  }

  const simulator = await resolveTarget(target, "erase");
  const { exitCode, stderr } = await simctl(["erase", simulator.udid]);
  if (exitCode !== 0) {
    // simctl refuses to erase a running device; that is a real precondition,
    // so name the command that satisfies it.
    if (/Unable to erase.*booted|current state: Booted/i.test(stderr)) {
      throw new AxiError(
        `${simulator.name} is booted, so it cannot be erased`,
        "VALIDATION_ERROR",
        [`Run \`xcodebuild-axi sim shutdown "${simulator.name}"\` first`],
      );
    }
    throw new AxiError(`Could not erase ${simulator.name}`, "UNKNOWN", [
      firstLine(stderr),
    ]);
  }
  return renderFields({ sim: `${simulator.name} erased` });
}

/** What is installed, minus the four dozen apps Apple ships. */
async function apps(
  args: string[],
  target: string | undefined,
): Promise<string> {
  const simulator = await resolveTarget(target, "apps");
  const installed = await listApps(simulator.udid);
  const wanted = hasFlag(args, "--system")
    ? installed
    : installed.filter((app) => app.type === "user");

  if (wanted.length === 0) {
    return renderOutput([
      renderFields({
        apps: `no apps installed on ${simulator.name}`,
        ...(installed.length > 0 ? { system_apps: installed.length } : {}),
      }),
      renderHelp([
        `Run \`xcodebuild-axi sim install "${simulator.name}"\` to install what this project builds`,
        ...(installed.length > 0
          ? [
              `Run \`xcodebuild-axi sim apps "${simulator.name}" --system\` to include Apple's own`,
            ]
          : []),
      ]),
    ]);
  }

  return renderOutput([
    renderFields({ sim: simulator.name, apps: wanted.length }),
    renderList("apps", wanted.map(appRow)),
  ]);
}

export function appRow(app: InstalledApp): Record<string, unknown> {
  // Version and build as one field: TOON quotes `"1.0"` and `"1"` because
  // they look like numbers, and two quoted columns cost more than the one
  // readable string they add up to.
  const version = [app.version, app.build && `(${app.build})`]
    .filter((part) => part)
    .join(" ");
  return {
    app: app.name,
    bundle_id: app.bundleId,
    version: version || "unknown",
  };
}

async function install(
  args: string[],
  target: string | undefined,
  app: string | undefined,
): Promise<string> {
  const simulator = await requireBooted(target, "install");
  const path = app
    ? resolve(app)
    : (await productOf(args, simulator, "install")).appPath;

  if (!existsSync(path)) {
    throw new AxiError(`No app bundle at ${tildePath(path)}`, "NOT_FOUND", [
      "Run `xcodebuild-axi build` first — the app has to exist before it can be installed",
    ]);
  }

  const { exitCode, stderr } = await simctl(["install", simulator.udid, path]);
  if (exitCode !== 0) {
    throw new AxiError(
      `Could not install ${tildePath(path)} on ${simulator.name}`,
      "UNKNOWN",
      [firstLine(stderr)],
    );
  }

  return renderOutput([
    renderFields({
      installed: tildePath(path),
      sim: simulator.name,
    }),
    renderHelp([
      `Run \`xcodebuild-axi sim launch "${simulator.name}"\` to start it`,
    ]),
  ]);
}

async function launch(
  args: string[],
  target: string | undefined,
  app: string | undefined,
): Promise<string> {
  const simulator = await requireBooted(target, "launch");
  const bundleId = app ?? (await productOf(args, simulator, "launch")).bundleId;

  const { stdout, stderr, exitCode } = await simctl([
    "launch",
    ...(hasFlag(args, "--relaunch") ? ["--terminate-running-process"] : []),
    simulator.udid,
    bundleId,
  ]);

  if (exitCode !== 0) {
    // The one failure worth translating: the app is simply not there yet,
    // and the command that fixes it is the one right above this in the loop.
    // simctl's own words are four lines of
    // `FBSOpenApplicationServiceErrorDomain, code=4` that never say "not
    // installed", so the test is whether the app is there rather than what
    // the message said.
    const installed = await listApps(simulator.udid);
    if (!installed.some((entry) => entry.bundleId === bundleId)) {
      throw new AxiError(
        `'${bundleId}' is not installed on ${simulator.name}`,
        "NOT_FOUND",
        [
          `Run \`xcodebuild-axi sim install "${simulator.name}"\` first`,
          `Run \`xcodebuild-axi sim apps "${simulator.name}"\` to see what is installed`,
        ],
      );
    }
    throw new AxiError(`Could not launch '${bundleId}'`, "UNKNOWN", [
      firstLine(stderr),
    ]);
  }

  // simctl answers "com.example.MyApp: 41234", and the pid is the half worth
  // keeping -- it is what `sim terminate` and a debugger both take.
  const pid = Number(stdout.trim().split(":").pop()?.trim());
  return renderOutput([
    renderFields({
      launched: bundleId,
      sim: simulator.name,
      ...(Number.isFinite(pid) ? { pid } : {}),
    }),
    renderHelp([
      `Run \`xcodebuild-axi sim terminate "${simulator.name}" ${bundleId}\` to stop it`,
    ]),
  ]);
}

async function terminate(
  args: string[],
  target: string | undefined,
  app: string | undefined,
): Promise<string> {
  const simulator = await requireBooted(target, "terminate");
  const bundleId =
    app ?? (await productOf(args, simulator, "terminate")).bundleId;

  const { exitCode, stderr } = await simctl([
    "terminate",
    simulator.udid,
    bundleId,
  ]);

  // Not running is the state the caller asked for, so it is a no-op rather
  // than a failure (AXI principle 6).
  if (exitCode !== 0) {
    if (/found nothing to terminate/i.test(stderr)) {
      return renderFields({
        sim: `'${bundleId}' was not running on ${simulator.name} (no-op)`,
      });
    }
    throw new AxiError(`Could not terminate '${bundleId}'`, "UNKNOWN", [
      firstLine(stderr),
    ]);
  }

  return renderFields({ terminated: bundleId, sim: simulator.name });
}

async function uninstall(
  args: string[],
  target: string | undefined,
  app: string | undefined,
): Promise<string> {
  const simulator = await requireBooted(target, "uninstall");
  const bundleId =
    app ?? (await productOf(args, simulator, "uninstall")).bundleId;

  const installed = await listApps(simulator.udid);
  if (!installed.some((entry) => entry.bundleId === bundleId)) {
    return renderFields({
      sim: `'${bundleId}' was not installed on ${simulator.name} (no-op)`,
    });
  }

  const { exitCode, stderr } = await simctl([
    "uninstall",
    simulator.udid,
    bundleId,
  ]);
  if (exitCode !== 0) {
    throw new AxiError(`Could not uninstall '${bundleId}'`, "UNKNOWN", [
      firstLine(stderr),
    ]);
  }
  return renderFields({ uninstalled: bundleId, sim: simulator.name });
}

/**
 * simctl talks to a running device only: every app operation against a
 * shut-down one fails with "Invalid device state", which reads like a bug in
 * the caller rather than a missing step.
 */
async function requireBooted(
  target: string | undefined,
  verb: string,
): Promise<Simulator> {
  const simulator = await resolveTarget(target, verb);
  if (simulator.state !== "booted") {
    throw new AxiError(
      `${simulator.name} is not booted, so nothing can be ${verb}ed on it`,
      "VALIDATION_ERROR",
      [`Run \`xcodebuild-axi sim boot "${simulator.name}"\` first`],
    );
  }
  return simulator;
}

/**
 * The app this project builds for this simulator.
 *
 * The alternative is making the caller paste a DerivedData path or a bundle
 * id it would have to go and look up, which is most of the friction that
 * keeps `install` and `launch` out of an agent's loop. `-showBuildSettings`
 * against the simulator's own destination answers both at once, and answers
 * them for the right platform -- `BUILT_PRODUCTS_DIR` is
 * `Debug-iphonesimulator` here and `Debug-iphoneos` without a destination.
 */
async function productOf(
  args: string[],
  simulator: Simulator,
  verb: string,
): Promise<{ appPath: string; bundleId: string }> {
  const project = resolveProject();
  if (!project) {
    throw new AxiError(
      `sim ${verb} needs an app, and there is no project here to work one out from`,
      "NO_PROJECT",
      [
        `xcodebuild-axi sim ${verb} "${simulator.name}" <${verb === "install" ? "path.app" : "bundle-id"}>`,
        "cd to the directory holding the workspace or project, then re-run",
      ],
    );
  }

  const scheme = await requireScheme(
    project,
    getFlag(args, "--scheme"),
    `sim ${verb}`,
  );

  const { stdout, exitCode, stderr } = await runMetadata([
    ...project.flags,
    "-scheme",
    scheme,
    "-destination",
    `id=${simulator.udid}`,
    "-showBuildSettings",
    "-json",
  ]);

  const settings = exitCode === 0 ? parseSettings(stdout) : {};
  const dir = settings["BUILT_PRODUCTS_DIR"];
  const product = settings["FULL_PRODUCT_NAME"];
  const bundleId = settings["PRODUCT_BUNDLE_IDENTIFIER"];

  if (!dir || !product || !bundleId) {
    throw new AxiError(
      `Could not work out which app '${scheme}' builds for ${simulator.name}`,
      "VALIDATION_ERROR",
      [
        `xcodebuild-axi sim ${verb} "${simulator.name}" <${verb === "install" ? "path.app" : "bundle-id"}>`,
        ...(exitCode !== 0 ? [firstLine(stderr)] : []),
      ],
    );
  }

  return { appPath: `${dir}/${product}`, bundleId };
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}
