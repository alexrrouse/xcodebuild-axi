import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "./errors.js";

/** `simctl` reads and mutations, wrapped so failures arrive structured. */

const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export interface Simulator {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  isAvailable: boolean;
}

interface RawDeviceList {
  devices?: Record<string, RawDevice[]>;
}

interface RawDevice {
  udid?: string;
  name?: string;
  state?: string;
  isAvailable?: boolean;
}

export function simctl(
  args: string[],
  /** Written to the child's stdin, for the subcommands that read it (`pbcopy`). */
  input?: string,
): Promise<{ stdout: string; exitCode: number; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
      "xcrun",
      ["simctl", ...args],
      { maxBuffer: MAX_BUFFER_BYTES, encoding: "utf-8" },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          rejectPromise(
            new AxiError(
              "xcrun is not available — Xcode is not installed or selected",
              "XCODE_NOT_INSTALLED",
            ),
          );
          return;
        }
        resolvePromise({
          stdout,
          stderr,
          exitCode:
            typeof error?.code === "number" ? error.code : error ? 1 : 0,
        });
      },
    );

    if (input !== undefined) {
      // `pbcopy` takes the pasteboard contents on stdin and nowhere else, so
      // the stream is closed rather than left open -- it copies what it reads
      // until EOF.
      child.stdin?.end(input);
    }
  });
}

/**
 * Every simulator, flattened out of simctl's runtime-keyed map.
 *
 * The raw JSON nests devices under runtime identifiers like
 * `com.apple.CoreSimulator.SimRuntime.iOS-26-5` and carries six fields per
 * device that nobody asked for — data paths, log paths, sizes. Four fields
 * and a readable runtime name is the whole useful shape.
 */
export async function listSimulators(
  options: { available?: boolean } = {},
): Promise<Simulator[]> {
  const args = ["list", "-j", "devices"];
  if (options.available !== false) args.push("available");

  const { stdout } = await simctl(args);
  let parsed: RawDeviceList;
  try {
    parsed = JSON.parse(stdout) as RawDeviceList;
  } catch {
    throw new AxiError(
      "simctl returned output that could not be read",
      "UNKNOWN",
    );
  }

  const out: Simulator[] = [];
  for (const [runtimeId, devices] of Object.entries(parsed.devices ?? {})) {
    const runtime = prettyRuntime(runtimeId);
    for (const device of devices) {
      if (device.udid === undefined || device.name === undefined) continue;
      out.push({
        udid: device.udid,
        name: device.name,
        state: (device.state ?? "unknown").toLowerCase(),
        runtime,
        isAvailable: device.isAvailable !== false,
      });
    }
  }
  return out;
}

/** `com.apple.CoreSimulator.SimRuntime.iOS-26-5` -> `iOS 26.5`. */
export function prettyRuntime(runtimeId: string): string {
  const tail = runtimeId.split(".").pop() ?? runtimeId;
  // The version part must actually look like one, so an identifier in some
  // other shape comes back untouched rather than silently mangled.
  const match = tail.match(/^([A-Za-z]+)-(\d+(?:-\d+)*)$/);
  if (!match || match[1] === undefined || match[2] === undefined) return tail;
  return `${match[1]} ${match[2].replace(/-/g, ".")}`;
}

/**
 * Find one simulator by udid or name.
 *
 * Name matching prefers a booted device, because when a name resolves to
 * several runtimes the booted one is almost always the one meant — and acting
 * on the wrong copy of "iPhone 17 Pro" is a silent wrong answer.
 */
export function findSimulator(
  simulators: Simulator[],
  query: string,
): Simulator | undefined {
  const wanted = query.toLowerCase();
  const byUdid = simulators.find(
    (simulator) => simulator.udid.toLowerCase() === wanted,
  );
  if (byUdid) return byUdid;

  const named = simulators.filter(
    (simulator) => simulator.name.toLowerCase() === wanted,
  );
  if (named.length > 0) {
    return named.find((simulator) => simulator.state === "booted") ?? named[0];
  }

  return simulators.find((simulator) =>
    simulator.name.toLowerCase().includes(wanted),
  );
}

/** One app installed on a simulator, as `listapps` describes it. */
export interface InstalledApp {
  bundleId: string;
  name: string;
  version: string;
  build: string;
  type: string;
  path: string;
}

interface RawApp {
  ApplicationType?: string;
  CFBundleDisplayName?: string;
  CFBundleName?: string;
  CFBundleShortVersionString?: string;
  CFBundleVersion?: string | number;
  Path?: string;
}

/**
 * What is installed on a simulator.
 *
 * `simctl listapps` prints an old-style NeXTSTEP plist rather than JSON --
 * `-j` is not offered here -- so it goes through `plutil` to become readable.
 * A typical device answers with 46 apps of which two are the developer's; the
 * rest are Apple's, which is why the caller filters by type.
 */
export async function listApps(udid: string): Promise<InstalledApp[]> {
  const { stdout, stderr, exitCode } = await simctl(["listapps", udid]);
  if (exitCode !== 0) {
    throw new AxiError("Could not list the apps on that simulator", "UNKNOWN", [
      stderr.trim().split("\n")[0] ?? "",
    ]);
  }

  const parsed = await plistToJson(stdout);
  return Object.entries(parsed).map(([bundleId, app]) => ({
    bundleId,
    name: app.CFBundleDisplayName ?? app.CFBundleName ?? bundleId,
    version: app.CFBundleShortVersionString ?? "",
    build: app.CFBundleVersion === undefined ? "" : String(app.CFBundleVersion),
    type: (app.ApplicationType ?? "unknown").toLowerCase(),
    path: app.Path ?? "",
  }));
}

/** Everything `listapps` reports about one app, plus what it leaves out. */
export interface AppDetail extends InstalledApp {
  /** The .app bundle, which is `path`, and the container a test writes into. */
  dataContainer: string;
  groups: string[];
  firstParty: boolean;
  removable: boolean;
  hidden: boolean;
  appClip: boolean;
}

/**
 * `simctl appinfo`, which answers for one app what `listapps` answers for all
 * of them -- and adds the data container, the App Groups and the four flags
 * that say what kind of app it is. Same old-style plist, same trip through
 * `plutil`.
 *
 * The paths come back as `file://` URLs with percent-escapes in them, which
 * no shell or editor wants; `Path` is the plain form of the bundle, and the
 * data container has to be decoded.
 */
export async function readAppInfo(
  udid: string,
  bundleId: string,
): Promise<AppDetail> {
  const { stdout, stderr, exitCode } = await simctl([
    "appinfo",
    udid,
    bundleId,
  ]);
  if (exitCode !== 0) {
    throw new AxiError(`Could not read '${bundleId}'`, "NOT_FOUND", [
      (stderr.trim().split("\n").pop() ?? "").trim(),
    ]);
  }

  const raw = (await plistToJson(stdout)) as unknown as RawAppInfo;
  return {
    bundleId: raw.CFBundleIdentifier ?? bundleId,
    name: raw.CFBundleDisplayName ?? raw.CFBundleName ?? bundleId,
    version: raw.CFBundleShortVersionString ?? "",
    build: raw.CFBundleVersion === undefined ? "" : String(raw.CFBundleVersion),
    type: (raw.ApplicationType ?? "unknown").toLowerCase(),
    path: raw.Path ?? "",
    dataContainer: fromFileUrl(raw.DataContainer),
    groups: Object.keys(raw.GroupContainers ?? {}),
    // The plist prints these as 0 and 1 and `plutil` keeps them as the
    // strings "0" and "1", so none of the three spellings can be assumed.
    firstParty: isSet(raw.IsFirstParty),
    removable: isSet(raw.IsRemovable),
    hidden: isSet(raw.IsHidden),
    appClip: isSet(raw.IsAppClip),
  };
}

interface RawAppInfo extends RawApp {
  CFBundleIdentifier?: string;
  DataContainer?: string;
  GroupContainers?: Record<string, string>;
  IsFirstParty?: number | boolean | string;
  IsRemovable?: number | boolean | string;
  IsHidden?: number | boolean | string;
  IsAppClip?: number | boolean | string;
}

function isSet(value: number | boolean | string | undefined): boolean {
  return value === true || value === 1 || value === "1";
}

/** `file:///a%20path/` as a path anyone can paste into a shell. */
export function fromFileUrl(url: string | undefined): string {
  if (url === undefined) return "";
  if (!url.startsWith("file://")) return url;
  return decodeURIComponent(url.slice("file://".length)).replace(/\/$/, "");
}

function plistToJson(text: string): Promise<Record<string, RawApp>> {
  // Through a file rather than a pipe: `plutil` reads stdin only as `-`, and
  // feeding it a multi-megabyte plist that way deadlocks against its own
  // output on some runs.
  const dir = mkdtempSync(join(tmpdir(), "axi-listapps-"));
  const file = join(dir, "apps.plist");
  writeFileSync(file, text);

  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "plutil",
      ["-convert", "json", "-o", "-", file],
      { maxBuffer: MAX_BUFFER_BYTES, encoding: "utf-8" },
      (error, stdout) => {
        if (error) {
          rejectPromise(
            new AxiError(
              "simctl described the installed apps in a format that could not be read",
              "UNKNOWN",
            ),
          );
          return;
        }
        try {
          resolvePromise(JSON.parse(stdout) as Record<string, RawApp>);
        } catch {
          rejectPromise(
            new AxiError(
              "simctl described the installed apps in a format that could not be read",
              "UNKNOWN",
            ),
          );
        }
      },
    );
  });
}

/** A device model a simulator can be created as. */
export interface DeviceType {
  identifier: string;
  name: string;
  family: string;
  minRuntime: string;
}

interface RawDeviceType {
  identifier?: string;
  name?: string;
  productFamily?: string;
  minRuntimeVersionString?: string;
}

/** Every model `sim create` will accept, which is 129 of them on Xcode 27. */
export async function listDeviceTypes(): Promise<DeviceType[]> {
  const { stdout } = await simctl(["list", "-j", "devicetypes"]);
  let parsed: { devicetypes?: RawDeviceType[] };
  try {
    parsed = JSON.parse(stdout) as { devicetypes?: RawDeviceType[] };
  } catch {
    throw new AxiError(
      "simctl returned output that could not be read",
      "UNKNOWN",
    );
  }
  return (parsed.devicetypes ?? [])
    .filter((type) => type.identifier && type.name)
    .map((type) => ({
      identifier: type.identifier ?? "",
      name: type.name ?? "",
      family: type.productFamily ?? "",
      minRuntime: type.minRuntimeVersionString ?? "",
    }));
}

/** Match a model by name or identifier, the way `findSimulator` matches one. */
export function findDeviceType(
  types: DeviceType[],
  query: string,
): DeviceType | undefined {
  const wanted = query.toLowerCase();
  return (
    types.find((type) => type.identifier.toLowerCase() === wanted) ??
    types.find((type) => type.name.toLowerCase() === wanted) ??
    types.find((type) => type.name.toLowerCase().includes(wanted))
  );
}
