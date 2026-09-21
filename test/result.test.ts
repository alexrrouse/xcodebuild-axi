import { describe, expect, it } from "vitest";
import { buildFields } from "../src/commands/result.js";

describe("buildFields", () => {
  // The bug this guards: `xcresulttool` answers the test-shaped query for a
  // build bundle too, returning `{title: "Test - X", totalTestCount: 0,
  // result: "unknown"}`. Reporting that rendered a build as a clean-looking
  // test run. A build bundle knows all three of these for real.
  it("reads the action, verdict and device off a build bundle", () => {
    expect(
      buildFields({
        actionTitle: 'Build "MyApp"',
        status: "succeeded",
        destination: {
          deviceName: "iPhone 17 Pro",
          platform: "iOS Simulator",
          osVersion: "26.5",
        },
        startTime: 1000,
        endTime: 1105,
      }),
    ).toEqual({
      result: "succeeded",
      title: 'Build "MyApp"',
      destination: "iPhone 17 Pro · iOS Simulator 26.5",
      duration: "1m45s",
    });
  });

  it("reports a failed build as failed rather than unknown", () => {
    expect(
      buildFields({ actionTitle: 'Build "MyApp"', status: "failed" }),
    ).toMatchObject({ result: "failed", title: 'Build "MyApp"' });
  });

  it("says unknown only when the bundle really is missing the field", () => {
    expect(buildFields({})).toEqual({
      result: "unknown",
      title: "",
      destination: "unknown",
      duration: "unknown",
    });
  });
});
