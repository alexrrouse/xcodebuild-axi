import { spawnSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { AxiError, DeviceBusyError } from "./errors.js";
import { getFlag, getIntFlag, hasFlag } from "./args.js";
import { duration, renderFields, tildePath } from "./toon.js";
import { VERSION } from "./version.js";

/**
 * One run per simulator.
 *
 * XCUITest installs the app and its runner onto the device, so two runs on
 * one simulator overwrite each other's installs and the loser reports the
 * winner's results -- as an app crash, with nothing saying a collision
 * happened. `test` and `run` therefore hold an advisory lock on the device's
 * udid while they use it, and `sim` refuses to reinstall or reboot a device
 * someone else holds.
 *
 * The lock is a file, so a process that is not this tool can honour it too:
 * the device is busy while `<dir>/<UDID>.json` exists and its `pid` is alive.
 * A raw xcodebuild that never took it is found by scanning `ps` for a test
 * action naming the same udid.
 */

export interface LockRecord {
  version: 1;
  udid: string;
  device: string;
  pid: number;
  /** `ps -o lstart=` of the holder, so a reused pid is not mistaken for it. */
  pid_started?: string;
  command: string;
  scheme?: string;
  project?: string;
  started: string;
  tool: string;
}

/** Who has the device, in the shape the refusal reports. */
export interface Holder {
  pid: number;
  command: string;
  scheme?: string;
  project?: string;
  heldSeconds?: number;
  /** The lock file, when the holder took one. A raw xcodebuild did not. */
  lock?: string;
}

export interface LockDeps {
  dir: string;
  pid: number;
  now(): number;
  /** `ps -o lstart=` for a pid, or undefined when it is not running. */
  processStart(pid: number): string | undefined;
  /** `ps -axww -o pid=,ppid=,etime=,command=`. */
  psList(): string;
  sleep(ms: number): Promise<void>;
  /** Where `--wait` says what it is waiting for. */
  progress: NodeJS.WritableStream;
}

export function deviceLockDir(): string {
  return join(homedir(), "Library", "Caches", "xcodebuild-axi", "device-locks");
}

export function defaultDeps(): LockDeps {
  return {
    dir: deviceLockDir(),
    pid: process.pid,
    now: () => Date.now(),
    processStart(pid) {
      const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf-8",
      });
      const started = out.status === 0 ? out.stdout.trim() : "";
      return started.length > 0 ? started : undefined;
    },
    psList() {
      const out = spawnSync(
        "ps",
        ["-axww", "-o", "pid=,ppid=,etime=,command="],
        { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
      );
      return out.status === 0 ? out.stdout : "";
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    progress: process.stderr,
  };
}

/**
 * The udid a destination specifier locks, or undefined when it locks nothing.
 *
 * Only a concrete device: a generic placeholder runs nothing, and a Mac is
 * one shared machine on which package unit tests would queue for no reason.
 * A specifier naming a device only by `name=` is not locked -- two runtimes
 * routinely publish the same name, so which udid it lands on is xcodebuild's
 * guess, not ours. The udid also becomes a filename, so anything that could
 * climb out of the lock directory is refused.
 */
export function lockKey(specifier: string | undefined): string | undefined {
  if (specifier === undefined || specifier.startsWith("generic/")) {
    return undefined;
  }
  const platform = /(?:^|,)\s*platform=([^,]+)/.exec(specifier)?.[1] ?? "";
  if (/macOS|DriverKit/i.test(platform)) return undefined;
  const id = /(?:^|,)\s*id=([^,]+)/.exec(specifier)?.[1]?.trim();
  if (!id || !/^[A-Za-z0-9-]+$/.test(id)) return undefined;
  return id.toUpperCase();
}

export function lockPath(dir: string, udid: string): string {
  return join(dir, `${udid}.json`);
}

/**
 * Devices this process's parent holds. `test` exports it before spawning
 * xcodebuild, so an xcodebuild-axi run from a scheme's pre-action sees the
 * device is its own run's rather than refusing it.
 */
const INHERITED_ENV = "XCODEBUILD_AXI_HELD_DEVICES";

function inherited(): string[] {
  return (process.env[INHERITED_ENV] ?? "")
    .split(",")
    .map((udid) => udid.trim().toUpperCase())
    .filter((udid) => udid.length > 0);
}

/** Held by the run this process was started from, so ours to use. */
function heldByParent(udid: string): boolean {
  return inherited().includes(udid);
}

/** An unparseable lock this young is a holder mid-write, not a stale file. */
const UNREADABLE_GRACE_MS = 10_000;

type Read =
  | { kind: "missing" }
  | { kind: "record"; record: LockRecord }
  | { kind: "unreadable"; ageMs: number };

function readLock(path: string, deps: LockDeps): Read {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    // Unreadable (a directory, or another user's file): judged by its age
    // like a half-written one, so one bad entry cannot stop every run.
    text = "";
  }
  try {
    const parsed = JSON.parse(text) as Partial<LockRecord>;
    if (typeof parsed.pid === "number" && parsed.pid > 0) {
      return { kind: "record", record: parsed as LockRecord };
    }
  } catch {
    // fall through
  }
  try {
    return { kind: "unreadable", ageMs: deps.now() - statSync(path).mtimeMs };
  } catch {
    return { kind: "missing" };
  }
}

/**
 * Whether the process that wrote a lock still holds it.
 *
 * `ps -o lstart=` answers both halves at once: nothing for a dead pid, and a
 * start time that differs from the recorded one for a pid the OS has since
 * handed to something else -- including after a reboot. A record written by
 * another tool with only a `pid` is trusted for as long as that pid runs.
 */
export function holderAlive(record: LockRecord, deps: LockDeps): boolean {
  const started = deps.processStart(record.pid);
  if (started === undefined) return false;
  return record.pid_started === undefined || record.pid_started === started;
}

/**
 * Who holds the lock read from `path`, or undefined when nobody does: a dead
 * or reused pid, or a file too old to be a holder still writing it.
 */
function liveHolder(
  read: Read,
  path: string,
  deps: LockDeps,
): Holder | undefined {
  if (read.kind === "record") {
    return holderAlive(read.record, deps)
      ? holderOf(read.record, path, deps)
      : undefined;
  }
  if (read.kind === "unreadable" && read.ageMs < UNREADABLE_GRACE_MS) {
    return { pid: 0, command: "unknown", lock: path };
  }
  return undefined;
}

function holderOf(record: LockRecord, path: string, deps: LockDeps): Holder {
  const since = Date.parse(record.started);
  return {
    pid: record.pid,
    command: record.command ?? "unknown",
    ...(record.scheme ? { scheme: record.scheme } : {}),
    ...(record.project ? { project: record.project } : {}),
    ...(Number.isFinite(since)
      ? { heldSeconds: Math.max(0, (deps.now() - since) / 1000) }
      : {}),
    lock: path,
  };
}

export interface LockMeta {
  device: string;
  command: string;
  scheme?: string;
  project?: string;
}

export type Attempt = { release: () => void } | { holder: Holder };

/**
 * Take the lock if it is free or its holder is gone.
 *
 * The record is written in full to a private file and then hard-linked into
 * place: `link` fails if the name exists, so exactly one of two racing
 * acquirers wins, and a reader never sees a half-written lock.
 *
 * A stale lock is renamed aside before it is removed, and put back if what
 * was renamed is not what was judged stale -- a live holder that slipped in
 * between the read and the rename keeps its lock.
 */
export function tryAcquire(
  deps: LockDeps,
  udid: string,
  meta: LockMeta,
): Attempt {
  if (heldByParent(udid)) return { release: () => {} };

  mkdirSync(deps.dir, { recursive: true });
  const path = lockPath(deps.dir, udid);
  const ownStart = deps.processStart(deps.pid);
  const own: LockRecord = {
    version: 1,
    udid,
    device: meta.device,
    pid: deps.pid,
    ...(ownStart !== undefined ? { pid_started: ownStart } : {}),
    command: meta.command,
    ...(meta.scheme ? { scheme: meta.scheme } : {}),
    ...(meta.project ? { project: meta.project } : {}),
    started: new Date(deps.now()).toISOString(),
    tool: `xcodebuild-axi ${VERSION}`,
  };
  const temp = `${path}.${deps.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(own)}\n`);

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        linkSync(temp, path);
        return { release: releaser(path, own) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      const current = readLock(path, deps);
      if (current.kind === "missing") continue;
      const holder = liveHolder(current, path, deps);
      if (holder) return { holder };

      const grave = `${path}.stale.${deps.pid}`;
      try {
        renameSync(path, grave);
      } catch {
        continue;
      }
      const buried = readLock(grave, deps);
      const same =
        current.kind === "record"
          ? buried.kind === "record" &&
            buried.record.pid === current.record.pid &&
            buried.record.started === current.record.started
          : buried.kind === "unreadable";
      if (same) {
        bury(grave);
        continue;
      }
      try {
        linkSync(grave, path);
      } catch {
        // Someone else already holds it again; theirs stands.
      }
      bury(grave);
      if (buried.kind === "record") {
        return { holder: holderOf(buried.record, path, deps) };
      }
    }
    const last = readLock(path, deps);
    return {
      holder:
        last.kind === "record"
          ? holderOf(last.record, path, deps)
          : { pid: 0, command: "unknown", lock: path },
    };
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // already gone
    }
  }
}

/** Remove a stale lock set aside, whatever it turned out to be. */
function bury(grave: string): void {
  rmSync(grave, { recursive: true, force: true });
}

/**
 * Remove the lock on completion, and on exit if the run never got there.
 *
 * Only if it is still ours: a lock that was judged stale and taken over by
 * another run belongs to that run now. No signal handlers -- a killed run
 * leaves a file whose pid is dead, which the next caller reclaims at once.
 */
function releaser(path: string, own: LockRecord): () => void {
  let done = false;
  const release = () => {
    if (done) return;
    done = true;
    process.removeListener("exit", release);
    try {
      const current = JSON.parse(readFileSync(path, "utf-8")) as LockRecord;
      if (current.pid === own.pid && current.started === own.started) {
        unlinkSync(path);
      }
    } catch {
      // gone, or not ours
    }
  };
  process.once("exit", release);
  return release;
}

/**
 * Every udid whose lock is held by a live process, other than the ones this
 * process's parent run holds -- a scheme pre-action's run belongs on those.
 */
export function heldUdids(deps: LockDeps): Set<string> {
  const held = new Set<string>();
  let entries: string[];
  try {
    entries = readdirSync(deps.dir);
  } catch {
    return held;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const udid = basename(entry, ".json").toUpperCase();
    if (heldByParent(udid)) continue;
    const path = join(deps.dir, entry);
    if (liveHolder(readLock(path, deps), path, deps)) held.add(udid);
  }
  return held;
}

interface PsRow {
  pid: number;
  ppid: number;
  seconds: number;
  command: string;
}

/** `ps` elapsed time: `[[dd-]hh:]mm:ss`. */
export function parseEtime(etime: string): number {
  const [days, clock] = etime.includes("-")
    ? (etime.split("-") as [string, string])
    : ["0", etime];
  const parts = clock.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [hours, minutes, seconds] = parts as [number, number, number];
  return Number(days) * 86400 + hours * 3600 + minutes * 60 + seconds;
}

export function parsePs(text: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      seconds: parseEtime(match[3] as string),
      command: match[4] as string,
    });
  }
  return rows;
}

/**
 * xcodebuild processes testing on `udid` that are not this run.
 *
 * Only a test action naming the udid: a build against the same destination
 * installs nothing, `-enumerate-tests` (what `tests` runs) stops before
 * installing, and a `name=` specifier cannot be pinned to one device.
 * Our own descendants are this run's xcodebuild. `/usr/bin/xcodebuild` is a
 * shim that execs the real binary as its child, so a pair is one contender,
 * reported as the outer process.
 */
export function findContenders(
  rows: PsRow[],
  udid: string,
  selfPid: number,
): Holder[] {
  const ours = new Set([selfPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (!ours.has(row.pid) && ours.has(row.ppid)) {
        ours.add(row.pid);
        grew = true;
      }
    }
  }

  const id = udid.toLowerCase();
  const candidates = rows.filter((row) => {
    if (ours.has(row.pid)) return false;
    const argv0 = row.command.split(/\s+/)[0] ?? "";
    if (basename(argv0) !== "xcodebuild") return false;
    const lower = row.command.toLowerCase();
    const at = lower.indexOf(`id=${id}`);
    if (at < 0) return false;
    const after = lower[at + 3 + id.length];
    if (after !== undefined && !/[,\s"']/.test(after)) return false;
    if (/\s-enumerate-tests(?:\s|$)/.test(row.command)) return false;
    return /(?:^|\s)(?:test|test-without-building)(?:\s|$)/.test(row.command);
  });
  const pids = new Set(candidates.map((row) => row.pid));

  return candidates
    .filter((row) => !pids.has(row.ppid))
    .map((row) => {
      const scheme = /\s-scheme\s+("[^"]+"|\S+)/.exec(row.command)?.[1];
      return {
        pid: row.pid,
        command: "xcodebuild test (not through xcodebuild-axi)",
        ...(scheme ? { scheme: scheme.replace(/^"|"$/g, "") } : {}),
        heldSeconds: row.seconds,
      };
    });
}

export interface DeviceLockOptions {
  /** `--no-device-lock`: neither check nor take the lock. */
  skip: boolean;
  /** `--wait <secs>`: how long to wait for a busy device before refusing. */
  waitSeconds?: number;
}

export const DEVICE_LOCK_FLAGS = ["--wait", "--no-device-lock"] as const;
export const DEVICE_LOCK_VALUE_FLAGS = ["--wait"] as const;

/** The two flags' help lines, shared by every command that can be refused. */
export const DEVICE_LOCK_FLAG_HELP = `  --wait <secs>          if another run is using the device, wait up to this long for it (default: refuse at once)
  --no-device-lock       go ahead even if another process is using the device`;

export function deviceLockOptions(args: string[]): DeviceLockOptions {
  const skip = hasFlag(args, "--no-device-lock");
  const waitSeconds = getIntFlag(args, "--wait");
  if (skip && getFlag(args, "--wait") !== undefined) {
    throw new AxiError(
      "--wait waits for the device lock, and --no-device-lock skips it",
      "VALIDATION_ERROR",
      ["Pass one of them"],
    );
  }
  return {
    skip,
    ...(waitSeconds !== undefined ? { waitSeconds } : {}),
  };
}

const POLL_MS = 2_000;

export interface GuardOptions {
  udid: string;
  meta: LockMeta;
  options: DeviceLockOptions;
  deps?: LockDeps;
}

/** A device someone else has, and who. */
interface Busy {
  udid: string;
  device: string;
  holder: Holder;
}

type Claim = { release: () => void } | { busy: Busy };

/**
 * Take the device for this run, waiting if asked, or refuse naming who has it.
 * Returns the release, which the caller runs in a `finally`.
 */
export async function acquireDevice(guard: GuardOptions): Promise<() => void> {
  if (guard.options.skip || heldByParent(guard.udid)) return () => {};
  const deps = guard.deps ?? defaultDeps();
  const busy = (holder: Holder): Claim => ({
    busy: { udid: guard.udid, device: guard.meta.device, holder },
  });

  return pollDevice(guard.meta.command, guard.options, deps, () => {
    const attempt = tryAcquire(deps, guard.udid, guard.meta);
    if ("holder" in attempt) return busy(attempt.holder);
    const [raw] = findContenders(parsePs(deps.psList()), guard.udid, deps.pid);
    if (raw) {
      attempt.release();
      return busy(raw);
    }
    // Exported so a scheme pre-action's xcodebuild-axi sees the device is
    // this run's; withdrawn with the lock.
    const before = process.env[INHERITED_ENV];
    process.env[INHERITED_ENV] = [...inherited(), guard.udid].join(",");
    return {
      release() {
        attempt.release();
        if (before === undefined) delete process.env[INHERITED_ENV];
        else process.env[INHERITED_ENV] = before;
      },
    };
  });
}

/**
 * Refuse, or wait, while someone else has the device -- without taking it.
 * For one-shot `sim` changes, where holding a lock for a one-second simctl
 * call would only make two quick commands refuse each other.
 */
export async function checkDevice(guard: GuardOptions): Promise<void> {
  await checkDevices(
    [{ udid: guard.udid, device: guard.meta.device }],
    guard.meta.command,
    guard.options,
    guard.deps,
  );
}

/**
 * `checkDevice` for a blanket change -- `sim shutdown --all` -- over every
 * device it would touch: one `ps` per look rather than one per device, and
 * one `--wait` covering them all.
 */
export async function checkDevices(
  devices: { udid: string; device: string }[],
  command: string,
  options: DeviceLockOptions,
  lockDeps?: LockDeps,
): Promise<void> {
  if (options.skip) return;
  const mine = devices.filter((device) => !heldByParent(device.udid));
  if (mine.length === 0) return;
  const deps = lockDeps ?? defaultDeps();

  await pollDevice(command, options, deps, () => {
    for (const { udid, device } of mine) {
      const path = lockPath(deps.dir, udid);
      const holder = liveHolder(readLock(path, deps), path, deps);
      if (holder) return { busy: { udid, device, holder } };
    }
    const rows = parsePs(deps.psList());
    for (const { udid, device } of mine) {
      const [raw] = findContenders(rows, udid, deps.pid);
      if (raw) return { busy: { udid, device, holder: raw } };
    }
    return { release: () => {} };
  });
}

async function pollDevice(
  command: string,
  options: DeviceLockOptions,
  deps: LockDeps,
  attempt: () => Claim,
): Promise<() => void> {
  const started = deps.now();
  const reported = new Set<number>();
  for (;;) {
    const result = attempt();
    if ("release" in result) return result.release;
    const { busy } = result;

    const waitedMs = deps.now() - started;
    const wait = options.waitSeconds;
    if (wait === undefined || waitedMs >= wait * 1000) {
      throw busyError(command, busy, wait === undefined ? undefined : waitedMs);
    }
    if (!reported.has(busy.holder.pid)) {
      reported.add(busy.holder.pid);
      say(
        deps.progress,
        `${renderFields({ waiting: `${busy.device} — held by ${describeHolder(busy.holder)}` })}\n`,
      );
    }
    await deps.sleep(Math.min(POLL_MS, wait * 1000 - waitedMs));
  }
}

/** A stderr line that cannot crash the run if nobody is reading. */
function say(progress: NodeJS.WritableStream, text: string): void {
  const ignore = () => {};
  progress.once("error", ignore);
  progress.write(text, () => progress.removeListener("error", ignore));
}

function describeHolder(holder: Holder): string {
  const what = [holder.command, holder.scheme].filter(Boolean).join(" ");
  const held =
    holder.heldSeconds !== undefined
      ? ` for ${duration(holder.heldSeconds)}`
      : "";
  return `pid ${holder.pid} (${what}${held})`;
}

function busyError(
  command: string,
  { udid, device, holder }: Busy,
  waitedMs: number | undefined,
): DeviceBusyError {
  return new DeviceBusyError(
    `${device} is in use by another run`,
    {
      udid,
      holder: {
        pid: holder.pid,
        command: holder.command,
        ...(holder.scheme ? { scheme: holder.scheme } : {}),
        ...(holder.project ? { project: tildePath(holder.project) } : {}),
        ...(holder.heldSeconds !== undefined
          ? { held: duration(holder.heldSeconds) }
          : {}),
      },
      ...(holder.lock ? { lock: tildePath(holder.lock) } : {}),
      ...(waitedMs !== undefined ? { waited: duration(waitedMs / 1000) } : {}),
    },
    [
      "Add `--wait 900` to wait up to 15 minutes for it",
      command.startsWith("sim ")
        ? "Run `xcodebuild-axi sim list` to pick another simulator"
        : "Pass `--device <name>` for another simulator",
      "`--no-device-lock` goes ahead anyway, and the two runs will overwrite each other's installs",
    ],
  );
}
