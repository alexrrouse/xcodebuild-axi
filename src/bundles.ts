import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { defaultDeps } from "./devicelock.js";

/** A result bundle this tool wrote into a project's artifact directory. */
export interface RecordedBundle {
  path: string;
  mtimeMs: number;
  kind: string;
}

/**
 * Every result bundle in `dir`, newest first.
 *
 * Recency is the modification time, not anything in the name, so a change to
 * how bundles are named cannot change which one is newest. Equal times fall
 * back to the name so the answer is the same on every call.
 */
export function listBundles(dir: string): RecordedBundle[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const bundles: RecordedBundle[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".xcresult")) continue;
    const path = join(dir, entry);
    // Another run's pruning can remove one between the listing and the stat.
    try {
      bundles.push({
        path,
        mtimeMs: statSync(path).mtimeMs,
        kind: bundleKind(path),
      });
    } catch {
      continue;
    }
  }
  return bundles.sort(
    (a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path),
  );
}

/**
 * The newest bundle in `dir`, or the newest of one kind.
 *
 * `skipped` is the newest bundle overall when the kind filter passed over it,
 * so a caller can say that a later run exists rather than silently reading an
 * older one.
 */
export function newestBundle(
  dir: string,
  kind?: string,
): { chosen?: RecordedBundle; skipped?: RecordedBundle } {
  const bundles = listBundles(dir);
  const chosen =
    kind === undefined
      ? bundles[0]
      : bundles.find((bundle) => bundle.kind === kind);
  const newest = bundles[0];
  return {
    ...(chosen ? { chosen } : {}),
    ...(newest && newest !== chosen ? { skipped: newest } : {}),
  };
}

/**
 * Which command wrote a bundle, from the name `runLabel` and `runStem` gave
 * it: `<scheme>[-<device>]-<command>-<pid>[-<n>].xcresult`.
 *
 * This is the only place that parses that naming. The per-run suffix is all
 * digits and a command name always starts with a letter, so the suffix is
 * stripped first and the last segment left is the command. A bundle from
 * before runs were suffixed has no digits to strip and reads the same way.
 */
export function bundleKind(path: string): string {
  const stem = basename(path, ".xcresult").replace(/(-\d+)+$/, "");
  const tail = stem.split("-").pop();
  // `basename` leaves the extension alone when stripping it would leave
  // nothing, so a degenerate ".xcresult" comes back whole. A command name
  // always starts with a letter, which is enough to tell the two apart.
  return tail && /^[A-Za-z]/.test(tail) ? tail : "run";
}

/**
 * The filename stem for one run of `label`: every artifact it writes shares
 * it, and no other run's artifacts do.
 *
 * Two live processes cannot share a pid, so the pid alone keeps concurrent
 * runs apart; `n` separates two runs of one label inside one process. The pid
 * is also what tells a finished run from a live one when pruning. No
 * timestamp: modification time already orders runs, and one would cost every
 * report a dozen tokens in each path it prints.
 */
export function runStem(label: string, pid = process.pid, n = 1): string {
  return n > 1 ? `${label}-${pid}-${n}` : `${label}-${pid}`;
}

/** The log written beside a bundle: every run's artifacts share one stem. */
export function logFor(bundlePath: string): string {
  return bundlePath.replace(/\.xcresult$/, ".log");
}

/**
 * Every file a run can leave, as the suffix after its stem. The log is the
 * claim; the others are written beside it by `tests` and `run`.
 */
export const RUN_ARTIFACT_SUFFIXES = [
  ".xcresult",
  ".log",
  ".json",
  "-console.log",
] as const;

/**
 * Whether the run that started at `sinceMs` is still going under `pid`.
 *
 * `kill(pid, 0)` alone would keep a finished run for as long as whatever
 * later reused its pid lives -- after a reboot, often for days. So a live pid
 * is asked when it started, the way the device lock judges a holder, and one
 * that started after the run's files existed is someone else. `lstart` counts
 * whole seconds, hence the slack.
 */
export function runStillGoing(
  pid: number,
  sinceMs: number,
  processStart: (pid: number) => string | undefined = (pid) =>
    defaultDeps().processStart(pid),
): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  const started = processStart(pid);
  if (started === undefined) return false;
  const startedMs = Date.parse(started);
  return Number.isNaN(startedMs) || startedMs <= sinceMs + 1000;
}

export interface PruneDeps {
  /** Whether `pid` is still the run whose first file appeared at `sinceMs`. */
  alive: (pid: number, sinceMs: number) => boolean;
  /** Where `result --export` put things from a bundle, to go with it. */
  exportRoot?: (bundlePath: string) => string;
}

/**
 * Remove the older finished runs of `label` from `dir`, keeping the newest
 * finished run that has a result bundle and every run still in progress.
 * Returns what it removed.
 *
 * Each run gets its own paths, so without this the cache would grow by a
 * result bundle per run for ever. The previous bundle survives the start of
 * the next run because the path its report printed may still be in use --
 * `result <previous> --against <new>` among others -- and a run whose process
 * is alive is never touched, since it may not have read its bundle yet.
 *
 * Only a run with a bundle counts as the one kept: a `run --no-build` leaves
 * only a console, and one killed before xcodebuild started only an empty log,
 * and either would otherwise push the last real bundle out.
 *
 * Per label, so a build never removes the test bundle `result` would fall
 * back to. A name from before runs were suffixed carries no pid and counts
 * as finished. Housekeeping must never fail a run, so every error is ignored.
 */
export function pruneRuns(
  dir: string,
  label: string,
  deps: PruneDeps = { alive: runStillGoing },
): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const suffixes = RUN_ARTIFACT_SUFFIXES.map(escapeRegExp).join("|");
  const pattern = new RegExp(
    `^(${escapeRegExp(label)}(?:-(\\d+)(?:-\\d+)?)?)(${suffixes})$`,
  );
  interface Run {
    pid?: number;
    paths: string[];
    bundle: boolean;
    bornMs: number;
    mtimeMs: number;
  }
  const runs = new Map<string, Run>();
  for (const entry of entries) {
    const match = pattern.exec(entry);
    if (!match) continue;
    const stem = match[1] as string;
    const path = join(dir, entry);
    let stats: { mtimeMs: number; birthtimeMs: number };
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    const run = runs.get(stem) ?? {
      ...(match[2] !== undefined ? { pid: Number(match[2]) } : {}),
      paths: [],
      bundle: false,
      bornMs: Infinity,
      mtimeMs: 0,
    };
    run.paths.push(path);
    run.bundle ||= match[3] === ".xcresult";
    run.bornMs = Math.min(run.bornMs, stats.birthtimeMs || stats.mtimeMs);
    run.mtimeMs = Math.max(run.mtimeMs, stats.mtimeMs);
    runs.set(stem, run);
  }

  const finished = [...runs.entries()]
    .filter(
      ([, run]) => run.pid === undefined || !deps.alive(run.pid, run.bornMs),
    )
    .sort(([a, x], [b, y]) => y.mtimeMs - x.mtimeMs || a.localeCompare(b));
  const kept = finished.find(([, run]) => run.bundle)?.[0];

  const removed: string[] = [];
  const remove = (path: string) => {
    try {
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch {
      // Not ours to remove after all; leave it.
    }
  };
  for (const [stem, run] of finished) {
    if (stem === kept) continue;
    for (const path of run.paths) remove(path);
    const exported = deps.exportRoot?.(join(dir, `${stem}.xcresult`));
    if (exported && existsSync(exported)) remove(exported);
  }
  return removed;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
