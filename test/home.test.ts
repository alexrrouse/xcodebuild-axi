import { describe, expect, it } from "vitest";
import { buildVerdict, failedWithoutErrors } from "../src/commands/home.js";

describe("buildVerdict", () => {
  it.each([
    ["build", { status: "succeeded" }, "build succeeded"],
    ["archive", { status: "succeeded" }, "archive succeeded"],
    ["build", { status: "failed", errorCount: 2 }, "build failed (2 errors)"],
    ["build", { status: "failed", errorCount: 1 }, "build failed (1 error)"],
    ["build", { status: "failed", errorCount: 0 }, "build failed"],
    ["build", { status: "notRequested" }, "build failed before building"],
    ["clean", { status: "cancelled" }, "clean cancelled"],
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
  });

  // `run` installs and launches the app itself; the bundle saw only the
  // build, so claiming the run succeeded would claim a launch nobody checked.
  it("words a run's verdict as its build's", () => {
    expect(buildVerdict("run", { status: "succeeded" })).toBe(
      "run build succeeded",
    );
    expect(buildVerdict("run", { status: "failed", errorCount: 1 })).toBe(
      "run build failed (1 error)",
    );
  });

  it("gives no verdict when the bundle does not say", () => {
    expect(buildVerdict("build", undefined)).toBeUndefined();
    expect(buildVerdict("build", {})).toBeUndefined();
    expect(buildVerdict("build", { status: "somethingNew" })).toBeUndefined();
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

describe("failedWithoutErrors", () => {
  it("is true only when the bundle has no errors to show", () => {
    expect(failedWithoutErrors({ status: "notRequested" })).toBe(true);
    expect(failedWithoutErrors({ status: "failed", errorCount: 0 })).toBe(true);
    expect(failedWithoutErrors({ status: "failed" })).toBe(true);
    expect(failedWithoutErrors({ status: "failed", errorCount: 2 })).toBe(
      false,
    );
    expect(failedWithoutErrors({ status: "succeeded" })).toBe(false);
    expect(failedWithoutErrors(undefined)).toBe(false);
  });
});
