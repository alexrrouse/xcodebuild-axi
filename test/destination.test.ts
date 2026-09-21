import { describe, expect, it } from "vitest";
import {
  destinationSlug,
  parseDestinationLine,
  pickDefault,
  type Destination,
} from "../src/destination.js";

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
      parseDestinationLine("Available destinations for the MyApp scheme:"),
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

describe("pickDefault", () => {
  const destination = (
    platform: string,
    name: string,
    os: string,
  ): Destination => ({
    platform,
    name,
    os,
    id: `${name}-${os}`,
    eligible: true,
  });

  it("prefers iOS even when another platform has a higher OS number", () => {
    // The shape a cross-platform Swift package reports.
    const picked = pickDefault([
      destination("watchOS Simulator", "Apple Watch SE 3 (40mm)", "26.5"),
      destination("iOS Simulator", "iPhone 17 Pro", "26.4"),
    ]);
    expect(picked.name).toBe("iPhone 17 Pro");
  });

  it("takes the newest OS within the preferred platform", () => {
    const picked = pickDefault([
      destination("iOS Simulator", "iPhone 17", "26.2"),
      destination("iOS Simulator", "iPhone 17 Pro", "26.5"),
    ]);
    expect(picked.os).toBe("26.5");
  });

  it("falls back to hardware only when no simulator is eligible", () => {
    const picked = pickDefault([destination("iOS", "My iPhone", "26.5")]);
    expect(picked.name).toBe("My iPhone");
  });

  it("breaks a same-OS tie toward an iPhone", () => {
    const picked = pickDefault([
      destination("iOS Simulator", "iPad (A16)", "26.5"),
      destination("iOS Simulator", "iPhone 17 Pro", "26.5"),
    ]);
    expect(picked.name).toBe("iPhone 17 Pro");
  });

  it("still takes the newest OS over the device tiebreak", () => {
    const picked = pickDefault([
      destination("iOS Simulator", "iPad (A16)", "26.5"),
      destination("iOS Simulator", "iPhone 17 Pro", "26.2"),
    ]);
    expect(picked.name).toBe("iPad (A16)");
  });

  it("ranks an unknown platform after the ones it knows", () => {
    const picked = pickDefault([
      destination("someOS Simulator", "Future Device", "99.0"),
      destination("watchOS Simulator", "Apple Watch", "26.5"),
    ]);
    expect(picked.name).toBe("Apple Watch");
  });
});
