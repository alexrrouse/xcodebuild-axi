import type { Diagnostic } from "./xcresult.js";
import { renderList, truncate } from "./toon.js";

/**
 * Render a capped list of diagnostics.
 *
 * Errors cascade: one bad protocol conformance can produce sixty lines that
 * all name the same root cause, and printing all sixty is exactly the flood
 * this tool exists to stop. The cap keeps the first N — which is where the
 * cause almost always is — and says how many it withheld (AXI principles 3
 * and 4), so the count is never silently wrong.
 */
export function diagnosticsBlock(
  label: string,
  diagnostics: Diagnostic[],
  limit: number,
  messageLimit = 300,
): { block: string; hidden: number } {
  if (diagnostics.length === 0) return { block: "", hidden: 0 };

  const shown = diagnostics.slice(0, limit).map((diagnostic) => ({
    file: diagnostic.file,
    line: diagnostic.line,
    col: diagnostic.col,
    type: diagnostic.type,
    message: truncate(diagnostic.message, messageLimit).text,
  }));

  const hidden = diagnostics.length - shown.length;
  const heading =
    hidden > 0 ? `${label} (${shown.length} of ${diagnostics.length})` : label;

  return { block: renderList(heading, shown), hidden };
}

/**
 * The last lines of a transcript, for a failure the result bundle cannot
 * explain — a wedged simulator, a signal, a timeout. Showing nothing here
 * would be the quiet wrapper hiding the very failure it exists to surface.
 */
export function transcriptTail(tail: string, lines = 15): string {
  const kept = tail
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-lines);
  if (kept.length === 0) return "";
  return `tail[${kept.length}]:\n${kept.map((line) => `  ${line}`).join("\n")}`;
}
