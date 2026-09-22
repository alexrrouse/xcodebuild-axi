import { describe, expect, it } from "vitest";
import {
  coverageCommand,
  movement,
  uncoveredRanges,
} from "../src/commands/coverage.js";

describe("uncoveredRanges", () => {
  // One row per line is what xccov already prints and what nobody reads: a
  // 400-line file is 400 rows to find the eight that matter. Consecutive
  // uncovered lines are one gap, and that is how a reader thinks of them.
  it("collapses consecutive uncovered lines into one range", () => {
    expect(
      uncoveredRanges([
        { line: 5, isExecutable: true, executionCount: 1 },
        { line: 8, isExecutable: true, executionCount: 0 },
        { line: 9, isExecutable: true, executionCount: 0 },
        { line: 10, isExecutable: true, executionCount: 0 },
        { line: 14, isExecutable: true, executionCount: 2 },
        { line: 20, isExecutable: true, executionCount: 0 },
      ]),
    ).toEqual([
      { lines: "8-10", count: 3 },
      { lines: "20", count: 1 },
    ]);
  });

  it("says nothing when every line ran", () => {
    expect(
      uncoveredRanges([{ line: 1, isExecutable: true, executionCount: 3 }]),
    ).toEqual([]);
  });
});

describe("movement", () => {
  // Words rather than a signed percentage: TOON quotes any scalar starting
  // with `-`, and the quotes cost more than the word saves.
  it("names the direction without a leading minus", () => {
    expect(movement(-0.455)).toBe("down 45.5%");
    expect(movement(0.021)).toBe("up 2.1%");
    expect(movement(0)).toBe("unchanged");
  });
});

// These refusals run before any subprocess, so a bad invocation costs an
// error rather than an xccov that fails on its own terms.
describe("coverage modes", () => {
  const bundle = "/tmp/MyApps-1a2b3c4d/MyApp.xcresult";

  it("refuses two coverage questions at once", async () => {
    await expect(
      coverageCommand([bundle, "--functions", "Checkout.swift", "--merge"]),
    ).rejects.toThrow(/ask different questions/);
  });

  it("refuses to merge one run with nothing", async () => {
    await expect(coverageCommand([bundle, "--merge"])).rejects.toThrow(
      /combines the coverage of two or more runs/,
    );
  });
});
