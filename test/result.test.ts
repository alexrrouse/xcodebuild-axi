import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildFields,
  deltaField,
  failureDeltaRows,
  flattenTests,
  manifestRows,
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

// Each of these refusals is a narrowing that changes what comes out of the
// bundle. Dropping one silently would answer a question nobody asked --
// a diagnostics export that ignored --test would look like the per-test report
// it is not.
describe("result --export", () => {
  const bundle = "/tmp/MyApps-1a2b3c4d/MyApp.xcresult";

  it("names what can be exported", async () => {
    await expect(
      resultCommand([bundle, "--export", "screenshots"]),
    ).rejects.toThrow(/Nothing named 'screenshots'/);
  });

  it("refuses --filter for an export with no filenames to match", async () => {
    await expect(
      resultCommand([bundle, "--export", "diagnostics", "--filter", "*.png"]),
    ).rejects.toThrow(/--filter narrows attachments/);
  });

  it("refuses --test for a report that covers the whole run", async () => {
    await expect(
      resultCommand([
        bundle,
        "--export",
        "diagnostics",
        "--test",
        "MyAppTests/CheckoutTests",
      ]),
    ).rejects.toThrow(/covers the whole run, not one test/);
  });

  it("refuses --failures where nothing is per-failure", async () => {
    await expect(
      resultCommand([bundle, "--export", "metrics", "--failures"]),
    ).rejects.toThrow(/--failures narrows an export/);
  });
});

describe("manifestRows", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
    created.length = 0;
  });

  function withManifest(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), "axi-export-"));
    created.push(dir);
    writeFileSync(join(dir, "manifest.json"), contents);
    return dir;
  }

  // The exported filename is a UUID; the test it belongs to is the only thing
  // that makes it findable, and it lives in the manifest rather than on disk.
  it("ties each exported file back to the test that made it", () => {
    const dir = withManifest(
      JSON.stringify([
        {
          testIdentifier: "MyAppTests/CheckoutTests/testTotal",
          attachments: [
            {
              exportedFileName: "1A2B3C4D.png",
              suggestedHumanReadableName: "Checkout screen",
              isAssociatedWithFailure: true,
            },
          ],
        },
      ]),
    );

    expect(manifestRows(dir, "attachments")).toEqual([
      {
        test: "MyAppTests/CheckoutTests/testTotal",
        file: "1A2B3C4D.png",
        name: "Checkout screen",
        failure: true,
      },
    ]);
  });

  // A metrics manifest names files rather than attachments, and carries no
  // failure column -- a measurement is not associated with one.
  it("reads a metrics manifest, which has a different shape", () => {
    const dir = withManifest(
      JSON.stringify([
        {
          testIdentifier: "MyAppTests/CheckoutTests/testScrolling",
          metricsFiles: ["clock-time.csv", "memory.csv"],
        },
      ]),
    );

    expect(manifestRows(dir, "metrics")).toEqual([
      {
        test: "MyAppTests/CheckoutTests/testScrolling",
        file: "clock-time.csv",
      },
      { test: "MyAppTests/CheckoutTests/testScrolling", file: "memory.csv" },
    ]);
  });

  it("says nothing rather than throwing on a manifest it cannot read", () => {
    expect(manifestRows(withManifest("not json"), "attachments")).toEqual([]);
    expect(manifestRows("/tmp/does-not-exist-axi", "attachments")).toEqual([]);
  });
});

describe("result --against", () => {
  const bundle = "/tmp/MyApps-1a2b3c4d/MyApp.xcresult";

  it("needs the baseline to compare with", async () => {
    await expect(resultCommand([bundle, "--against"])).rejects.toThrow(
      /--against requires a value/,
    );
  });

  // Both the level and the direction, because neither answers on its own:
  // "2 warnings" hides that one is new, and "+1" hides that there are now
  // two. A CI check reads the middle number; a human reads the ends.
  it("says both where a count landed and how it moved", () => {
    expect(
      deltaField({
        itemsInBaseline: 1,
        itemsInCurrent: 2,
        introduced: 2,
        resolved: 1,
      }),
    ).toBe("1 → 2 (+2 -1)");
  });

  it("reads an absent delta as no change rather than as unknown", () => {
    expect(deltaField(undefined)).toBe("0 → 0 (+0 -0)");
  });

  // The identifier is what `test --only` takes, so it is what a rerun needs;
  // the display name is only a fallback for a bundle that carries no id.
  it("names a newly failing test by its identifier", () => {
    expect(
      failureDeltaRows([
        {
          associatedTest: {
            name: "testTotal()",
            testIdentifier: "MyAppTests/CheckoutTests/testTotal",
          },
          failureMessage: "XCTAssertEqual failed",
        },
        { associatedTest: { name: "testTax()" } },
      ]),
    ).toEqual([
      {
        test: "MyAppTests/CheckoutTests/testTotal",
        message: "XCTAssertEqual failed",
      },
      { test: "testTax()", message: "" },
    ]);
  });
});

describe("result --merge", () => {
  it("refuses to merge one bundle with nothing", async () => {
    await expect(
      resultCommand(["/tmp/MyApps-1a2b3c4d/MyApp.xcresult", "--merge"]),
    ).rejects.toThrow(/combines two or more bundles/);
  });
});
