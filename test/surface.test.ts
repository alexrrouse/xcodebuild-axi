import { describe, expect, it } from "vitest";
import { ACTION_COVERAGE, OPTION_COVERAGE, tally } from "../src/surface.js";
import { COMMAND_HELP } from "../src/cli.js";

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

  it("accounts for every option exactly once", () => {
    const counts = tally(OPTION_COVERAGE);
    expect(counts.total).toBe(
      counts.exposed + counts.always + counts.superseded + counts.na,
    );
    expect(counts.covered).toBe(
      counts.exposed + counts.always + counts.superseded,
    );
  });

  it("charges the percentage for anything left unwrapped", () => {
    const counts = tally({
      "-a": { status: "exposed", via: "x" },
      "-b": { status: "n/a", why: "y" },
    });
    expect(counts.percent).toBe(50);
  });

  it("reports a percentage to one decimal place", () => {
    const counts = tally({
      "-a": { status: "exposed", via: "x" },
      "-b": { status: "superseded", why: "y" },
      "-c": { status: "n/a", why: "y" },
    });
    expect(counts.percent).toBe(66.7);
  });

  /**
   * The `via` strings are what the README prints as the answer to "how do I
   * reach this flag?". A `via` naming a command that does not exist, or a flag
   * that command would reject, is a README that lies.
   */
  it("names a real command in every exposed mapping", () => {
    for (const [option, entry] of Object.entries(OPTION_COVERAGE)) {
      if (entry.status !== "exposed") continue;
      const command = entry.via.split(/\s+/)[0] as string;
      expect(
        Object.keys(COMMAND_HELP),
        `${option} maps to '${entry.via}'`,
      ).toContain(command);
    }
  });

  it("names a flag that command's help actually documents", () => {
    for (const [option, entry] of Object.entries(OPTION_COVERAGE)) {
      if (entry.status !== "exposed") continue;
      const [command, ...rest] = entry.via.split(/\s+/);
      const flag = rest.find((word) => word.startsWith("--"));
      if (flag === undefined) continue;
      expect(
        COMMAND_HELP[command as string],
        `${option} maps to '${entry.via}' but ${command} --help never mentions ${flag}`,
      ).toContain(flag);
    }
  });

  it("covers every build action except installsrc", () => {
    const counts = tally(ACTION_COVERAGE);
    expect(counts.na).toBe(1);
    expect(ACTION_COVERAGE["installsrc"]?.status).toBe("n/a");
  });
});
