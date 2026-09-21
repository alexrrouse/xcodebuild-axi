import { requireProject } from "../context.js";
import { requireScheme } from "../scheme.js";
import { listDestinations } from "../destination.js";
import { renderFields, renderHelp, renderList, renderOutput } from "../toon.js";
import { getFlag, hasFlag, rejectUnknownFlags } from "../args.js";

export const DESTINATIONS_HELP = `usage: xcodebuild-axi destinations [flags]
Lists the destinations a scheme can actually run on.
flags[3]:
  --scheme <name>  scheme to inspect (required only when the project has more than one)
  --all            include ineligible destinations, which xcodebuild hides the reason for
  --simulators     simulators only
examples:
  xcodebuild-axi destinations
  xcodebuild-axi destinations --scheme MyApp --simulators
`;

const FLAGS = ["--scheme", "--all", "--simulators"] as const;

export async function destinationsCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "destinations", FLAGS, ["--scheme"]);

  const project = requireProject();
  const scheme = await requireScheme(
    project,
    getFlag(args, "--scheme"),
    "destinations",
  );
  const all = hasFlag(args, "--all");
  const simulatorsOnly = hasFlag(args, "--simulators");

  let destinations = await listDestinations(project, scheme);
  if (!all) destinations = destinations.filter((d) => d.eligible);
  if (simulatorsOnly)
    destinations = destinations.filter((d) => d.platform.includes("Simulator"));

  if (destinations.length === 0) {
    return renderOutput([
      renderFields({
        destinations: `0 runnable destinations for scheme '${scheme}'`,
      }),
      renderHelp([
        "Run `xcodebuild-axi destinations --scheme " +
          scheme +
          " --all` to include ineligible ones",
        "Check that the matching simulator runtime is installed in Xcode > Settings > Components",
      ]),
    ]);
  }

  const rows = destinations.map((destination) => ({
    name: destination.name,
    platform: destination.platform.replace("Simulator", "Sim"),
    os: destination.os,
    ...(all ? { eligible: destination.eligible ? "yes" : "no" } : {}),
  }));

  return renderOutput([
    renderFields({ scheme }),
    renderList("destinations", rows),
    renderHelp([
      `Run \`xcodebuild-axi test --scheme ${scheme} --device "<name>"\` to run there`,
      `Run \`xcodebuild-axi build --scheme ${scheme}\` to use the newest simulator automatically`,
    ]),
  ]);
}
