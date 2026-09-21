import { AxiError, exitCodeForError } from "axi-sdk-js";

export type ErrorCode =
  | "XCODE_NOT_INSTALLED"
  | "NO_PROJECT"
  | "SCHEME_NOT_FOUND"
  | "DESTINATION_NOT_FOUND"
  | "RESULT_NOT_FOUND"
  | "SIMULATOR_NOT_FOUND"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "BUILD_FAILED"
  | "TEST_FAILED"
  | "UNKNOWN";

export { AxiError, exitCodeForError };

/**
 * xcodebuild's own refusals, translated.
 *
 * These are the failures that happen *before* a build starts, so no result
 * bundle carries them — the bundle for a bad `-scheme` says only "xcodebuild
 * encountered an error (65)". The transcript is the only source, so the
 * patterns below run against it whenever the bundle has nothing better.
 */
interface ErrorPattern {
  pattern: RegExp;
  code: ErrorCode;
  message: (match: RegExpMatchArray) => string;
  suggestions?: (match: RegExpMatchArray) => string[];
}

const patterns: ErrorPattern[] = [
  {
    pattern:
      /does not contain a scheme named "([^"]+)"|The (?:project|workspace) named "[^"]+" does not contain a scheme named "([^"]+)"/,
    code: "SCHEME_NOT_FOUND",
    message: (m) => `No scheme named '${m[1] ?? m[2]}' in this project`,
    suggestions: () => ["Run `xcodebuild-axi schemes` to list the real names"],
  },
  {
    pattern:
      /Unable to find a destination matching the provided destination specifier/,
    code: "DESTINATION_NOT_FOUND",
    message: () => "No destination matched the requested device",
    suggestions: () => [
      "Run `xcodebuild-axi destinations --scheme <scheme>` to see what this scheme supports",
      'Pass a simulator by name: `--device "iPhone 17 Pro"`',
    ],
  },
  {
    pattern: /Existing file at -resultBundlePath/,
    code: "VALIDATION_ERROR",
    message: () =>
      "A result bundle already exists at that path and xcodebuild will not overwrite it",
    suggestions: () => [
      "Re-run without `--result`, or delete the existing bundle first",
    ],
  },
  {
    pattern: /Signing for "([^"]+)" requires a development team/,
    code: "VALIDATION_ERROR",
    message: (m) => `Target '${m[1]}' needs a development team to sign`,
    suggestions: () => [
      "For a simulator build, signing is not needed — `xcodebuild-axi build` disables it by default",
      "For a device build, pass `--sign` and set DEVELOPMENT_TEAM in the project",
    ],
  },
  {
    pattern: /xcodebuild: error: (.+)/,
    code: "UNKNOWN",
    message: (m) => (m[1] ?? "").trim(),
  },
];

/** Translate an xcodebuild transcript into a structured error, or undefined. */
export function mapXcodebuildError(transcript: string): AxiError | undefined {
  for (const { pattern, code, message, suggestions } of patterns) {
    const match = transcript.match(pattern);
    if (match) {
      return new AxiError(message(match), code, suggestions?.(match) ?? []);
    }
  }
  return undefined;
}

export function xcodeNotInstalledError(): AxiError {
  return new AxiError(
    "Xcode command line tools are not available — `xcodebuild` is not on PATH",
    "XCODE_NOT_INSTALLED",
    ["Install Xcode, then run `xcode-select --switch /Applications/Xcode.app`"],
  );
}
