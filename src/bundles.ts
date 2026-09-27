import { readdirSync, statSync } from "node:fs";
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
    // A run clears its own bundle before writing it, so one can vanish
    // between the listing and the stat.
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
 * Which command wrote a bundle, from the name `runLabel` gave it:
 * `<scheme>[-<device>]-<command>.xcresult`.
 *
 * This is the only place that parses that naming. If bundle names ever gain a
 * per-run suffix, this has to learn it in the same change, or the home view
 * and `result`'s choice of the last test run both go wrong.
 */
export function bundleKind(path: string): string {
  const stem = basename(path, ".xcresult");
  const tail = stem.split("-").pop();
  // `basename` leaves the extension alone when stripping it would leave
  // nothing, so a degenerate ".xcresult" comes back whole. A command name
  // always starts with a letter, which is enough to tell the two apart.
  return tail && /^[A-Za-z]/.test(tail) ? tail : "run";
}
