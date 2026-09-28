import { describe, expect, it } from "vitest";
import {
  landedDevice,
  testsNeverRan,
  testVerdict,
  unmatchedSelectors,
} from "../src/commands/test.js";
import {
  testIdentifierFromURL,
  treeIdentifiers,
  type TestTree,
} from "../src/xcresult.js";

describe("testsNeverRan", () => {
  it("is true with no summary at all", () => {
    expect(testsNeverRan(undefined, undefined)).toBe(true);
    expect(testsNeverRan({}, undefined)).toBe(true);
  });

  it("is false once any test counted", () => {
    expect(testsNeverRan({ totalTestCount: 3 }, undefined)).toBe(false);
  });

  // The bug: a Swift package whose test target failed to compile wrote a
  // summary with every count zero, and was reported as "0 passed / 0 failed"
  // plus a hint about an --only filter the run never had. This is the
  // build-results shape that bundle carried.
  it("is true when zero tests ran because the build under them failed", () => {
    expect(
      testsNeverRan(
        { title: "Test - MyApp", totalTestCount: 0 },
        {
          status: "failed",
          errorCount: 2,
          errors: [
            {
              issueType: "Uncategorized",
              message: "Testing cancelled because the build failed.",
            },
            {
              issueType: "Swift Compiler Error",
              message: "Type 'Any' does not conform to the 'Sendable' protocol",
              sourceURL:
                "file:///x/MyAppTests/CheckoutTests.swift#StartingLineNumber=81",
            },
          ],
        },
      ),
    ).toBe(true);
  });

  // Issue #38: a build that failed for a reason no compiler gave -- another
  // build holding the build database, a source file renamed without
  // regenerating the project. Both shapes as the real bundles recorded them.
  it.each([
    [
      "the build database is locked",
      'unable to attach DB: error: accessing build database "/tmp/dd/Build/Intermediates.noindex/XCBuildData/build.db": database is locked Possibly there are two concurrent builds running in the same filesystem location.',
    ],
    [
      "a source file is missing",
      "Build input file cannot be found: '/tmp/MyApp/Sources/Checkout.swift'. Did you forget to declare this file as an output of a script phase or custom build rule which produces it?",
    ],
  ])("is true when %s", (_, message) => {
    expect(
      testsNeverRan(
        { title: "Test - MyApp", totalTestCount: 0 },
        {
          status: "failed",
          errorCount: 2,
          errors: [
            {
              issueType: "Uncategorized",
              message: "Testing cancelled because the build failed.",
            },
            { issueType: "Error", message },
          ],
        },
      ),
    ).toBe(true);
  });

  // The case the zero-count hint exists for: the filter matched nothing and
  // everything compiled, so the summary is the right report.
  it("is false when zero tests ran and nothing failed to compile", () => {
    expect(
      testsNeverRan(
        { totalTestCount: 0 },
        { status: "succeeded", errorCount: 0, errors: [] },
      ),
    ).toBe(false);
    expect(testsNeverRan({ totalTestCount: 0 }, undefined)).toBe(false);
    expect(
      testsNeverRan(
        { totalTestCount: 0 },
        {
          errors: [{ issueType: "Uncategorized", message: "Test run failed." }],
        },
      ),
    ).toBe(false);
  });
});

const URL = "test://com.apple.xcode/MyApp";

describe("testIdentifierFromURL", () => {
  it("drops the container and keeps the rest verbatim", () => {
    expect(
      testIdentifierFromURL(`${URL}/MyAppTests/CheckoutTests/testTotal`),
    ).toBe("MyAppTests/CheckoutTests/testTotal");
    expect(
      testIdentifierFromURL(`${URL}/MyAppTests/CheckoutSuite/Nested/inner()`),
    ).toBe("MyAppTests/CheckoutSuite/Nested/inner()");
    expect(testIdentifierFromURL(`${URL}/MyAppTests`)).toBe("MyAppTests");
  });

  it("drops a parameterized test's argument hash", () => {
    expect(
      testIdentifierFromURL(
        `${URL}/MyAppTests/CheckoutSuite/discount(value:)?args=6b86b273`,
      ),
    ).toBe("MyAppTests/CheckoutSuite/discount(value:)");
  });

  it("decodes an escaped segment", () => {
    expect(testIdentifierFromURL(`${URL}/MyAppTests/Check%20out`)).toBe(
      "MyAppTests/Check out",
    );
  });

  it("gives nothing for a URL with no test in it", () => {
    expect(testIdentifierFromURL(undefined)).toBeUndefined();
    expect(testIdentifierFromURL(URL)).toBeUndefined();
    expect(testIdentifierFromURL("https://example.com/a/b")).toBeUndefined();
  });
});

/** The shape `xcresulttool get test-results tests` gave for a real run. */
const tree: TestTree = {
  devices: [
    {
      deviceName: "iPhone 17 Pro",
      osVersion: "26.5",
      platform: "iOS Simulator",
    },
  ],
  testNodes: [
    {
      nodeType: "Test Plan",
      name: "MyApp",
      children: [
        {
          nodeType: "Unit test bundle",
          name: "MyAppTests",
          nodeIdentifierURL: `${URL}/MyAppTests`,
          children: [
            {
              nodeType: "Test Suite",
              name: "CheckoutTests",
              nodeIdentifierURL: `${URL}/MyAppTests/CheckoutTests`,
              children: [
                {
                  nodeType: "Test Case",
                  name: "testTotal()",
                  nodeIdentifier: "CheckoutTests/testTotal()",
                  nodeIdentifierURL: `${URL}/MyAppTests/CheckoutTests/testTotal`,
                },
              ],
            },
            {
              nodeType: "Test Suite",
              name: "CheckoutSuite",
              nodeIdentifierURL: `${URL}/MyAppTests/CheckoutSuite`,
              children: [
                {
                  nodeType: "Test Case",
                  name: "discount(value:)",
                  nodeIdentifierURL: `${URL}/MyAppTests/CheckoutSuite/discount(value:)`,
                  children: [
                    {
                      nodeType: "Arguments",
                      name: "1",
                      nodeIdentifierURL: `${URL}/MyAppTests/CheckoutSuite/discount(value:)?args=6b86`,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe("treeIdentifiers", () => {
  it("names every target, suite and test that ran, once each", () => {
    expect(treeIdentifiers(tree)).toEqual([
      "MyAppTests",
      "MyAppTests/CheckoutTests",
      "MyAppTests/CheckoutTests/testTotal",
      "MyAppTests/CheckoutSuite",
      "MyAppTests/CheckoutSuite/discount(value:)",
    ]);
  });

  // A mis-parse would fail every --only as unmatched, so a shape that does
  // not come out as the bundle's own name is "cannot tell", not "nothing".
  it("gives up on URLs in a shape it does not recognise", () => {
    expect(
      treeIdentifiers({
        testNodes: [
          {
            nodeType: "Unit test bundle",
            name: "MyAppTests",
            nodeIdentifierURL: "test://com.apple.xcode/MyAppTests",
          },
        ],
      }),
    ).toBeUndefined();
  });

  // What a run that matched nothing leaves behind.
  it("names nothing when only the plan is there", () => {
    expect(
      treeIdentifiers({
        testNodes: [{ nodeType: "Test Plan", name: "MyApp" }],
      }),
    ).toEqual([]);
  });
});

// Checked against xcodebuild 26: -only-testing is case-sensitive and exact.
// An XCTest method matches with or without `()`; a Swift Testing test only
// with its parentheses; a trailing slash matches nothing.
describe("unmatchedSelectors", () => {
  const ran = treeIdentifiers(tree) ?? [];

  it("names the selectors nothing ran for, and only those", () => {
    expect(
      unmatchedSelectors(
        ["MyAppTests/CheckoutTests", "MyAppTests/NewTests"],
        ran,
      ),
    ).toEqual(["MyAppTests/NewTests"]);
  });

  it("matches a target, a suite, or a test", () => {
    expect(
      unmatchedSelectors(
        [
          "MyAppTests",
          "MyAppTests/CheckoutSuite",
          "MyAppTests/CheckoutTests/testTotal",
          "MyAppTests/CheckoutSuite/discount(value:)",
        ],
        ran,
      ),
    ).toEqual([]);
  });

  it("lets an XCTest method keep its parentheses", () => {
    expect(
      unmatchedSelectors(["MyAppTests/CheckoutTests/testTotal()"], ran),
    ).toEqual([]);
  });

  // Each of these ran zero tests when passed to xcodebuild on its own.
  it("does not stretch a selector the way xcodebuild does not", () => {
    const misses = [
      "MyAppTests/CheckoutSuite/discount",
      "myapptests/checkouttests/testtotal",
      "MyAppTests/CheckoutTests/",
      "CheckoutTests/testTotal",
    ];
    expect(unmatchedSelectors(misses, ran)).toEqual(misses);
  });
});

describe("testVerdict", () => {
  const passing = { totalTestCount: 3, passedTests: 3, failedTests: 0 };
  const ran = treeIdentifiers(tree) ?? [];

  it("passes a run that ran what it was asked to", () => {
    expect(
      testVerdict({
        exitCode: 0,
        summary: passing,
        only: ["MyAppTests/CheckoutTests"],
        identifiers: ran,
      }),
    ).toEqual({ succeeded: true, unmatched: [], ran: 3 });
  });

  // The issue: xcodebuild says TEST SUCCEEDED and exits zero.
  it("fails a run in which no test ran", () => {
    expect(
      testVerdict({
        exitCode: 0,
        summary: { totalTestCount: 0 },
        only: ["MyAppTests/Missing"],
        identifiers: [],
      }),
    ).toEqual({
      succeeded: false,
      reason: "no --only selector matched a test",
      unmatched: ["MyAppTests/Missing"],
      ran: 0,
    });
    expect(
      testVerdict({
        exitCode: 0,
        summary: { totalTestCount: 0 },
        only: [],
        identifiers: undefined,
      }),
    ).toMatchObject({ succeeded: false, reason: "no tests ran" });
  });

  it("fails a run in which one selector of several matched nothing", () => {
    expect(
      testVerdict({
        exitCode: 0,
        summary: passing,
        only: ["MyAppTests/CheckoutTests", "MyAppTests/NewTests"],
        identifiers: ran,
      }),
    ).toMatchObject({
      succeeded: false,
      reason: "1 --only selector matched no test",
      unmatched: ["MyAppTests/NewTests"],
    });
  });

  // A crash or a timeout also leaves tests out of the tree. Calling their
  // selectors misspelled would send the agent after the wrong problem.
  it("does not check selectors on a run that failed or was cut short", () => {
    const failed = testVerdict({
      exitCode: 65,
      summary: { totalTestCount: 3, passedTests: 2, failedTests: 1 },
      only: ["MyAppTests/CheckoutTests", "MyAppUITests/LoginFlow"],
      identifiers: ran,
    });
    expect(failed).toMatchObject({ succeeded: false, unmatched: [] });
    expect(failed.reason).toBeUndefined();

    expect(
      testVerdict({
        exitCode: 65,
        summary: { totalTestCount: 0 },
        only: ["MyAppUITests/LoginFlow"],
        identifiers: [],
      }),
    ).toMatchObject({
      succeeded: false,
      reason: "no tests ran",
      unmatched: [],
    });
  });

  // Nothing to check against is not evidence that something is missing --
  // but the report says the check did not happen.
  it("does not invent a miss when the tree could not be read", () => {
    expect(
      testVerdict({
        exitCode: 0,
        summary: passing,
        only: ["MyAppTests/NewTests"],
        identifiers: undefined,
      }),
    ).toEqual({ succeeded: true, unmatched: [], ran: 3, checked: false });
  });

  it("does not blame a selector whose tests --skip removed", () => {
    expect(
      testVerdict({
        exitCode: 0,
        summary: passing,
        only: ["MyAppTests/CheckoutTests", "MyAppTests/CartTests"],
        skip: ["MyAppTests/CartTests/testEmpty"],
        identifiers: ran,
      }),
    ).toMatchObject({ succeeded: true, unmatched: [] });
  });
});

describe("landedDevice", () => {
  // A run of zero tests lists no device in its summary, which dropped the
  // platform from the report's destination.
  it("falls back to the tree's device when the summary has none", () => {
    expect(landedDevice({ devicesAndConfigurations: [] }, tree)).toEqual(
      tree.devices?.[0],
    );
  });

  it("prefers the summary's device", () => {
    const device = { deviceName: "iPad Air", platform: "iOS Simulator" };
    expect(
      landedDevice({ devicesAndConfigurations: [{ device }] }, tree),
    ).toEqual(device);
  });
});
