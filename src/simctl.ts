import { execFile } from "node:child_process";
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
): Promise<{ stdout: string; exitCode: number; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
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
