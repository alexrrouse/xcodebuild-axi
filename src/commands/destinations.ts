import { requireProject } from "../context.js";
import { requireScheme } from "../scheme.js";
import { incompatibleHelp, listDestinations } from "../destination.js";
import type { Destination } from "../destination.js";
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

export const DESTINATIONS_FLAGS = [
  "--scheme",
  "--all",
  "--simulators",
] as const;

export async function destinationsCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "destinations", DESTINATIONS_FLAGS, ["--scheme"]);

  const project = requireProject();
  const scheme = await requireScheme(
    project,
    getFlag(args, "--scheme"),
    "destinations",
  );
  const all = hasFlag(args, "--all");
  const simulatorsOnly = hasFlag(args, "--simulators");

  const everything = await listDestinations(project, scheme);
  let destinations = everything;
  if (!all) destinations = destinations.filter((d) => d.eligible);
  if (simulatorsOnly)
    destinations = destinations.filter((d) => d.platform.includes("Simulator"));

  if (destinations.length === 0) {
    return renderOutput([
      renderFields({
        destinations: `0 runnable destinations for scheme '${scheme}'`,
      }),
      renderHelp([
        ...incompatibleHelp(everything, scheme).filter(
          (line) => !line.includes("destinations --scheme"),
        ),
        `Run \`xcodebuild-axi destinations --scheme ${scheme} --all\` to include the ineligible ones and why`,
        `\`xcodebuild-axi build --scheme ${scheme}\` still compiles, against a generic simulator`,
      ]),
    ]);
  }

  const rows = collapse(
    destinations.map((destination) => ({
      name: destination.name,
      platform: destination.platform.replace("Simulator", "Sim"),
      os: destination.os,
      ...(all ? { eligible: destination.eligible ? "yes" : "no" } : {}),
    })),
  );
  // One reason per row would repeat the same sentence seventeen times; the
  // first per platform names the fix for all of them.
  const reasons = new Map<string, string>();
  for (const destination of destinations) {
    if (destination.reason && !reasons.has(destination.platform)) {
      reasons.set(destination.platform, destination.reason);
    }
  }

  return renderOutput([
    renderFields({ scheme }),
    renderList("destinations", rows),
    ...(reasons.size > 0
      ? [
          renderList(
            "ineligible_because",
            [...reasons.values()].map((why) => ({ why })),
          ),
        ]
      : []),
    renderHelp([
      `Run \`xcodebuild-axi test --scheme ${scheme} --device "<name>"\` to run there`,
      `Run \`xcodebuild-axi build --scheme ${scheme}\` to pick one automatically (a booted simulator, else the newest)`,
      ...variantHelp(destinations),
    ]),
  ]);
}

/**
 * Collapse rows that differ only in something no flag here can select.
 *
 * xcodebuild lists macOS once per arch and once per variant, all four sharing
 * one udid — so a Mac shows up as four byte-identical rows once the arch and
 * variant are projected away. `--device` takes a name, so those were four
 * ways of typing the same thing, and the agent reading them had no way to
 * tell which one it had picked.
 *
 * Deduping on the printed row rather than on the destination is deliberate:
 * what is hidden is exactly what was not shown to begin with.
 */
export function collapse(
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The variants the collapsed rows stopped naming.
 *
 * `-destination` cannot tell them apart from a name and a udid, so they are
 * not something `--device` can reach — but `--destination` passes a specifier
 * through untouched, and that spelling is the unguessable part. One line,
 * only when there is a variant to name.
 */
export function variantHelp(destinations: Destination[]): string[] {
  const byName = new Map<string, Set<string>>();
  for (const destination of destinations) {
    if (destination.variant.length === 0) continue;
    const variants = byName.get(destination.name) ?? new Set<string>();
    variants.add(destination.variant);
    byName.set(destination.name, variants);
  }

  return [...byName].map(
    ([name, variants]) =>
      `${name} also builds as ${[...variants].join(", ")} — reach one with \`--destination 'platform=macOS,variant=${[...variants][0]}'\``,
  );
}
