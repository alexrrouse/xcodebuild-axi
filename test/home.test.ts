import { describe, expect, it } from "vitest";
import { runKind } from "../src/commands/home.js";

describe("runKind", () => {
  // `runLabel` writes `<scheme>[-<device>]-<command>`, so the trailing segment
  // is the command. This is what keeps a build bundle from being read as a
  // test result.
  it("reads the command off a bundle name", () => {
    expect(runKind("/cache/MyApp-iPhone-17-Pro-26-5-build.xcresult")).toBe(
      "build",
    );
    expect(runKind("/cache/MyApp-iPhone-17-Pro-26-5-test.xcresult")).toBe(
      "test",
    );
    expect(runKind("/cache/MyApp-analyze.xcresult")).toBe("analyze");
  });

  it("handles a scheme with no device slug", () => {
    expect(runKind("/cache/MyApp-build.xcresult")).toBe("build");
  });

  it("falls back rather than returning empty", () => {
    expect(runKind("/cache/.xcresult")).toBe("run");
  });
});
