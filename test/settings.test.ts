import { describe, expect, it } from "vitest";
import { platformOf, xcodebuildComplaint } from "../src/commands/settings.js";

describe("platformOf", () => {
  // These settings are destination-dependent: BUILT_PRODUCTS_DIR resolves to
  // Debug-iphoneos with no destination and Debug-iphonesimulator with one.
  // Naming the platform is what keeps the answer from being read as the
  // simulator build that `build` and `test` default to.
  it("names the platform the answer is for", () => {
    expect(platformOf({ PLATFORM_NAME: "iphonesimulator" })).toEqual({
      platform: "iphonesimulator",
    });
  });

  it("stays out of the report when the setting is absent", () => {
    expect(platformOf({})).toEqual({});
    expect(platformOf({ PLATFORM_NAME: "" })).toEqual({});
    expect(platformOf({ PLATFORM_NAME: 42 })).toEqual({});
  });
});

describe("xcodebuildComplaint", () => {
  // A rejected flag combination exits non-zero and still prints an empty JSON
  // document, so without the reason the report is "every key unset" -- the
  // shape of a correct answer.
  it("lifts xcodebuild's own reason out of the noise", () => {
    const stderr = [
      "2026-09-21 20:19:44.284 xcodebuild[44786:36828145] Writing error result bundle to /tmp/x.xcresult",
      "xcodebuild: error: The flag -scheme, -testProductsPath, or -xctestrun is required when specifying -derivedDataPath.",
    ].join("\n");
    expect(xcodebuildComplaint(stderr)).toEqual([
      "The flag -scheme, -testProductsPath, or -xctestrun is required when specifying -derivedDataPath.",
    ]);
  });

  it("says nothing when xcodebuild did not", () => {
    expect(xcodebuildComplaint("")).toEqual([]);
    expect(xcodebuildComplaint("note: something unrelated\n")).toEqual([]);
  });
});
