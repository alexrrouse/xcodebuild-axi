import { describe, expect, it } from "vitest";
import { mapXcodebuildError } from "../src/errors.js";
import { formatCliError } from "../src/cli.js";
import { AxiError } from "axi-sdk-js";

describe("mapXcodebuildError", () => {
  // The result bundle for these says only "xcodebuild encountered an error
  // (65)" — xcodebuild died before it built anything, so the transcript is the
  // only witness.
  it("recognizes a bad scheme name and points at the lookup", () => {
    const mapped = mapXcodebuildError(
      'xcodebuild: error: The workspace named "MyApps" does not contain a scheme named "Futuers".',
    );
    expect(mapped?.code).toBe("SCHEME_NOT_FOUND");
    expect(mapped?.message).toContain("Futuers");
    expect(mapped?.suggestions[0]).toContain("xcodebuild-axi schemes");
  });

  it("recognizes an unmatched destination", () => {
    const mapped = mapXcodebuildError(
      "xcodebuild: error: Unable to find a destination matching the provided destination specifier",
    );
    expect(mapped?.code).toBe("DESTINATION_NOT_FOUND");
  });

  // A package has no default destination at all, and the raw refusal names
  // -showdestinations, which is not a thing this tool asks anyone to run.
  it("recognizes a Swift package asked to build with no destination", () => {
    const mapped = mapXcodebuildError(
      'xcodebuild: error: Building a Swift package requires that a destination is provided using the "-destination" option.',
    );
    expect(mapped?.code).toBe("DESTINATION_NOT_FOUND");
    expect(mapped?.suggestions.join(" ")).toContain("--device");
  });

  it("recognizes the leftover result bundle that blocks a re-run", () => {
    const mapped = mapXcodebuildError(
      "error: Existing file at -resultBundlePath",
    );
    expect(mapped?.code).toBe("VALIDATION_ERROR");
  });

  it("recognizes a missing signing team and says simulator builds need none", () => {
    const mapped = mapXcodebuildError(
      'error: Signing for "MyApp" requires a development team. Select a development team.',
    );
    expect(mapped?.message).toContain("MyApp");
    expect(mapped?.suggestions.join(" ")).toContain("simulator");
  });

  it("falls back to xcodebuild's own message rather than inventing one", () => {
    const mapped = mapXcodebuildError(
      "xcodebuild: error: something new and unhandled",
    );
    expect(mapped?.code).toBe("UNKNOWN");
    expect(mapped?.message).toBe("something new and unhandled");
  });

  it("returns undefined for a transcript with no failure in it", () => {
    expect(mapXcodebuildError("** BUILD SUCCEEDED **")).toBeUndefined();
  });
});

describe("formatCliError", () => {
  // Errors are data, on stdout, in the same shape as an answer.
  it("renders an AxiError as TOON with its suggestions", () => {
    const { output, exitCode } = formatCliError(
      new AxiError("No scheme named 'X'", "SCHEME_NOT_FOUND", [
        "Run `xcodebuild-axi schemes`",
      ]),
    );
    expect(output).toContain("error: No scheme named 'X'");
    expect(output).toContain("code: SCHEME_NOT_FOUND");
    expect(output).toContain("help[1]:\n  Run `xcodebuild-axi schemes`");
    expect(exitCode).toBe(1);
  });

  it("uses exit code 2 for a usage error", () => {
    expect(
      formatCliError(new AxiError("bad flag", "VALIDATION_ERROR")).exitCode,
    ).toBe(2);
  });

  it("wraps a plain Error rather than leaking a stack", () => {
    const { output } = formatCliError(new Error("boom"));
    expect(output).toContain("error: boom");
    expect(output).toContain("code: UNKNOWN");
    expect(output).not.toContain("at ");
  });
});
