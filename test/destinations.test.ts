import { describe, expect, it } from "vitest";
import { collapse, variantHelp } from "../src/commands/destinations.js";
import type { Destination } from "../src/destination.js";

/** The four rows xcodebuild really returns for one Mac, plus a simulator. */
const mac = (variant: string): Destination => ({
  platform: "macOS",
  name: "My Mac",
  id: "00008112-000539543488C01E",
  os: "",
  arch: "arm64",
  variant,
  eligible: true,
});

const simulator: Destination = {
  platform: "iOS Simulator",
  name: "iPhone 17 Pro",
  id: "55D87B92-69D0-46C0-8EB0-DD68E2C5C103",
  os: "26.5",
  arch: "arm64",
  variant: "",
  eligible: true,
};

describe("collapse", () => {
  it("folds rows that print identically", () => {
    expect(
      collapse([
        { name: "My Mac", platform: "macOS", os: "" },
        { name: "My Mac", platform: "macOS", os: "" },
        { name: "My Mac", platform: "macOS", os: "" },
      ]),
    ).toEqual([{ name: "My Mac", platform: "macOS", os: "" }]);
  });

  it("keeps the same device on two runtimes apart", () => {
    expect(
      collapse([
        { name: "iPhone 17 Pro", platform: "iOS Sim", os: "26.5" },
        { name: "iPhone 17 Pro", platform: "iOS Sim", os: "26.4" },
      ]),
    ).toHaveLength(2);
  });

  it("keeps an eligible and an ineligible row apart under --all", () => {
    expect(
      collapse([
        { name: "My Mac", platform: "macOS", os: "", eligible: "yes" },
        { name: "My Mac", platform: "macOS", os: "", eligible: "no" },
      ]),
    ).toHaveLength(2);
  });

  it("preserves the order xcodebuild reported", () => {
    const rows = collapse([
      { name: "b", platform: "macOS", os: "" },
      { name: "a", platform: "macOS", os: "" },
      { name: "b", platform: "macOS", os: "" },
    ]);
    expect(rows.map((row) => row["name"])).toEqual(["b", "a"]);
  });
});

describe("variantHelp", () => {
  // The collapsed rows stop naming the variants, so help[] has to.
  it("names every variant of a device once", () => {
    const help = variantHelp([
      mac(""),
      mac("Mac Catalyst"),
      mac("DriverKit"),
      mac("Designed for [iPad,iPhone]"),
    ]);
    expect(help).toHaveLength(1);
    expect(help[0]).toContain(
      "My Mac also builds as Mac Catalyst, DriverKit, Designed for [iPad,iPhone]",
    );
  });

  // --device cannot reach a variant, so the line has to show the spelling
  // --destination wants.
  it("shows a specifier the caller can paste", () => {
    expect(variantHelp([mac("Mac Catalyst")])[0]).toContain(
      "--destination 'platform=macOS,variant=Mac Catalyst'",
    );
  });

  it("says nothing when no destination has a variant", () => {
    expect(variantHelp([simulator, mac("")])).toEqual([]);
  });
});
