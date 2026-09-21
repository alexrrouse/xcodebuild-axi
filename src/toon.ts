import { encode } from "@toon-format/toon";

/**
 * Output rendering. TOON at the boundary, plain objects everywhere inside
 * (AXI principle 1).
 */

/** Render a labeled list of uniform rows as a TOON table. */
export function renderList(
  label: string,
  rows: Record<string, unknown>[],
): string {
  return encode({ [label]: rows });
}

/** Render a labeled object as TOON. */
export function renderDetail(
  label: string,
  value: Record<string, unknown>,
): string {
  return encode({ [label]: value });
}

/** Render bare top-level key/value lines. */
export function renderFields(fields: Record<string, unknown>): string {
  return encode(fields);
}

/**
 * Render next-step suggestions (AXI principle 9).
 *
 * Hand-formatted rather than passed to `encode()`, which inlines arrays of
 * primitives onto one line — unreadable once the entries are full commands.
 */
export function renderHelp(lines: string[]): string {
  const present = lines.filter((line) => line.length > 0);
  if (present.length === 0) return "";
  return `help[${present.length}]:\n${present.map((l) => `  ${l}`).join("\n")}`;
}

/** Join rendered blocks, dropping the empty ones. */
export function renderOutput(blocks: string[]): string {
  return blocks.filter((block) => block.length > 0).join("\n");
}

/**
 * Truncate long free text, telling the agent what it is missing and how to get
 * it (AXI principle 3). Returns the text unchanged when it already fits.
 */
export function truncate(
  text: string,
  limit = 800,
): { text: string; truncated: boolean; total: number } {
  const total = text.length;
  if (total <= limit) return { text, truncated: false, total };
  return {
    text: `${text.slice(0, limit)}\n... (truncated, ${total} chars total)`,
    truncated: true,
    total,
  };
}

/** Collapse `$HOME` to `~` so paths stay short and stable across machines. */
export function tildePath(absolute: string): string {
  const home = process.env["HOME"];
  if (home && absolute.startsWith(`${home}/`)) {
    return `~${absolute.slice(home.length)}`;
  }
  return absolute;
}

/** Seconds, rendered the way a human skims them. */
export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m${rest.toString().padStart(2, "0")}s`;
}

/** Relative age of a timestamp, for "when did this last run". */
export function relativeTime(epochSeconds: number | undefined): string {
  if (epochSeconds === undefined || !Number.isFinite(epochSeconds))
    return "unknown";
  const diff = Math.floor(Date.now() / 1000 - epochSeconds);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
