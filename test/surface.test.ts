import { describe, expect, it } from "vitest";
import { ACTION_COVERAGE, OPTION_COVERAGE, tally } from "../src/surface.js";

describe("surface coverage map", () => {
  it("classifies every option with a non-empty reason", () => {
    for (const [flag, entry] of Object.entries(OPTION_COVERAGE)) {
      const text = entry.status === "exposed" ? entry.via : entry.why;
      expect(text.length, `${flag} has an empty explanation`).toBeGreaterThan(
        0,
      );
    }
  });

  it("names options exactly as xcodebuild spells them", () => {
    for (const flag of Object.keys(OPTION_COVERAGE)) {
      expect(flag).toMatch(/^-[A-Za-z][A-Za-z0-9-]*$/);
    }
  });

  it("keeps n/a options in the denominator", () => {
    const counts = tally(OPTION_COVERAGE);
    expect(counts.total).toBe(counts.exposed + counts.always + counts.na);
    expect(counts.covered).toBe(counts.exposed + counts.always);
    expect(counts.percent).toBeLessThan(100);
  });

  it("reports a percentage to one decimal place", () => {
    const counts = tally({
      "-a": { status: "exposed", via: "x" },
      "-b": { status: "exposed", via: "x" },
      "-c": { status: "n/a", why: "y" },
    });
    expect(counts.percent).toBe(66.7);
  });

  it("covers every build action except installsrc", () => {
    const counts = tally(ACTION_COVERAGE);
    expect(counts.na).toBe(1);
    expect(ACTION_COVERAGE["installsrc"]?.status).toBe("n/a");
  });
});
