import { describe, expect, it } from "vitest";
import { prettyRuntime } from "../src/simctl.js";

describe("prettyRuntime", () => {
  it("turns a runtime identifier into something readable", () => {
    expect(prettyRuntime("com.apple.CoreSimulator.SimRuntime.iOS-26-5")).toBe(
      "iOS 26.5",
    );
    expect(
      prettyRuntime("com.apple.CoreSimulator.SimRuntime.watchOS-11-0"),
    ).toBe("watchOS 11.0");
  });

  it("leaves an identifier it does not recognise alone", () => {
    expect(prettyRuntime("something-else")).toBe("something-else");
  });
});
