import { describe, expect, it } from "vitest";
import { stripPreamble } from "../src/xcodebuild.js";

describe("stripPreamble", () => {
  // Every xcodebuild invocation reprints this, including the read-only ones.
  // In a workspace with 16 local packages it is ~1.2 KB in front of a
  // 349-byte answer.
  it("removes the invocation echo and the resolved package list", () => {
    const raw = [
      "Command line invocation:",
      "    /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -list",
      "",
      "Resolve Package Graph",
      "",
      "",
      "Resolved source packages:",
      "  MyApp-Data: /repo/MyApp/MyApp-Data",
      "  Common: /repo/Shared/Common @ local",
      "",
      'Information about workspace "MyApps":',
      "    Schemes:",
      "        MyApp",
    ].join("\n");

    expect(stripPreamble(raw)).toBe(
      [
        'Information about workspace "MyApps":',
        "    Schemes:",
        "        MyApp",
      ].join("\n"),
    );
  });

  it("drops xcodebuild's timestamped IDE log lines", () => {
    const raw =
      "2026-09-20 20:14:23.676 xcodebuild[36237:34477191] [MT] IDERunDestination: empty.\nreal output";
    expect(stripPreamble(raw)).toBe("real output");
  });

  it("leaves output with no preamble alone", () => {
    expect(stripPreamble("just this")).toBe("just this");
  });
});
