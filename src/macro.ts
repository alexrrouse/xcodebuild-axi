import { createReadStream, existsSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import type { BuildResults } from "./xcresult.js";

/**
 * Where a diagnostic inside a Swift macro expansion really is.
 *
 * The result bundle records an error in `#expect(...)` against the temporary
 * file the compiler expanded the macro into --
 * `.../swift-generated-sources/@__swiftmacro_10MyAppTests0024CheckoutTestsswift_ynAHffMX6_4_6expectfMf_.swift`
 * at line 2, column 3 -- and against nothing else. That file is usually gone
 * by the time anyone reads the report, and the position is inside it.
 *
 * Two witnesses say where the macro was written:
 *
 * - The mangled name encodes the source file's base name and the line and
 *   column the macro starts at (`MX6_4_` is 7:5, the `#` of `#expect`).
 * - The transcript follows the error with an "expanded code originates here"
 *   note carrying the file's full path. Its line and column are the macro's
 *   *end* -- one past the closing parenthesis, on the last line of a
 *   multi-line `#expect` -- so only its path is used when the name parses.
 */

const MACRO_FILE_PREFIX = "@__swiftmacro_";

export interface MacroExpansionName {
  module: string;
  /** The source file's base name, e.g. `CheckoutTests.swift`. */
  file: string;
  /** One-based, where the macro starts. */
  line: number;
  col: number;
}

/** One error or warning the transcript traced back out of an expansion. */
export interface MacroOrigin {
  /** One-based position inside the expansion, as `parseSourceURL` reports it. */
  line: number;
  col: number;
  message: string;
  /** Absolute path of the file the macro was written in. */
  file: string;
  originLine: number;
  originCol: number;
}

export interface SourceLocation {
  file: string;
  line: number | "";
  col: number | "";
}

export function isMacroExpansionFile(path: string): boolean {
  return basename(path).startsWith(MACRO_FILE_PREFIX);
}

/**
 * Read a freestanding macro's expansion file name, or undefined.
 *
 * Lengths delimit the parts, so this walks it with a cursor: the module, the
 * file name -- always punycode, since `.` cannot appear in an identifier --
 * then `fMX` and the line and column. Anything else, including an attached
 * macro (`...fMp_`) or a mangling this does not know, is undefined rather
 * than a guess.
 */
export function parseMacroExpansionName(
  path: string,
): MacroExpansionName | undefined {
  const name = basename(path).replace(/\.swift$/, "");
  if (!name.startsWith(MACRO_FILE_PREFIX)) return undefined;
  let cursor = MACRO_FILE_PREFIX.length;

  const readIdentifier = (): string | undefined => {
    const punycode = name.startsWith("00", cursor);
    if (punycode) cursor += 2;
    const digits = /^\d+/.exec(name.slice(cursor))?.[0];
    if (!digits) return undefined;
    cursor += digits.length;
    // The mangler separates a punycode identifier that starts with a digit
    // or an underscore from its length.
    if (punycode && name[cursor] === "_") cursor += 1;
    const length = Number(digits);
    const raw = name.slice(cursor, cursor + length);
    if (raw.length !== length) return undefined;
    cursor += length;
    return punycode ? decodeSwiftPunycode(raw) : raw;
  };

  // `N_` is N + 1, and a bare `_` is zero -- so these come out one-based.
  const readIndex = (): number | undefined => {
    const match = /^(\d*)_/.exec(name.slice(cursor));
    if (!match) return undefined;
    cursor += match[0].length;
    return match[1] === "" ? 0 : Number(match[1]) + 1;
  };

  const module = readIdentifier();
  const file = readIdentifier();
  if (!module || !file?.endsWith(".swift")) return undefined;
  if (!name.startsWith("fMX", cursor)) return undefined;
  cursor += 3;
  const line = readIndex();
  const col = readIndex();
  if (!line || !col) return undefined;
  return { module, file, line, col };
}

/**
 * Decode Swift's punycode variant: base 36 over `a-z` then `A-J`, `_` as the
 * delimiter, and characters that cannot appear in a symbol -- the `.` of
 * every file name -- shifted to 0xD800 + c before encoding.
 */
export function decodeSwiftPunycode(encoded: string): string | undefined {
  const base = 36;
  const tMin = 1;
  const tMax = 26;
  const delimiter = encoded.lastIndexOf("_");
  const output = [...(delimiter > 0 ? encoded.slice(0, delimiter) : "")].map(
    (char) => char.codePointAt(0) as number,
  );
  const digitOf = (char: string | undefined): number => {
    const code = char?.charCodeAt(0) ?? -1;
    if (code >= 97 && code <= 122) return code - 97;
    if (code >= 65 && code <= 74) return code - 65 + 26;
    return -1;
  };
  const adapt = (delta: number, points: number, first: boolean): number => {
    let scaled = first ? Math.floor(delta / 700) : Math.floor(delta / 2);
    scaled += Math.floor(scaled / points);
    let k = 0;
    while (scaled > ((base - tMin) * tMax) / 2) {
      scaled = Math.floor(scaled / (base - tMin));
      k += base;
    }
    return k + Math.floor(((base - tMin + 1) * scaled) / (scaled + 38));
  };

  let n = 128;
  let i = 0;
  let bias = 72;
  let position = delimiter > 0 ? delimiter + 1 : 0;
  while (position < encoded.length) {
    const oldI = i;
    let weight = 1;
    for (let k = base; ; k += base) {
      if (position >= encoded.length) return undefined;
      const digit = digitOf(encoded[position++]);
      if (digit < 0) return undefined;
      i += digit * weight;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (digit < t) break;
      weight *= base - t;
    }
    bias = adapt(i - oldI, output.length + 1, oldI === 0);
    n += Math.floor(i / (output.length + 1));
    i %= output.length + 1;
    output.splice(i, 0, n);
    i += 1;
  }

  return String.fromCodePoint(
    ...output.map((point) =>
      point >= 0xd800 && point < 0xd880 ? point - 0xd800 : point,
    ),
  );
}

/**
 * The bundle capitalises a message the transcript does not, and the
 * transcript may end one with its diagnostic group, ` [#NoUsage]`.
 */
export function sameDiagnosticMessage(a: string, b: string): boolean {
  const normalize = (message: string) =>
    message
      .replace(/\s*\[#\w+\]$/, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  return normalize(a) === normalize(b);
}

const ORIGIN_HEADER =
  /^macro expansion [#@]?\w+:(\d+):(\d+): (?:error|warning): (.*)$/;
const ORIGIN_NOTE =
  /^(?:[`|]-\s+)?(\/.+?):(\d+):(\d+): note: expanded code originates here$/;

/**
 * Feed a transcript one line at a time and collect every
 *
 *     macro expansion #expect:2:3: error: call can throw, ...
 *     `- /repo/Tests/MyAppTests/CheckoutTests.swift:7:42: note: expanded code originates here
 *
 * pair. Only lines starting `macro expansion ` reach a regex, so a transcript
 * of megabytes costs a prefix check per line.
 */
export function macroOriginScanner(): {
  push(text: string): void;
  origins: MacroOrigin[];
} {
  const origins: MacroOrigin[] = [];
  let pending: { line: number; col: number; message: string } | undefined;
  return {
    origins,
    push(text: string) {
      const header = pending;
      pending = undefined;
      if (text.startsWith("macro expansion ")) {
        const [, line, col, message] = ORIGIN_HEADER.exec(text) ?? [];
        if (message !== undefined) {
          pending = { line: Number(line), col: Number(col), message };
        }
        return;
      }
      if (!header) return;
      const [, file, originLine, originCol] = ORIGIN_NOTE.exec(text) ?? [];
      if (file === undefined || isMacroExpansionFile(file)) return;
      origins.push({
        ...header,
        file,
        originLine: Number(originLine),
        originCol: Number(originCol),
      });
    },
  };
}

export function parseMacroOrigins(transcript: string): MacroOrigin[] {
  const scanner = macroOriginScanner();
  for (const line of transcript.split("\n")) scanner.push(line);
  return scanner.origins;
}

/**
 * Stream the run's log for macro origins -- but only when the bundle holds a
 * diagnostic inside an expansion, so the common report never opens it. The
 * transcript is never held in memory, and a log that cannot be read costs
 * the report its paths, not its answer.
 */
export async function readMacroOrigins(
  logPath: string | undefined,
  results: BuildResults | undefined,
): Promise<MacroOrigin[]> {
  const issues = [
    ...(results?.errors ?? []),
    ...(results?.warnings ?? []),
    ...(results?.analyzerWarnings ?? []),
  ];
  if (!issues.some((issue) => issue.sourceURL?.includes(MACRO_FILE_PREFIX))) {
    return [];
  }
  if (!logPath || !existsSync(logPath)) return [];

  const scanner = macroOriginScanner();
  try {
    const lines = createInterface({
      input: createReadStream(logPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) scanner.push(line);
  } catch {
    // Whatever was read before the failure is still good.
  }
  return scanner.origins;
}

/**
 * The source location of a diagnostic the bundle placed in an expansion
 * file, or undefined when nothing can say.
 *
 * A freestanding macro is reported where it starts, in the file its name
 * gives. The transcript supplies the directory: of the origins with the same
 * message at the same position in an expansion, the one in a file of that
 * name nearest at or below the macro's first line. When no origin settles it
 * -- no log, or two paths equally near -- the bare file name is still
 * exact, and one search away from a path.
 *
 * An attached macro's name carries no position, so its origin is used as the
 * transcript gives it, and only when every candidate agrees.
 */
export function locateInSource(
  at: SourceLocation & { message: string },
  origins: MacroOrigin[],
): SourceLocation | undefined {
  const candidates = origins.filter(
    (origin) =>
      origin.line === at.line &&
      origin.col === at.col &&
      sameDiagnosticMessage(origin.message, at.message),
  );

  const name = parseMacroExpansionName(at.file);
  if (!name) {
    const [first] = candidates;
    const agreed =
      first &&
      candidates.every(
        (origin) =>
          origin.file === first.file &&
          origin.originLine === first.originLine &&
          origin.originCol === first.originCol,
      );
    return agreed
      ? { file: first.file, line: first.originLine, col: first.originCol }
      : undefined;
  }

  const inFile = candidates.filter(
    (origin) =>
      basename(origin.file) === name.file && origin.originLine >= name.line,
  );
  const nearest = Math.min(
    ...inFile.map((origin) => origin.originLine - name.line),
  );
  const paths = new Set(
    inFile
      .filter((origin) => origin.originLine - name.line === nearest)
      .map((origin) => origin.file),
  );
  const [path] = paths;
  return {
    file: paths.size === 1 && path !== undefined ? path : name.file,
    line: name.line,
    col: name.col,
  };
}
