import { describe, expect, it } from "vitest";
import { buildVerdict, nothingToRead } from "../src/commands/home.js";

const GENERIC = { message: "xcodebuild encountered an error (65)" };
const REAL = { issueType: "Swift Compiler Error", message: "Cannot find 'x'" };

describe("buildVerdict", () => {
  it.each([
    ["build", { status: "succeeded" }, "build succeeded"],
    ["archive", { status: "succeeded" }, "archive succeeded"],
    ["clean", { status: "succeeded" }, "clean succeeded"],
    ["build", { status: "failed", errorCount: 2 }, "build failed (2 errors)"],
    ["build", { status: "failed", errors: [REAL] }, "build failed (1 error)"],
    ["build", { status: "failed", errorCount: 0 }, "build failed"],
    ["build", { status: "notRequested" }, "build failed before building"],
    ["clean", { status: "cancelled" }, "clean cancelled"],
    [
      "build",
      { status: "interrupted", errors: [REAL, REAL, REAL] },
      "build interrupted (3 errors)",
    ],
    [
      "analyze",
      { status: "succeeded", analyzerWarningCount: 3 },
      "analyze succeeded (3 analyzer warnings)",
    ],
    ["analyze", { status: "succeeded" }, "analyze succeeded"],
  ] as const)("%s %j reads %s", (kind, results, expected) => {
    expect(buildVerdict(kind, results)).toBe(expected);
  });

  // Observed on Xcode 27: a destination that matched nothing left a bundle
  // saying `succeeded` beside the error that failed the build.
  it("reads a bundle with errors as failed whatever its status says", () => {
    expect(buildVerdict("build", { status: "succeeded", errorCount: 1 })).toBe(
      "build failed (1 error)",
    );
    expect(buildVerdict("build", { status: "succeeded", errors: [REAL] })).toBe(
      "build failed (1 error)",
    );
  });

  // The exit-code row says only that xcodebuild gave up; counting it as an
  // error would send the agent to a bundle with nothing else in it.
  it("does not count the generic exit-code row as an error", () => {
    expect(buildVerdict("build", { status: "failed", errors: [GENERIC] })).toBe(
      "build failed",
    );
    expect(
      buildVerdict("build", { status: "failed", errors: [GENERIC, REAL] }),
    ).toBe("build failed (1 error)");
  });

  // `run` installs and launches the app itself; the bundle saw only the
  // build, so claiming the run succeeded would claim a launch nobody checked.
  it("words a run's and a test's verdict as their build's", () => {
    expect(buildVerdict("run", { status: "succeeded" })).toBe(
      "run build succeeded",
    );
    expect(buildVerdict("test", { status: "failed", errors: [REAL] })).toBe(
      "test build failed (1 error)",
    );
  });

  it("gives no verdict when the bundle does not say", () => {
    expect(buildVerdict("build", undefined)).toBeUndefined();
    expect(buildVerdict("build", {})).toBeUndefined();
    expect(buildVerdict("build", { status: "somethingNew" })).toBeUndefined();
  });

  // `tests` stops before running anything, and its bundle says nothing about
  // whether the listing worked.
  it("gives no verdict for a kind whose bundle is not one", () => {
    expect(buildVerdict("tests", { status: "notRequested" })).toBeUndefined();
  });

  // TOON quotes a scalar holding a comma or a colon, which costs more than
  // the punctuation.
  it("never needs quoting", () => {
    for (const status of ["succeeded", "failed", "notRequested"]) {
      const verdict = buildVerdict("build", { status, errorCount: 2 });
      expect(verdict).not.toMatch(/[,:"]/);
    }
  });
});

describe("nothingToRead", () => {
  it("is true when the bundle cannot say why the run failed", () => {
    expect(nothingToRead(undefined)).toBe(true);
    expect(nothingToRead({ status: "notRequested" })).toBe(true);
    expect(nothingToRead({ status: "failed", errorCount: 0 })).toBe(true);
    expect(nothingToRead({ status: "failed", errors: [GENERIC] })).toBe(true);
  });

  it("is false when the bundle has a verdict worth reading", () => {
    expect(nothingToRead({ status: "failed", errors: [REAL] })).toBe(false);
    expect(nothingToRead({ status: "succeeded" })).toBe(false);
  });
});
