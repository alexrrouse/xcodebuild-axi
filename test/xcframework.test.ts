import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { planXcframework } from "../src/commands/xcframework.js";
import { AxiError } from "../src/errors.js";

let dir: string;
const at = (name: string) => join(dir, name);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "xcframework-"));
  for (const name of ["ios.xcarchive", "sim.xcarchive", "include", "dSYMs"]) {
    mkdirSync(at(name));
  }
  for (const name of ["A.framework", "libA.a", "libB.a"]) {
    writeFileSync(at(name), "");
  }
});

describe("planXcframework", () => {
  it("keeps the order the slices were given in", () => {
    const plan = planXcframework([
      "--archive",
      at("ios.xcarchive"),
      "--framework",
      "MyLib.framework",
      "--debug-symbols",
      at("dSYMs"),
      "--archive",
      at("sim.xcarchive"),
      "--framework",
      "MyLib.framework",
    ]);

    expect(plan.args).toEqual([
      "-archive",
      at("ios.xcarchive"),
      "-framework",
      "MyLib.framework",
      "-debug-symbols",
      at("dSYMs"),
      "-archive",
      at("sim.xcarchive"),
      "-framework",
      "MyLib.framework",
    ]);
    expect(plan).toMatchObject({ frameworks: 2, archives: 2, libraries: 0 });
  });

  /**
   * The pairing xcodebuild does positionally used to be done by index here,
   * which put the first library's headers on the first library whether or not
   * that is the one they were written after.
   */
  it("attaches headers to the library they follow, not the first one", () => {
    const plan = planXcframework([
      "--library",
      at("libA.a"),
      "--library",
      at("libB.a"),
      "--headers",
      at("include"),
    ]);

    expect(plan.args).toEqual([
      "-library",
      at("libA.a"),
      "-library",
      at("libB.a"),
      "-headers",
      at("include"),
    ]);
  });

  it("does not look on disk for a framework named inside an archive", () => {
    const plan = planXcframework([
      "--archive",
      at("ios.xcarchive"),
      "--framework",
      "MyLib.framework",
    ]);
    expect(plan.missing).toEqual([]);
  });

  it("still reports inputs that should be on disk and are not", () => {
    const plan = planXcframework(["--framework", at("Nope.framework")]);
    expect(plan.missing).toEqual([at("Nope.framework")]);
  });

  it("rejects an archive with nothing taken out of it", () => {
    expect(() =>
      planXcframework(["--archive", at("ios.xcarchive")]),
    ).toThrowError(AxiError);
    expect(() =>
      planXcframework([
        "--archive",
        at("ios.xcarchive"),
        "--archive",
        at("sim.xcarchive"),
        "--framework",
        "MyLib.framework",
      ]),
    ).toThrowError(/not followed by a --framework or --library/);
  });

  it("rejects headers that describe nothing", () => {
    expect(() => planXcframework(["--headers", at("include")])).toThrowError(
      /--headers describes the --library before it/,
    );
    expect(() =>
      planXcframework([
        "--framework",
        at("A.framework"),
        "--headers",
        at("include"),
      ]),
    ).toThrowError(/--headers describes the --library before it/);
  });

  it("rejects debug symbols that describe nothing", () => {
    expect(() =>
      planXcframework(["--debug-symbols", at("dSYMs")]),
    ).toThrowError(/--debug-symbols describes the slice before it/);
  });

  it("reads --flag=value the same as --flag value", () => {
    const plan = planXcframework([`--library=${at("libA.a")}`]);
    expect(plan.args).toEqual(["-library", at("libA.a")]);
  });
});
