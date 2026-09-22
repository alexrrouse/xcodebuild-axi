import { describe, expect, it } from "vitest";
import {
  ACTION_COVERAGE,
  COMPANION_SURFACES,
  EXPORT_OPTION_COVERAGE,
  FORM_COVERAGE,
  OPTION_COVERAGE,
  SURFACES,
  XCFRAMEWORK_COVERAGE,
  applicable,
  describe as describeEntry,
  reach,
  tally,
  type OptionCoverage,
} from "../src/surface.js";
import { COMMAND_FLAGS, COMMAND_HELP } from "../src/cli.js";

const EVERY_MAP: Record<string, Record<string, OptionCoverage>> = {
  options: OPTION_COVERAGE,
  actions: ACTION_COVERAGE,
  forms: FORM_COVERAGE,
  "export options": EXPORT_OPTION_COVERAGE,
  xcframework: XCFRAMEWORK_COVERAGE,
  ...COMPANION_SURFACES,
};

/** The `--flags` a `via` string claims, e.g. `test --parallel / --no-parallel`. */
function flagsIn(via: string): string[] {
  return via.split(/\s+/).filter((word) => word.startsWith("--"));
}

describe("surface coverage map", () => {
  it("classifies every option with a non-empty reason", () => {
    for (const [surface, map] of Object.entries(EVERY_MAP)) {
      for (const [key, entry] of Object.entries(map)) {
        expect(
          describeEntry(entry).length,
          `${surface} '${key}' has an empty explanation`,
        ).toBeGreaterThan(0);
      }
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
      counts.exposed +
        counts.always +
        counts.superseded +
        counts.missing +
        counts.na,
    );
    expect(counts.covered).toBe(
      counts.exposed + counts.always + counts.superseded,
    );
  });

  it("charges the percentage for anything left unwrapped", () => {
    const counts = tally({
      "-a": { status: "exposed", on: [{ command: "build", via: "build" }] },
      "-b": { status: "n/a", why: "y" },
    });
    expect(counts.percent).toBe(50);
  });

  it("charges the percentage for a known gap too", () => {
    const counts = tally({
      "-a": { status: "exposed", on: [{ command: "build", via: "build" }] },
      "-b": { status: "missing", why: "not yet" },
    });
    expect(counts.percent).toBe(50);
  });

  it("reports a percentage to one decimal place", () => {
    const counts = tally({
      "-a": { status: "exposed", on: [{ command: "build", via: "build" }] },
      "-b": { status: "superseded", why: "y" },
      "-c": { status: "n/a", why: "y" },
    });
    expect(counts.percent).toBe(66.7);
  });

  /**
   * The `via` strings are what the README prints as the answer to "how do I
   * reach this?". A `via` naming a command that does not exist, or a flag that
   * command would reject, is a README that lies — and this is the check that
   * would have caught `settings` quietly not taking `--target`.
   */
  it("names a real command in every exposed mapping", () => {
    for (const [surface, map] of Object.entries(EVERY_MAP)) {
      for (const [key, entry] of Object.entries(map)) {
        if (entry.status !== "exposed") continue;
        for (const exposure of entry.on) {
          expect(
            Object.keys(COMMAND_HELP),
            `${surface} '${key}' maps to '${exposure.via}'`,
          ).toContain(exposure.command);
        }
      }
    }
  });

  it("names flags the command actually accepts", () => {
    for (const [surface, map] of Object.entries(EVERY_MAP)) {
      for (const [key, entry] of Object.entries(map)) {
        if (entry.status !== "exposed") continue;
        for (const exposure of entry.on) {
          for (const flag of flagsIn(exposure.via)) {
            expect(
              COMMAND_FLAGS[exposure.command],
              `${surface} '${key}' maps to '${exposure.via}' but \`${exposure.command}\` would reject ${flag}`,
            ).toContain(flag);
          }
        }
      }
    }
  });

  it("names flags that command's help documents", () => {
    for (const [surface, map] of Object.entries(EVERY_MAP)) {
      for (const [key, entry] of Object.entries(map)) {
        if (entry.status !== "exposed") continue;
        for (const exposure of entry.on) {
          for (const flag of flagsIn(exposure.via)) {
            expect(
              COMMAND_HELP[exposure.command],
              `${surface} '${key}' maps to '${exposure.via}' but \`${exposure.command} --help\` never mentions ${flag}`,
            ).toContain(flag);
          }
        }
      }
    }
  });

  /**
   * The point of the matrix: an option declares the commands it applies to,
   * and every one of them is either reached, declined with a reason, or
   * recorded as a gap. Silence is the state that used to ship.
   */
  it("accounts for every command an option applies to", () => {
    for (const [option, entry] of Object.entries(OPTION_COVERAGE)) {
      if (entry.status !== "exposed" || entry.surface === undefined) continue;

      const reached = entry.on.map((exposure) => exposure.command);
      const spoken = new Set([
        ...reached,
        ...(entry.declined ?? []).map((item) => item.command),
        ...(entry.missing ?? []).map((item) => item.command),
      ]);

      for (const command of SURFACES[entry.surface]) {
        expect(
          [...spoken],
          `${option} applies to \`${command}\` (surface '${entry.surface}') and the map says nothing about it`,
        ).toContain(command);
      }
    }
  });

  it("does not both reach and miss the same command", () => {
    for (const [option, entry] of Object.entries(OPTION_COVERAGE)) {
      if (entry.status !== "exposed") continue;
      // A command may appear twice in `on` — `platforms download` and
      // `platforms component download` both reach `-exportPath` — but a
      // command it reaches is not also a command it misses.
      const reached = new Set(entry.on.map((exposure) => exposure.command));
      const unreached = [
        ...(entry.declined ?? []).map((item) => item.command),
        ...(entry.missing ?? []).map((item) => item.command),
      ];
      for (const command of unreached) {
        expect(
          [...reached],
          `${option} both reaches and misses \`${command}\``,
        ).not.toContain(command);
      }
      expect(
        new Set(unreached).size,
        `${option} lists \`${unreached.join(", ")}\` as a gap more than once`,
      ).toBe(unreached.length);
      expect(applicable(entry).length).toBe(reached.size + unreached.length);
    }
  });

  it("explains every gap", () => {
    for (const [option, entry] of Object.entries(OPTION_COVERAGE)) {
      if (entry.status !== "exposed") continue;
      for (const item of [
        ...(entry.missing ?? []),
        ...(entry.declined ?? []),
      ]) {
        expect(
          item.why.length,
          `${option} on \`${item.command}\` has an empty reason`,
        ).toBeGreaterThan(0);
        expect(Object.keys(COMMAND_HELP)).toContain(item.command);
      }
    }
  });

  it("counts reach as one pair per command", () => {
    const counted = reach({
      "-a": {
        status: "exposed",
        on: [
          { command: "build", via: "build --a" },
          { command: "test", via: "test --a" },
        ],
        missing: [{ command: "clean", why: "not yet" }],
      },
    });
    expect(counted).toMatchObject({ pairs: 3, reached: 2, missing: 1 });
    expect(counted.percent).toBe(66.7);
  });

  it("covers every build action except installsrc", () => {
    const counts = tally(ACTION_COVERAGE);
    expect(counts.na).toBe(1);
    expect(ACTION_COVERAGE["installsrc"]?.status).toBe("n/a");
  });
});
