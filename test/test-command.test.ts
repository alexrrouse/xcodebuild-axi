import { describe, expect, it } from "vitest";
import { testsNeverRan } from "../src/commands/test.js";

describe("testsNeverRan", () => {
  it("is true with no summary at all", () => {
    expect(testsNeverRan(undefined, undefined)).toBe(true);
    expect(testsNeverRan({}, undefined)).toBe(true);
  });

  it("is false once any test counted", () => {
    expect(testsNeverRan({ totalTestCount: 3 }, undefined)).toBe(false);
  });

  // The bug: a Swift package whose test target failed to compile wrote a
  // summary with every count zero, and was reported as "0 passed / 0 failed"
  // plus a hint about an --only filter the run never had. This is the
  // build-results shape that bundle carried.
  it("is true when zero tests ran because the build under them failed", () => {
    expect(
      testsNeverRan(
        { title: "Test - Ration-UI", totalTestCount: 0 },
        {
          status: "failed",
          errorCount: 2,
          errors: [
            {
              issueType: "Uncategorized",
              message: "Testing cancelled because the build failed.",
            },
            {
              issueType: "Swift Compiler Error",
              message: "Type 'Any' does not conform to the 'Sendable' protocol",
              sourceURL:
                "file:///x/Tests/SpokenSummaryTests.swift#StartingLineNumber=81",
            },
          ],
        },
      ),
    ).toBe(true);
  });

  // The case the zero-count hint exists for: the filter matched nothing and
  // everything compiled, so the summary is the right report.
  it("is false when zero tests ran and nothing failed to compile", () => {
    expect(
      testsNeverRan(
        { totalTestCount: 0 },
        { status: "succeeded", errorCount: 0, errors: [] },
      ),
    ).toBe(false);
    expect(testsNeverRan({ totalTestCount: 0 }, undefined)).toBe(false);
    expect(
      testsNeverRan(
        { totalTestCount: 0 },
        {
          errors: [{ issueType: "Uncategorized", message: "Test run failed." }],
        },
      ),
    ).toBe(false);
  });
});
