import { describe, expect, it } from "vitest";
import { destinationSlug, parseDestinationLine } from "../src/destination.js";

describe("parseDestinationLine", () => {
  it("reads a simulator row", () => {
    const parsed = parseDestinationLine(
      "\t\t{ platform:iOS Simulator, arch:arm64, id:55D87B92-69D0-46C0-8EB0-DD68E2C5C103, OS:26.5, name:iPad (A16) }",
    );
    expect(parsed).toEqual({
      platform: "iOS Simulator",
      arch: "arm64",
      id: "55D87B92-69D0-46C0-8EB0-DD68E2C5C103",
      os: "26.5",
      name: "iPad (A16)",
      eligible: true,
    });
  });

  // Device names carry spaces and parentheses, so the fields cannot be split
  // on commas alone.
  it("keeps a name containing spaces and parentheses intact", () => {
    expect(
      parseDestinationLine(
        "{ platform:iOS Simulator, name:Apple Watch Series 11 (46mm) }",
      )?.name,
    ).toBe("Apple Watch Series 11 (46mm)");
  });

  it("reads a placeholder row, which the caller filters out by id", () => {
    const parsed = parseDestinationLine(
      "{ platform:iOS, id:dvtdevice-DVTiPhonePlaceholder-iphoneos:placeholder, name:Any iOS Device }",
    );
    expect(parsed?.id).toContain("placeholder");
  });

  it("ignores lines that are not destination rows", () => {
    expect(
      parseDestinationLine("Available destinations for the Tides scheme:"),
    ).toBeUndefined();
    expect(parseDestinationLine("")).toBeUndefined();
  });
});

describe("destinationSlug", () => {
  it("makes a filename-safe stem", () => {
    expect(destinationSlug("iPad Pro 11-inch (M5) · 26.5")).toBe(
      "iPad-Pro-11-inch-M5-26-5",
    );
  });
});
