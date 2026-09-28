import { readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";

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

/** Whether a process is running. One owned by another user still counts. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface PruneDeps {
  alive: (pid: number) => boolean;
  /** Where `result --export` put things from a bundle, to go with it. */
  exportRoot?: (bundlePath: string) => string;
}

/** How many finished runs of a label outlive the start of the next one. */
const KEEP_FINISHED = 1;

/**
 * Remove the older finished runs of `label` from `dir`, keeping the newest
 * finished one and every run still in progress. Returns what it removed.
 *
 * Each run gets its own paths, so without this the cache would grow by a
 * result bundle per run for ever. The previous run survives the start of the
 * next one because the path its report printed may still be in use --
 * `result <previous> --against <new>` among others -- and a run whose process
 * is alive is never touched, since it may not have read its bundle yet. That
 * a finished run's pid can be reused errs toward keeping, never removing.
 *
 * Per label, so a build never removes the test bundle `result` would fall
 * back to. A name from before runs were suffixed carries no pid and counts
 * as finished. Housekeeping must never fail a run, so every error is ignored.
 */
export function pruneRuns(
  dir: string,
  label: string,
  deps: PruneDeps = { alive: pidAlive },
): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const pattern = new RegExp(
    `^(${escapeRegExp(label)}(?:-(\\d+)(?:-\\d+)?)?)(\\.xcresult|\\.log|\\.json|-console\\.log)$`,
  );
  const runs = new Map<
    string,
    { pid?: number; paths: string[]; mtimeMs: number }
  >();
  for (const entry of entries) {
    const match = pattern.exec(entry);
    if (!match) continue;
    const stem = match[1] as string;
    const path = join(dir, entry);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    const run = runs.get(stem) ?? {
      ...(match[2] !== undefined ? { pid: Number(match[2]) } : {}),
      paths: [],
      mtimeMs: 0,
    };
    run.paths.push(path);
    run.mtimeMs = Math.max(run.mtimeMs, mtimeMs);
    runs.set(stem, run);
  }

  const finished = [...runs.entries()]
    .filter(([, run]) => run.pid === undefined || !deps.alive(run.pid))
    .sort(([a, x], [b, y]) => y.mtimeMs - x.mtimeMs || a.localeCompare(b));

  const removed: string[] = [];
  const remove = (path: string) => {
    try {
      statSync(path);
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch {
      // Already gone, or not ours to remove.
    }
  };
  for (const [stem, run] of finished.slice(KEEP_FINISHED)) {
    for (const path of run.paths) remove(path);
    if (deps.exportRoot) remove(deps.exportRoot(join(dir, `${stem}.xcresult`)));
  }
  return removed;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
