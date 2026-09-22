import { AxiError } from "./errors.js";
import type { ProjectContext } from "./context.js";
import { runMetadata } from "./xcodebuild.js";

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
  /** xcodebuild listed it under "Ineligible destinations". */
  eligible: boolean;
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
  const inner = line.trim().match(/^\{(.*)\}$/)?.[1];
  if (inner === undefined) return undefined;

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
  const out: Destination[] = [];
  let eligible = true;
  for (const line of text.split("\n")) {
    if (/Ineligible destinations/i.test(line)) {
      eligible = false;
      continue;
    }
    if (/Available destinations|Destinations compatible/i.test(line)) {
      eligible = true;
      continue;
    }
    const parsed = parseDestinationLine(line);
    if (parsed && !isPlaceholder(parsed)) out.push({ ...parsed, eligible });
  }
  return out;
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
  const probe = async (): Promise<{
    destinations: Destination[];
    complete: boolean;
  }> => {
    const { stdout, stderr, exitCode } = await runMetadata([
      ...project.flags,
      "-scheme",
      scheme,
      "-showdestinations",
    ]);
    const destinations = parseDestinations(`${stdout}\n${stderr}`);
    return {
      destinations,
      complete: answerLooksComplete(destinations, exitCode),
    };
  };

  // ⚠️ **One retry, not a loop.** The failure is transient and the probe costs
  // a few seconds; a scheme that really is Mac-only would otherwise pay for
  // every attempt on every invocation.
  const first = await probe();
  if (first.complete) return first.destinations;
  const second = await probe();
  return second.complete ? second.destinations : first.destinations;
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

  const everything = await listDestinations(options.project, options.scheme);
  const destinations = everything.filter((destination) => destination.eligible);

  if (destinations.length === 0) {
    throw new AxiError(
      `Scheme '${options.scheme}' has no runnable destinations`,
      "DESTINATION_NOT_FOUND",
      [
        "Run `xcodebuild-axi destinations --scheme " +
          options.scheme +
          "` to see everything xcodebuild reported",
      ],
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
            "xcodebuild will not run against it — a simulator runtime may be missing, or a device disconnected",
            `Run \`xcodebuild-axi destinations --scheme ${options.scheme}\` to see everything xcodebuild reported`,
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

  const preferred = pickDefault(destinations);
  return { specifier: specifierFor(preferred), described: describe(preferred) };
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
