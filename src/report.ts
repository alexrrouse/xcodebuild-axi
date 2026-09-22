import {
  failureLocation,
  readTestDetails,
  type Diagnostic,
  type TestFailure,
} from "./xcresult.js";
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

// A type alias rather than an interface so it satisfies the
// `Record<string, unknown>` that `renderList` takes; TypeScript infers an
// index signature for the one and not the other.
export type FailureRow = {
  test: string;
  target: string;
  file?: string;
  line?: number | "";
  message: string;
};

/**
 * The failure table both `test` and `result` print.
 *
 * A failing test's message says what went wrong; the file and line say where,
 * and they cost one `test-details` read each because the summary does not
 * carry them. Only the rows actually shown are looked up — a run with four
 * hundred failures should not spend four hundred subprocesses to print twenty
 * lines — and a lookup that fails leaves the location blank rather than
 * failing the report, since a bundle from another Xcode may not answer at all.
 */
export async function failureRows(
  resultPath: string,
  failures: TestFailure[],
  options: { max: number; full: boolean },
): Promise<FailureRow[]> {
  const shown = failures.slice(0, options.max);

  const locations = await Promise.all(
    shown.map(async (failure) => {
      const identifier = failure.testIdentifierString;
      if (!identifier) return { file: "", line: "" as number | "" };
      return readTestDetails(resultPath, identifier)
        .then(failureLocation)
        .catch(() => ({ file: "", line: "" as number | "" }));
    }),
  );

  // Two empty columns on every row is worse than no columns: TOON prints the
  // header either way, and a bundle written by another Xcode may answer none
  // of these lookups.
  const located = locations.some((location) => location.file.length > 0);

  return shown.map((failure, index) => {
    const message = (failure.failureText ?? "").replace(/\s+/g, " ").trim();
    return {
      test: failure.testIdentifierString ?? failure.testName ?? "unknown",
      target: failure.targetName ?? "",
      ...(located
        ? {
            file: locations[index]?.file ?? "",
            line: locations[index]?.line ?? "",
          }
        : {}),
      message: options.full ? message : truncate(message, 300).text,
    };
  });
}
