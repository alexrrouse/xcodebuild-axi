import { AxiError } from "./errors.js";
import type { ProjectContext } from "./context.js";
import { runMetadata } from "./xcodebuild.js";
import { listSimulators } from "./simctl.js";

export interface Destination {
  platform: string;
  name: string;
  id: string;
  os: string;
  arch: string;
  /**
   * The flavour of the platform: "Mac Catalyst", "DriverKit",
   * "Designed for [iPad,iPhone]". Empty for everything else, including every
   * simulator.
   */
  variant: string;
  /**
   * xcodebuild listed it under "Ineligible destinations" (Xcode 26) or
   * "Destinations incompatible with the scheme" (Xcode 27).
   */
  eligible: boolean;
  /**
   * Why xcodebuild will not run there, in its own words — "iPhone 17 Pro’s iOS
   * Simulator 26.5 doesn’t match MyApp.app’s iOS Simulator 27.0 deployment
   * target". Only an incompatible row carries one, and it is the only place
   * the fix is named.
   */
  reason?: string;
}

/**
 * Parse one `-showdestinations` row.
 *
 * Rows look like
 *   { platform:iOS Simulator, arch:arm64, id:55D8…, OS:26.5, name:iPad (A16) }
 * Values are unquoted and can contain spaces, parentheses and commas — the
 * macOS variant really is spelled `variant:Designed for [iPad,iPhone]` — so
 * the split is driven by the next `key:` rather than by commas.
 */
export function parseDestinationLine(line: string): Destination | undefined {
  let inner = line.trim().match(/^\{(.*)\}$/)?.[1];
  if (inner === undefined) return undefined;

  // `error:` is always the last field and is prose, so it can hold anything
  // the key-driven split below would misread. Take it off whole first.
  let reason: string | undefined;
  const errorAt = inner.search(/,\s*error:/);
  if (errorAt >= 0) {
    reason = inner
      .slice(errorAt)
      .replace(/^,\s*error:/, "")
      .replace(/\s+/g, " ")
      .trim();
    inner = inner.slice(0, errorAt);
  }

  const fields: Record<string, string> = {};
  for (const match of inner.matchAll(/(\w+):(.*?)(?=,\s*\w+:|$)/g)) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) fields[key] = value.trim();
  }

  const platform = fields["platform"] ?? "";
  if (platform.length === 0) return undefined;

  return {
    platform,
    name: fields["name"] ?? "",
    id: fields["id"] ?? "",
    os: fields["OS"] ?? "",
    arch: fields["arch"] ?? "",
    variant: fields["variant"] ?? "",
    eligible: true,
    ...(reason ? { reason } : {}),
  };
}

/**
 * Placeholders ("Any iOS Device", "Any Mac") are not runnable and only add rows.
 *
 * They are spelled differently per container, which is the part that bites: a
 * project gives them an id ending in `placeholder`, and a Swift package omits
 * `id` altogether. Matching only the first let "Any Mac" and "Any DriverKit
 * Host" through on every package — and into `pickDefault`'s pool, where a
 * package with no eligible simulator could be built against a destination
 * that names no device at all. Verified against a Package.swift on Xcode 27.
 */
export function isPlaceholder(destination: Destination): boolean {
  return destination.id.length === 0 || destination.id.includes("placeholder");
}

/** Parse a whole `-showdestinations` transcript. */
export function parseDestinations(text: string): Destination[] {
  return parseDestinationAnswer(text).destinations;
}

export interface DestinationAnswer {
  /** Every concrete destination, eligible or not. */
  destinations: Destination[];
  /**
   * The platforms of the eligible placeholders — "iOS Simulator" for
   * "Any iOS Simulator Device". A build can target one with
   * `generic/platform=`, and it is often all that is left: a fresh Xcode
   * defaults new targets to its own OS, so every installed simulator can be
   * too old to run the app and still be fine to compile for.
   */
  generic: string[];
}

/**
 * Parse a `-showdestinations` transcript, keeping the placeholders apart.
 *
 * ⚠️ **The heading changed in Xcode 27.** 26 split the list into "Available
 * destinations" and "Ineligible destinations"; 27 says "Destinations
 * compatible with" and "Destinations incompatible with". Matching only the
 * old word marked every incompatible simulator eligible, so a project whose
 * deployment target was newer than every installed runtime got a simulator
 * picked for it and a failed build, with the reason truncated off the end.
 */
export function parseDestinationAnswer(text: string): DestinationAnswer {
  const destinations: Destination[] = [];
  const generic: string[] = [];
  let eligible = true;
  for (const line of text.split("\n")) {
    if (/Ineligible destinations|Destinations incompatible/i.test(line)) {
      eligible = false;
      continue;
    }
    if (/Available destinations|Destinations compatible/i.test(line)) {
      eligible = true;
      continue;
    }
    const parsed = parseDestinationLine(line);
    if (!parsed) continue;
    if (!isPlaceholder(parsed)) {
      destinations.push({ ...parsed, eligible });
    } else if (eligible && !generic.includes(parsed.platform)) {
      generic.push(parsed.platform);
    }
  }
  return { destinations, generic };
}

/**
 * Whether a `-showdestinations` answer can be trusted.
 *
 * ⚠️ **xcodebuild sometimes stops after the generic rows.** Enumerating
 * simulators and devices is a separate step from listing the scheme's
 * platforms, and when it fails — most reproducibly while another xcodebuild is
 * finishing on the same machine — the output ends after the `My Mac` /
 * `Any Mac` block with nothing saying anything went wrong. Taken at face value
 * that becomes a confident `Scheme 'X' has no destination named 'iPhone 17
 * Pro'` for a scheme that has one, which is the worst shape a wrong answer can
 * take: the caller stops looking.
 *
 * So an answer naming no simulator and no physical device is treated as
 * unfinished rather than as a scheme that supports neither. A genuinely
 * Mac-only scheme pays one extra probe on a path that was going to fail
 * anyway.
 */
export function answerLooksComplete(
  destinations: Destination[],
  exitCode: number,
): boolean {
  if (exitCode !== 0) return false;
  return destinations.some(
    (destination) => !/^(macOS|DriverKit)$/i.test(destination.platform),
  );
}

export async function listDestinations(
  project: ProjectContext,
  scheme: string,
): Promise<Destination[]> {
  return (await probeDestinations(project, scheme)).destinations;
}

async function probeDestinations(
  project: ProjectContext,
  scheme: string,
): Promise<DestinationAnswer & { complete: boolean }> {
  const probe = async (): Promise<
    DestinationAnswer & { complete: boolean }
  > => {
    const { stdout, stderr, exitCode } = await runMetadata([
      ...project.flags,
      "-scheme",
      scheme,
      "-showdestinations",
    ]);
    const answer = parseDestinationAnswer(`${stdout}\n${stderr}`);
    return {
      ...answer,
      complete: answerLooksComplete(answer.destinations, exitCode),
    };
  };

  // ⚠️ **One retry, not a loop.** The failure is transient and the probe costs
  // a few seconds; a scheme that really is Mac-only would otherwise pay for
  // every attempt on every invocation.
  const first = await probe();
  if (first.complete) return first;
  const second = await probe();
  return second.complete ? second : first;
}

/** Compare two "26.5"-style versions; newest first. */
function compareOS(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const diff = (partsB[i] ?? 0) - (partsA[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export interface ResolveDestinationOptions {
  project: ProjectContext;
  scheme: string;
  /** A simulator or device name, e.g. "iPhone 17 Pro". */
  device?: string;
  /** A full xcodebuild destination specifier, passed through untouched. */
  raw?: string;
  /**
   * Fall back to `generic/platform=` when no concrete destination is
   * eligible. Right for a command that only compiles; wrong for one that has
   * to run something, which needs a real device to run it on.
   */
  allowGeneric?: boolean;
}

/**
 * Work out what to pass `-destination`.
 *
 * Choosing a destination is the single most common thing an agent gets wrong
 * against raw xcodebuild — the specifier syntax is unguessable and a miss
 * costs a full failed invocation. So: an explicit `--destination` passes
 * through, a `--device` name is matched against what the scheme actually
 * supports, and with neither we pick the newest eligible simulator rather than
 * making the agent ask first (AXI principle 4).
 */
export async function resolveDestination(
  options: ResolveDestinationOptions,
): Promise<{ specifier: string; described: string }> {
  if (options.raw) {
    return { specifier: options.raw, described: options.raw };
  }

  const answer = await probeDestinations(options.project, options.scheme);
  const everything = answer.destinations;
  const destinations = everything.filter((destination) => destination.eligible);

  if (destinations.length === 0) {
    // Quoting My Mac's "platform doesn't match" for an iOS app, because the
    // simulators never got listed, sends the reader to the wrong fix.
    if (!answer.complete) {
      throw new AxiError(
        `xcodebuild listed no simulators or devices for scheme '${options.scheme}'`,
        "DESTINATION_NOT_FOUND",
        [
          "Enumerating them intermittently fails, most often while another xcodebuild is finishing — re-run the same command",
          `Run \`xcodebuild-axi destinations --scheme ${options.scheme} --all\` to see what xcodebuild answered`,
        ],
      );
    }
    const generic =
      options.device === undefined && options.allowGeneric
        ? pickGeneric(answer.generic)
        : undefined;
    if (generic) {
      return {
        specifier: `generic/platform=${generic}`,
        described: `Any ${generic} Device`,
      };
    }
    throw new AxiError(
      `Scheme '${options.scheme}' has no runnable destinations`,
      "DESTINATION_NOT_FOUND",
      incompatibleHelp(everything, options.scheme, options.device),
    );
  }

  if (options.device) {
    const wanted = options.device.toLowerCase();
    const match =
      destinations.find((d) => d.name.toLowerCase() === wanted) ??
      destinations.find((d) => d.id.toLowerCase() === wanted) ??
      destinations.find((d) => d.name.toLowerCase().includes(wanted));
    if (!match) {
      // ⚠️ **"Ineligible" is a different problem with a different fix.**
      // xcodebuild lists a destination it knows about but will not run
      // against — a simulator whose runtime is missing, a device that is not
      // connected — under its own heading. Reported as "no destination named
      // …" that sends the reader to check their spelling of a name that was
      // right.
      const ineligible = everything.find(
        (d) => !d.eligible && d.name.toLowerCase() === wanted,
      );
      if (ineligible) {
        throw new AxiError(
          `Scheme '${options.scheme}' lists '${options.device}' as ineligible`,
          "DESTINATION_NOT_FOUND",
          [
            ineligible.reason ??
              "xcodebuild will not run against it — a simulator runtime may be missing, or a device disconnected",
            ...runtimeHelp(ineligible.reason),
            `Run \`xcodebuild-axi destinations --scheme ${options.scheme} --all\` to see everything xcodebuild reported`,
          ],
        );
      }
      const names = [...new Set(destinations.map((d) => d.name))].slice(0, 12);
      throw new AxiError(
        `Scheme '${options.scheme}' has no destination named '${options.device}'`,
        "DESTINATION_NOT_FOUND",
        [`available: ${names.join(", ")}`],
      );
    }
    return { specifier: specifierFor(match), described: describe(match) };
  }

  // An iOS app "Designed for iPad" on this Mac is never the one meant by
  // default: it cannot install unsigned, and signing is off. When it is all
  // that is left, the simulators were not listed rather than not there — the
  // same half-finished answer as above, which once sent `tests` to the Mac.
  const runnable = destinations.filter((d) => !/designed for/i.test(d.variant));
  if (runnable.length === 0) {
    throw new AxiError(
      `xcodebuild listed no simulators for scheme '${options.scheme}', only this Mac as an iPad app`,
      "DESTINATION_NOT_FOUND",
      [
        "Enumerating simulators intermittently fails, most often while another xcodebuild is finishing — re-run the same command",
        `To run on the Mac anyway: \`--destination 'platform=macOS,variant=Designed for [iPad,iPhone]' --sign\``,
      ],
    );
  }

  // A simulator that is already booted is the one the agent is looking at —
  // its screenshots, its installed app — and skips a boot besides.
  const booted = await bootedUdids();
  const warm = runnable.filter((d) => booted.has(d.id));
  const preferred = pickDefault(warm.length > 0 ? warm : runnable);
  return { specifier: specifierFor(preferred), described: describe(preferred) };
}

/** Udids of the booted simulators; empty when simctl cannot say. */
async function bootedUdids(): Promise<Set<string>> {
  try {
    const simulators = await listSimulators();
    return new Set(
      simulators.filter((s) => s.state === "booted").map((s) => s.udid),
    );
  } catch {
    return new Set();
  }
}

/** The best generic platform to build for, simulators first. */
function pickGeneric(platforms: string[]): string | undefined {
  return [...platforms].sort(
    (a, b) =>
      Number(!a.includes("Simulator")) - Number(!b.includes("Simulator")) ||
      platformRank(a) - platformRank(b),
  )[0];
}

/**
 * Why nothing is runnable, quoted from xcodebuild.
 *
 * One reason is enough: they are the same sentence per device, and the first
 * simulator of the platform that would have been picked names the fix for
 * all of them.
 */
export function incompatibleHelp(
  everything: Destination[],
  scheme: string,
  device?: string,
): string[] {
  const candidates = everything.filter((d) => d.reason !== undefined);
  const named =
    device === undefined
      ? undefined
      : candidates.find((d) => d.name.toLowerCase() === device.toLowerCase());
  const first =
    named?.reason ??
    (candidates.length > 0 ? pickDefault(candidates).reason : undefined);
  return [
    ...(first ? [first] : []),
    ...runtimeHelp(first),
    `Run \`xcodebuild-axi destinations --scheme ${scheme} --all\` to see everything xcodebuild reported`,
  ];
}

/**
 * A deployment target newer than every installed runtime is fixed by
 * downloading one, and the command that does it is this tool's own.
 */
function runtimeHelp(reason: string | undefined): string[] {
  if (!reason || !/deployment target/i.test(reason)) return [];
  const platform = reason.match(
    /(iOS|tvOS|watchOS|visionOS|xrOS) Simulator/,
  )?.[1];
  return [
    `Run \`xcodebuild-axi platforms download ${platform ?? "iOS"}\` to install a newer simulator runtime, or lower the deployment target`,
  ];
}

/**
 * When several platforms are eligible, iOS is the one meant.
 *
 * A cross-platform Swift package reports simulators for every platform it
 * supports, and sorting those by OS version alone lands on whichever happens
 * to carry the highest number — a watchOS build for a package nobody was
 * thinking about watchOS for. Anything unlisted sorts after these.
 */
const PLATFORM_ORDER = [
  "iOS Simulator",
  "tvOS Simulator",
  "visionOS Simulator",
  "watchOS Simulator",
];

function platformRank(platform: string): number {
  const index = PLATFORM_ORDER.indexOf(platform);
  return index === -1 ? PLATFORM_ORDER.length : index;
}

/**
 * Within one platform and OS the tie would otherwise fall to whatever
 * xcodebuild listed first, which is an iPad as often as an iPhone. Xcode's own
 * default is a phone, and so is almost every agent's intent.
 */
function deviceRank(name: string): number {
  return /^iPhone/.test(name) ? 0 : 1;
}

/**
 * Prefer a simulator over hardware — a device build needs signing an agent
 * cannot supply — then iOS over the other platforms, then the newest OS, which
 * is what Xcode's own scheme selector lands on.
 */
export function pickDefault(destinations: Destination[]): Destination {
  const simulators = destinations.filter((d) =>
    d.platform.includes("Simulator"),
  );
  const pool = simulators.length > 0 ? simulators : destinations;
  const sorted = [...pool].sort(
    (a, b) =>
      platformRank(a.platform) - platformRank(b.platform) ||
      compareOS(a.os, b.os) ||
      deviceRank(a.name) - deviceRank(b.name),
  );
  const first = sorted[0];
  if (first === undefined) {
    throw new AxiError(
      "No destination to choose from",
      "DESTINATION_NOT_FOUND",
    );
  }
  return first;
}

/**
 * Address a simulator by id, not by name.
 *
 * Two runtimes routinely publish the same device name ("iPhone 17 Pro" on both
 * iOS 26.4 and 26.5), and a name-based specifier silently resolves to whichever
 * xcodebuild sees first — so a run can land on a different OS than the one
 * reported here. The udid is unambiguous.
 */
function specifierFor(destination: Destination): string {
  if (destination.id.length > 0) {
    return `platform=${destination.platform},id=${destination.id}`;
  }
  return `platform=${destination.platform},name=${destination.name}`;
}

function describe(destination: Destination): string {
  const os = destination.os.length > 0 ? ` · ${destination.os}` : "";
  return `${destination.name}${os}`;
}

/** A filesystem-safe stem for the log and result bundle of this run. */
export function destinationSlug(described: string): string {
  return described.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
