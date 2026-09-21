import { AxiError } from "../errors.js";
import {
  findSimulator,
  listSimulators,
  simctl,
  type Simulator,
} from "../simctl.js";
import { renderFields, renderHelp, renderList, renderOutput } from "../toon.js";
import { getFlag, hasFlag, positionals, rejectUnknownFlags } from "../args.js";

export const SIM_HELP = `usage: xcodebuild-axi sim [list|boot|shutdown|erase] [name|udid] [flags]
Inspects and drives simulators. With no subcommand, lists the booted ones.
subcommands[4]:
  list                 every available simulator
  boot <name|udid>     boot one, or no-op if it is already booted
  shutdown <name|udid> shut one down, or no-op if it already is; --all for every booted one
  erase <name|udid>    erase one back to factory state; --all for every shut-down one
flags[3]:
  --runtime <name>     filter the list, e.g. "iOS 26.5"
  --booted             list only booted simulators
  --all                apply shutdown or erase to every eligible simulator
examples:
  xcodebuild-axi sim
  xcodebuild-axi sim list --runtime "iOS 26.5"
  xcodebuild-axi sim boot "iPhone 17 Pro"
  xcodebuild-axi sim shutdown --all
`;

const FLAGS = ["--runtime", "--booted", "--all"] as const;

export async function simCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "sim", FLAGS, ["--runtime"]);

  const [subcommand, target] = positionals(args, ["--runtime"]);

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
    default:
      throw new AxiError(
        `Unknown sim subcommand '${subcommand}'`,
        "VALIDATION_ERROR",
        ["valid subcommands are list, boot, shutdown, erase"],
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

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}
