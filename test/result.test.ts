import { describe, expect, it } from "vitest";
import {
  buildFields,
  flattenTests,
  resultCommand,
} from "../src/commands/result.js";

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

describe("flattenTests", () => {
  // Xcode nests plan -> target -> suite -> case. Only the leaves are tests;
  // the branches carry names that look like tests and verdicts that aggregate
  // them, so counting every node would report a 3-test run as 9 tests.
  it("keeps the leaves and drops the branches", () => {
    const rows = flattenTests([
      {
        nodeType: "Test Plan",
        name: "MyApp",
        result: "Failed",
        children: [
          {
            nodeType: "Unit test bundle",
            name: "MyAppTests",
            children: [
              {
                nodeType: "Test Suite",
                name: "CheckoutTests",
                children: [
                  {
                    nodeType: "Test Case",
                    name: "testTotal()",
                    nodeIdentifier: "MyAppTests/CheckoutTests/testTotal",
                    result: "Passed",
                    duration: "0.1s",
                  },
                  {
                    nodeType: "Test Case",
                    name: "testTax()",
                    nodeIdentifier: "MyAppTests/CheckoutTests/testTax",
                    result: "Failed",
                    duration: "0.2s",
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);

    expect(rows).toEqual([
      {
        test: "MyAppTests/CheckoutTests/testTotal",
        result: "passed",
        duration: "0.1s",
      },
      {
        test: "MyAppTests/CheckoutTests/testTax",
        result: "failed",
        duration: "0.2s",
      },
    ]);
  });

  // The identifier is what `--only` and `--activities --test` take. A node
  // that has none falls back to the display name rather than to an empty row.
  it("falls back to the display name when there is no identifier", () => {
    expect(
      flattenTests([{ nodeType: "Test Case", name: "testTotal()" }]),
    ).toEqual([{ test: "testTotal()", result: "", duration: "" }]);
  });

  it("answers nothing for a bundle with no tests", () => {
    expect(flattenTests(undefined)).toEqual([]);
    expect(flattenTests([])).toEqual([]);
  });
});

// Each guard here runs before the subprocess does, so a bad invocation costs
// an error rather than a two-second `xcresulttool` that fails on its own terms.
describe("result read modes", () => {
  const bundle = "/tmp/MyApps-1a2b3c4d/MyApp.xcresult";

  it("refuses two reads at once", async () => {
    await expect(
      resultCommand([bundle, "--tests", "--metadata"]),
    ).rejects.toThrow(/ask different questions/);
  });

  it("asks which test an activity trail is for", async () => {
    await expect(resultCommand([bundle, "--activities"])).rejects.toThrow(
      /--activities is about one test/,
    );
  });

  it("names the log types it knows", async () => {
    await expect(
      resultCommand([bundle, "--log", "transcript"]),
    ).rejects.toThrow(/Unknown log type 'transcript'/);
  });
});
