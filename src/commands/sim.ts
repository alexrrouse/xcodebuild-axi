import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AxiError } from "../errors.js";
import { resolveProject } from "../context.js";
import { requireScheme } from "../scheme.js";
import { capturePath, runMetadata } from "../xcodebuild.js";
import { parseSettings } from "./settings.js";
import {
  findDeviceType,
  findSimulator,
  listApps,
  listDeviceTypes,
  listSimulators,
  simctl,
  type DeviceType,
  type InstalledApp,
  type Simulator,
} from "../simctl.js";
import {
  byteSize,
  duration,
  renderFields,
  renderHelp,
  renderList,
  renderOutput,
  tildePath,
} from "../toon.js";
import {
  getFlag,
  getIntFlag,
  hasFlag,
  positionals,
  rejectUnknownFlags,
} from "../args.js";

export const SIM_HELP = `usage: xcodebuild-axi sim [subcommand] [name|udid] [app] [flags]
Inspects and drives simulators. With no subcommand, lists the booted ones.
subcommands[18]:
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
  create <name> <model>  create a device; --runtime picks the OS
  delete <name|udid>   delete one; --unavailable for every orphaned device
  screenshot <name|udid> [path]    save a PNG of its screen
  video <name|udid> [path]         record its screen; --seconds sets how long
  open <name|udid> <url>           open a URL on it, deep links included
  privacy <name|udid> <grant|revoke|reset> <service> [bundle-id]
                       answer a permission prompt before it appears
  push <name|udid> [bundle-id] [payload.json]
                       send a push; --message writes the payload for you
  status-bar <name|udid> [pin|clear]  freeze the status bar for a screenshot
  ui <name|udid> [light|dark|<setting> <value>]  read or set appearance,
                       contrast and content size
flags[14]:
  --runtime <name>     filter the list, e.g. "iOS 26.5"
  --booted             list only booted simulators
  --all                apply shutdown or erase to every eligible simulator
  --system             include Apple's own apps in \`apps\`
  --scheme <name>      which scheme's app to install or launch
  --relaunch           with launch: stop a running copy first
  --unavailable        with delete: every device whose runtime is gone
  --seconds <n>        with video: how long to record (default: 10)
  --yes                required to delete every simulator at once
  --message <text>     with push: the alert body to send
  --title <text>       with push: the alert title
  --time <string>      with status-bar: the clock, e.g. "9:41"
  --battery <0-100>    with status-bar: the battery level
  --bars <0-4>         with status-bar: wifi and cellular signal strength
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
  xcodebuild-axi sim screenshot "iPhone 17 Pro"
  xcodebuild-axi sim create "Test iPhone" "iPhone 17 Pro" --runtime "iOS 26.5"
  xcodebuild-axi sim open "iPhone 17 Pro" myapp://checkout
  xcodebuild-axi sim privacy "iPhone 17 Pro" grant photos
  xcodebuild-axi sim status-bar "iPhone 17 Pro" pin
  xcodebuild-axi sim ui "iPhone 17 Pro" dark
`;

export const SIM_FLAGS = [
  "--runtime",
  "--booted",
  "--all",
  "--system",
  "--scheme",
  "--relaunch",
  "--unavailable",
  "--seconds",
  "--yes",
  "--message",
  "--title",
  "--time",
  "--battery",
  "--bars",
] as const;
const VALUE_FLAGS = [
  "--runtime",
  "--scheme",
  "--seconds",
  "--message",
  "--title",
  "--time",
  "--battery",
  "--bars",
] as const;

export async function simCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "sim", SIM_FLAGS, VALUE_FLAGS);

  const [subcommand, target, app, extra] = positionals(args, VALUE_FLAGS);

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
    case "create":
      return create(args, target, app);
    case "delete":
      return remove(args, target);
    case "screenshot":
      return screenshot(target, app);
    case "video":
      return video(args, target, app);
    case "open":
      return openUrl(target, app);
    case "privacy":
      return privacy(args, target, app, extra);
    case "push":
      return push(args, target, app, extra);
    case "status-bar":
      return statusBar(args, target, app);
    case "ui":
      return ui(target, app, extra);
    default:
      throw new AxiError(
        `Unknown sim subcommand '${subcommand}'`,
        "VALIDATION_ERROR",
        [
          "valid subcommands are list, boot, shutdown, erase, apps, install, launch, terminate, uninstall, create, delete, screenshot, video, open, privacy, push, status-bar, ui",
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
 * A new device.
 *
 * The model is matched by name rather than by the
 * `com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro` identifier simctl
 * documents, because the name is what `sim list` prints and what anyone
 * actually knows.
 */
async function create(
  args: string[],
  name: string | undefined,
  model: string | undefined,
): Promise<string> {
  if (name === undefined || model === undefined) {
    throw new AxiError(
      "sim create needs a name and a model",
      "VALIDATION_ERROR",
      [
        'xcodebuild-axi sim create "Test iPhone" "iPhone 17 Pro"',
        "Run `xcodebuild-axi sim list` to see the models already created",
      ],
    );
  }

  const types = await listDeviceTypes();
  const type = findDeviceType(types, model);
  if (!type) {
    throw new AxiError(`No simulator model named '${model}'`, "NOT_FOUND", [
      `models: ${nearbyModels(types, model).join(", ")}`,
    ]);
  }

  const runtime = getFlag(args, "--runtime");
  const { stdout, stderr, exitCode } = await simctl([
    "create",
    name,
    type.identifier,
    ...(runtime ? [runtime] : []),
  ]);

  if (exitCode !== 0) {
    throw new AxiError(`Could not create '${name}'`, "UNKNOWN", [
      firstLine(stderr),
      ...(runtime
        ? ["Run `xcodebuild-axi platforms` to see the runtimes installed"]
        : []),
    ]);
  }

  const udid = stdout.trim();
  return renderOutput([
    renderFields({ created: name, model: type.name, udid }),
    renderHelp([`Run \`xcodebuild-axi sim boot "${name}"\` to start it`]),
  ]);
}

/** The models closest to what was asked for, for a refusal worth reading. */
function nearbyModels(types: DeviceType[], query: string): string[] {
  const wanted = query.toLowerCase().split(/\s+/)[0] ?? "";
  const near = types.filter((type) => type.name.toLowerCase().includes(wanted));
  return (near.length > 0 ? near : types).slice(0, 12).map((type) => type.name);
}

/**
 * Deleting is the one simulator operation that cannot be undone -- a device
 * is gigabytes of state, and recreating it is not the same device. So the
 * blanket form needs `--yes` on top of `--all`, the way `migrate` does.
 */
async function remove(
  args: string[],
  target: string | undefined,
): Promise<string> {
  if (hasFlag(args, "--unavailable")) {
    const { exitCode, stderr } = await simctl(["delete", "unavailable"]);
    if (exitCode !== 0) {
      throw new AxiError("Could not delete unavailable devices", "UNKNOWN", [
        firstLine(stderr),
      ]);
    }
    return renderFields({
      sim: "every device whose runtime is gone has been deleted",
    });
  }

  if (hasFlag(args, "--all")) {
    // Refused before anything is looked up, let alone deleted: a refusal that
    // first spends a subprocess counting what it is about to refuse to touch
    // is slower than the answer and no more useful.
    if (!hasFlag(args, "--yes")) {
      throw new AxiError(
        "--all deletes every simulator on this machine, which cannot be undone",
        "VALIDATION_ERROR",
        [
          "Pass --yes as well if that is what you meant",
          "`xcodebuild-axi sim delete --unavailable` removes only the orphaned ones",
        ],
      );
    }
    const all = await listSimulators();
    const { exitCode, stderr } = await simctl(["delete", "all"]);
    if (exitCode !== 0) {
      throw new AxiError("Could not delete the simulators", "UNKNOWN", [
        firstLine(stderr),
      ]);
    }
    return renderFields({ deleted: all.length });
  }

  const simulator = await resolveTarget(target, "delete");
  const { exitCode, stderr } = await simctl(["delete", simulator.udid]);
  if (exitCode !== 0) {
    throw new AxiError(`Could not delete ${simulator.name}`, "UNKNOWN", [
      firstLine(stderr),
    ]);
  }
  return renderFields({ deleted: simulator.name, udid: simulator.udid });
}

/** A PNG of what the screen looks like right now. */
async function screenshot(
  target: string | undefined,
  path: string | undefined,
): Promise<string> {
  const simulator = await requireBooted(target, "screenshot");
  const file = path ? resolve(path) : capturePath(simulator.name, "png");
  mkdirSync(dirname(file), { recursive: true });

  const { exitCode, stderr } = await simctl([
    "io",
    simulator.udid,
    "screenshot",
    file,
  ]);
  if (exitCode !== 0) {
    throw new AxiError(`Could not photograph ${simulator.name}`, "UNKNOWN", [
      firstLine(stderr),
    ]);
  }

  return renderFields({
    screenshot: tildePath(file),
    sim: simulator.name,
    size: byteSize(sizeOf(file)),
  });
}

/**
 * A recording of the screen, for a fixed length.
 *
 * `simctl io recordVideo` records until it is sent SIGINT, which is a
 * contract for a person at a terminal rather than for a caller: an agent has
 * no way to press Control-C halfway through its own subprocess. So the
 * duration is a flag, and the interrupt is this command's job.
 */
async function video(
  args: string[],
  target: string | undefined,
  path: string | undefined,
): Promise<string> {
  const simulator = await requireBooted(target, "video");
  const seconds = getIntFlag(args, "--seconds") ?? 10;
  if (seconds <= 0) {
    throw new AxiError(
      "--seconds has to be a positive number of seconds",
      "VALIDATION_ERROR",
      ["xcodebuild-axi sim video <name|udid> --seconds 10"],
    );
  }

  const file = path ? resolve(path) : capturePath(simulator.name, "mov");
  mkdirSync(dirname(file), { recursive: true });

  const recorded = await record(simulator.udid, file, seconds);
  if (!recorded) {
    throw new AxiError(`Could not record ${simulator.name}`, "UNKNOWN", [
      "Check that the simulator window is not minimized or asleep",
    ]);
  }

  return renderFields({
    video: tildePath(file),
    sim: simulator.name,
    duration: duration(seconds),
    size: byteSize(sizeOf(file)),
  });
}

function record(udid: string, file: string, seconds: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const child = spawn(
      "xcrun",
      ["simctl", "io", udid, "recordVideo", "--force", file],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    // simctl writes "Recording started" once the first frame is in, so the
    // clock starts there rather than at spawn -- otherwise a slow start eats
    // the seconds that were asked for.
    let started = false;
    const stop = (): void => {
      child.kill("SIGINT");
    };
    child.stderr?.on("data", (chunk: Buffer) => {
      if (started || !/Recording started/i.test(chunk.toString())) return;
      started = true;
      setTimeout(stop, seconds * 1000);
    });

    // A recording that never starts still has to end, so the wait is capped.
    const failsafe = setTimeout(stop, (seconds + 10) * 1000);
    child.on("close", () => {
      clearTimeout(failsafe);
      resolvePromise(existsSync(file) && sizeOf(file) > 0);
    });
    child.on("error", () => {
      clearTimeout(failsafe);
      resolvePromise(false);
    });
  });
}

/** Open a URL on the device, which is how a deep link gets tested. */
async function openUrl(
  target: string | undefined,
  url: string | undefined,
): Promise<string> {
  const simulator = await requireBooted(target, "open");
  if (url === undefined) {
    throw new AxiError("sim open needs a URL", "VALIDATION_ERROR", [
      `xcodebuild-axi sim open "${simulator.name}" myapp://checkout`,
    ]);
  }

  const { exitCode, stderr } = await simctl(["openurl", simulator.udid, url]);
  if (exitCode !== 0) {
    throw new AxiError(`Could not open ${url}`, "UNKNOWN", [
      firstLine(stderr),
      "A scheme no installed app claims is refused by the device, not by this tool",
    ]);
  }
  return renderFields({ opened: url, sim: simulator.name });
}

/** The services simctl will grant, revoke or reset. */
const PRIVACY_SERVICES = [
  "all",
  "calendar",
  "contacts-limited",
  "contacts",
  "location",
  "location-always",
  "photos-add",
  "photos",
  "media-library",
  "microphone",
  "motion",
  "reminders",
  "siri",
] as const;

const PRIVACY_ACTIONS = ["grant", "revoke", "reset"] as const;

/**
 * Permissions, granted ahead of a UI test rather than tapped through.
 *
 * The bundle id is optional for the same reason it is on `launch`: the
 * project in the current directory already knows it, and a permission grant
 * for the wrong app looks exactly like a test that still fails.
 */
async function privacy(
  args: string[],
  target: string | undefined,
  action: string | undefined,
  service: string | undefined,
): Promise<string> {
  const simulator = await requireBooted(target, "privacy");

  if (
    action === undefined ||
    !PRIVACY_ACTIONS.includes(action as (typeof PRIVACY_ACTIONS)[number])
  ) {
    throw new AxiError(
      action === undefined
        ? "sim privacy needs an action"
        : `'${action}' is not something that can be done to a permission`,
      "VALIDATION_ERROR",
      [`actions: ${PRIVACY_ACTIONS.join(", ")}`],
    );
  }
  if (
    service === undefined ||
    !PRIVACY_SERVICES.includes(service as (typeof PRIVACY_SERVICES)[number])
  ) {
    throw new AxiError(
      service === undefined
        ? "sim privacy needs a service"
        : `simctl has no permission called '${service}'`,
      "VALIDATION_ERROR",
      [`services: ${PRIVACY_SERVICES.join(", ")}`],
    );
  }

  // `reset` is the one action simctl takes without an app, and resetting
  // every app's permissions is a different thing from resetting one app's.
  const bundleId =
    positionals(args, VALUE_FLAGS)[4] ??
    (action === "reset"
      ? undefined
      : (await productOf(args, simulator, "privacy")).bundleId);

  const { exitCode, stderr } = await simctl([
    "privacy",
    simulator.udid,
    action,
    service,
    ...(bundleId ? [bundleId] : []),
  ]);
  if (exitCode !== 0) {
    throw new AxiError(
      `Could not ${action} ${service} on ${simulator.name}`,
      "UNKNOWN",
      [firstLine(stderr)],
    );
  }

  const past = { grant: "granted", revoke: "revoked", reset: "reset" };
  return renderFields({
    privacy: `${service} ${past[action as keyof typeof past]}`,
    ...(bundleId ? { app: bundleId } : { apps: "all" }),
    sim: simulator.name,
  });
}

/**
 * A push notification, without hand-writing an APNs payload.
 *
 * simctl takes a JSON file holding a valid `aps` dictionary, which is three
 * lines of boilerplate around the one line anyone is testing. `--message`
 * writes that file; a payload path is still accepted for the cases that need
 * the real thing.
 */
async function push(
  args: string[],
  target: string | undefined,
  first: string | undefined,
  second: string | undefined,
): Promise<string> {
  const simulator = await requireBooted(target, "push");
  const message = getFlag(args, "--message");
  const title = getFlag(args, "--title");

  // `sim push <device> [bundle-id] [payload.json]`, in either order: one of
  // the two has a path in it and the other does not, so there is nothing to
  // ask the caller to remember.
  const given = [first, second].filter((v): v is string => v !== undefined);
  const payload = given.find(isPayloadPath);
  const named = given.find((value) => value !== payload);

  if (payload === undefined && message === undefined) {
    throw new AxiError("sim push needs something to send", "VALIDATION_ERROR", [
      `xcodebuild-axi sim push "${simulator.name}" --message "Your order shipped"`,
      `xcodebuild-axi sim push "${simulator.name}" payload.json`,
    ]);
  }
  if (payload !== undefined && message !== undefined) {
    throw new AxiError(
      "A payload file and --message are two different notifications",
      "VALIDATION_ERROR",
      ["Drop one — a payload file already carries its own alert text"],
    );
  }

  const bundleId = named ?? (await productOf(args, simulator, "push")).bundleId;
  const file = payload
    ? resolve(payload)
    : writePayload(simulator.name, title, message ?? "");

  if (!existsSync(file)) {
    throw new AxiError(`No payload at ${tildePath(file)}`, "NOT_FOUND", [
      "A push payload is a JSON file with an `aps` dictionary in it",
    ]);
  }

  // simctl will happily deliver a push addressed to an app that is not
  // installed and exit 0, which looks exactly like a notification the app
  // ignored. Checking first turns that silence into a sentence.
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

  const { exitCode, stderr } = await simctl([
    "push",
    simulator.udid,
    bundleId,
    file,
  ]);
  if (exitCode !== 0) {
    throw new AxiError(`Could not send the push to '${bundleId}'`, "UNKNOWN", [
      firstLine(stderr),
      "A payload has to parse as JSON, carry an `aps` dictionary, and stay under 4096 bytes",
    ]);
  }

  return renderFields({
    pushed: bundleId,
    sim: simulator.name,
    ...(message ? { message } : { payload: tildePath(file) }),
  });
}

/** A payload is the argument with a path in it; a bundle id is the other one. */
export function isPayloadPath(value: string): boolean {
  return value.includes("/") || value.toLowerCase().endsWith(".json");
}

function writePayload(
  device: string,
  title: string | undefined,
  body: string,
): string {
  const file = capturePath(device, "json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify(
      { aps: { alert: title ? { title, body } : body, sound: "default" } },
      null,
      2,
    ),
  );
  return file;
}

/**
 * `sim ui <device> dark` rather than `sim ui <device> appearance dark`: the
 * setting is unambiguous from the value, and the short form is the one anyone
 * types. Everything else names the setting first, the way simctl does.
 */
export function uiSetting(
  setting: string,
  value: string | undefined,
): [string, string | undefined] {
  if (setting === "light" || setting === "dark") return ["appearance", setting];

  const option = UI_SETTINGS[setting];
  if (option === undefined) {
    throw new AxiError(
      `simctl has no ui setting called '${setting}'`,
      "VALIDATION_ERROR",
      [
        "settings: appearance, contrast, size",
        "`xcodebuild-axi sim ui <name|udid> dark` is shorthand for appearance",
      ],
    );
  }
  return [option, value];
}

/** The screenshot-test status bar: 9:41, full bars, full battery. */
const PINNED_STATUS_BAR = [
  "--time",
  "9:41",
  "--dataNetwork",
  "wifi",
  "--wifiMode",
  "active",
  "--wifiBars",
  "3",
  "--cellularMode",
  "active",
  "--cellularBars",
  "4",
  "--batteryState",
  "charged",
  "--batteryLevel",
  "100",
];

/**
 * A status bar that does not change between runs, which is what makes two
 * screenshots comparable. `pin` is the set everyone means: 9:41 and
 * everything full, the way Apple's own marketing shots are.
 */
async function statusBar(
  args: string[],
  target: string | undefined,
  action: string | undefined,
): Promise<string> {
  const simulator = await requireBooted(target, "status-bar");
  const overrides = statusOverrides(args);

  if (action === "clear") {
    const { exitCode, stderr } = await simctl([
      "status_bar",
      simulator.udid,
      "clear",
    ]);
    if (exitCode !== 0) {
      throw new AxiError("Could not clear the status bar", "UNKNOWN", [
        firstLine(stderr),
      ]);
    }
    return renderFields({ status_bar: "cleared", sim: simulator.name });
  }

  if (action === undefined && overrides.length === 0) {
    const { stdout } = await simctl(["status_bar", simulator.udid, "list"]);
    const set = statusRows(stdout);
    const count = Object.keys(set).length;
    return renderOutput([
      renderFields({
        status_bar: count > 0 ? `${count} overrides` : "not overridden",
        sim: simulator.name,
        ...set,
      }),
      renderHelp([
        count > 0
          ? `Run \`xcodebuild-axi sim status-bar "${simulator.name}" clear\` to hand the status bar back to the simulator`
          : `Run \`xcodebuild-axi sim status-bar "${simulator.name}" pin\` to freeze it for a screenshot`,
      ]),
    ]);
  }

  if (action !== undefined && action !== "pin") {
    throw new AxiError(
      `'${action}' is not something sim status-bar does`,
      "VALIDATION_ERROR",
      ["pin freezes it, clear undoes that, and no argument reports it"],
    );
  }

  const applied =
    action === "pin" ? [...PINNED_STATUS_BAR, ...overrides] : overrides;
  const { exitCode, stderr } = await simctl([
    "status_bar",
    simulator.udid,
    "override",
    ...applied,
  ]);
  if (exitCode !== 0) {
    throw new AxiError("Could not override the status bar", "UNKNOWN", [
      firstLine(stderr),
    ]);
  }

  return renderOutput([
    renderFields({
      status_bar: action === "pin" ? "pinned" : "overridden",
      sim: simulator.name,
    }),
    renderHelp(
      action === "pin"
        ? [
            "9:41 with full signal and a full battery, so two screenshots differ only where the app does",
          ]
        : [],
    ),
  ]);
}

/**
 * simctl reports its overrides as integers — `Battery State: 2` — and prints
 * the words only in its own `--help`. Verified against every value simctl
 * accepts, so the report reads back in the vocabulary the flags are written
 * in rather than in enum ordinals.
 */
const STATUS_WORDS: Record<string, Record<string, string>> = {
  data_network: {
    "0": "wifi",
    "6": "3g",
    "7": "4g",
    "8": "lte",
    "9": "lte-a",
    "10": "lte+",
    "11": "5g",
    "12": "5g+",
    "13": "5g-uwb",
    "14": "5g-uc",
  },
  wifi_mode: {
    "0": "not-supported",
    "1": "searching",
    "2": "failed",
    "3": "active",
  },
  cell_mode: {
    "0": "not-supported",
    "1": "searching",
    "2": "failed",
    "3": "active",
  },
  battery_state: { "0": "discharging", "1": "charging", "2": "charged" },
};

/**
 * simctl reports its overrides as prose — one line per group, several
 * `Key: Value` pairs to a line. Flattening them into fields is what makes the
 * answer readable next to the flags that set them.
 */
export function statusRows(stdout: string): Record<string, string | number> {
  const rows: Record<string, string | number> = {};
  for (const line of stdout.split("\n")) {
    if (!line.includes(":") || line.trimStart().startsWith("Current")) continue;
    for (const pair of line.split(",")) {
      const [name, ...rest] = pair.split(":");
      const value = rest.join(":").trim();
      if (name === undefined || value === "") continue;
      const key = name
        .trim()
        .replace(/([a-z])([A-Z])/g, "$1_$2")
        .replace(/ /g, "_")
        .toLowerCase()
        .replace("wi_fi", "wifi")
        .replace("data_network_type", "data_network");
      const word = STATUS_WORDS[key]?.[value];
      // Numbers stay numbers: TOON quotes a numeric-looking string, and the
      // quotes cost more than the digits.
      rows[key] = word ?? (/^\d+$/.test(value) ? Number(value) : value);
    }
  }
  return rows;
}

/** The individual overrides, for the cases `pin` does not cover. */
export function statusOverrides(args: string[]): string[] {
  const time = getFlag(args, "--time");
  const battery = getIntFlag(args, "--battery");
  const bars = getIntFlag(args, "--bars");

  if (battery !== undefined && (battery < 0 || battery > 100)) {
    throw new AxiError(
      "A battery level is a percentage from 0 to 100",
      "VALIDATION_ERROR",
      ["xcodebuild-axi sim status-bar <name|udid> --battery 100"],
    );
  }
  if (bars !== undefined && (bars < 0 || bars > 4)) {
    throw new AxiError(
      "Signal strength runs from 0 to 4 bars",
      "VALIDATION_ERROR",
      [
        "wifi tops out at 3 bars and cellular at 4, which is simctl's own range",
      ],
    );
  }

  return [
    ...(time ? ["--time", time] : []),
    ...(battery !== undefined
      ? ["--batteryState", "charged", "--batteryLevel", String(battery)]
      : []),
    ...(bars !== undefined
      ? [
          "--wifiMode",
          "active",
          "--wifiBars",
          String(Math.min(bars, 3)),
          "--cellularMode",
          "active",
          "--cellularBars",
          String(bars),
        ]
      : []),
  ];
}

/** simctl's own names for the three settings `ui` reads and writes. */
const UI_SETTINGS: Record<string, string> = {
  appearance: "appearance",
  contrast: "increase_contrast",
  increase_contrast: "increase_contrast",
  size: "content_size",
  content_size: "content_size",
};

/**
 * Appearance, contrast and content size — the three things a screenshot test
 * varies. `sim ui <device> dark` is the shorthand for the one that is asked
 * for ten times as often as the others.
 */
async function ui(
  target: string | undefined,
  setting: string | undefined,
  value: string | undefined,
): Promise<string> {
  const simulator = await requireBooted(target, "ui");

  if (setting === undefined) {
    const read = async (option: string): Promise<string> =>
      (await simctl(["ui", simulator.udid, option])).stdout.trim();
    return renderFields({
      sim: simulator.name,
      appearance: await read("appearance"),
      contrast: await read("increase_contrast"),
      content_size: await read("content_size"),
    });
  }

  const [option, wanted] = uiSetting(setting, value);

  const { stdout, stderr, exitCode } = await simctl([
    "ui",
    simulator.udid,
    option,
    ...(wanted ? [wanted] : []),
  ]);
  if (exitCode !== 0) {
    throw new AxiError(`Could not set ${option}`, "VALIDATION_ERROR", [
      firstLine(stderr),
    ]);
  }

  return renderFields({
    sim: simulator.name,
    [option]: wanted ?? stdout.trim(),
  });
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
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
