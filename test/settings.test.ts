import { describe, expect, it } from "vitest";
import { platformOf } from "../src/commands/settings.js";

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
