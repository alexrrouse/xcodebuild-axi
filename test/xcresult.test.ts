import { describe, expect, it } from "vitest";
import {
  failureLocation,
  parseSourceURL,
  relativize,
  toDiagnostics,
  describeDevice,
  buildErrorCount,
  isRestatement,
  meaningfulErrors,
  testTally,
  runTally,
  failedRuns,
  mayHaveRepeated,
  type TestNode,
  type TestTree,
} from "../src/xcresult.js";
import { renderFields } from "../src/toon.js";

describe("parseSourceURL", () => {
  // Xcode's fragment counts from zero. Verified against a real build: a
  // warning reported at StartingLineNumber=165 sits on line 166 of the file.
  it("converts the zero-based line and column to editor numbering", () => {
    const parsed = parseSourceURL(
      "file:///repo/Sources/BotModel.swift#EndingColumnNumber=83&EndingLineNumber=165&StartingColumnNumber=82&StartingLineNumber=165&Timestamp=811608191.09",
    );
    expect(parsed.line).toBe(166);
    expect(parsed.col).toBe(83);
  });

  it("strips the /private prefix macOS puts on temp paths", () => {
    const parsed = parseSourceURL(
      "file:///private/tmp/probe/A.swift#StartingLineNumber=0",
    );
    expect(parsed.file).toBe("/tmp/probe/A.swift");
    expect(parsed.line).toBe(1);
  });

  it("decodes percent-escapes in paths", () => {
    const parsed = parseSourceURL(
      "file:///repo/My%20App/A.swift#StartingLineNumber=4",
    );
    expect(parsed.file).toBe("/repo/My App/A.swift");
  });

  it("returns empty fields rather than throwing on a missing URL", () => {
    expect(parseSourceURL(undefined)).toEqual({ file: "", line: "", col: "" });
  });

  it("handles a URL with no fragment", () => {
    const parsed = parseSourceURL("file:///repo/A.swift");
    expect(parsed).toEqual({ file: "/repo/A.swift", line: "", col: "" });
  });
});

describe("relativize", () => {
  it("shortens paths under the working directory", () => {
    expect(relativize("/repo/Sources/A.swift", "/repo")).toBe(
      "Sources/A.swift",
    );
  });

  it("leaves paths outside it absolute rather than emitting ../..", () => {
    expect(relativize("/elsewhere/A.swift", "/repo")).toBe(
      "/elsewhere/A.swift",
    );
  });
});

describe("toDiagnostics", () => {
  it("drops the repeats a shared file produces once per compiling target", () => {
    const issue = {
      issueType: "Swift Compiler Warning",
      message: "Unused variable",
      sourceURL:
        "file:///repo/A.swift#StartingLineNumber=9&StartingColumnNumber=1",
    };
    expect(toDiagnostics([issue, { ...issue }, { ...issue }])).toHaveLength(1);
  });

  it("keeps diagnostics that differ only by line", () => {
    const at = (line: number) => ({
      issueType: "Swift Compiler Error",
      message: "Bad",
      sourceURL: `file:///repo/A.swift#StartingLineNumber=${line}&StartingColumnNumber=1`,
    });
    expect(toDiagnostics([at(1), at(2)])).toHaveLength(2);
  });

  it("collapses the issue type to one token", () => {
    const [swift] = toDiagnostics([
      { issueType: "Swift Compiler Error", message: "x" },
    ]);
    expect(swift?.type).toBe("swift");
    const [uncategorized] = toDiagnostics([
      { issueType: "Uncategorized", message: "x" },
    ]);
    expect(uncategorized?.type).toBe("xcodebuild");
  });

  it("flattens newlines so a message stays one TOON row", () => {
    const [only] = toDiagnostics([
      { message: "line one\n  line two", issueType: "Swift Compiler Error" },
    ]);
    expect(only?.message).toBe("line one line two");
  });

  it("returns nothing for an absent list", () => {
    expect(toDiagnostics(undefined)).toEqual([]);
  });
});

describe("toDiagnostics in a macro expansion", () => {
  // Real names, from compiling `#expect(items.allSatisfy(\.inStock))` -- a
  // rethrowing call given a key path -- in a MyAppTests target, once at line 7
  // and once as a three-line `#expect(` at line 12.
  const expansion = (module: string, file: string, at: string) =>
    `file:///var/folders/T/swift-generated-sources/@__swiftmacro_${module}${file}fMX${at}6expectfMf_.swift#EndingColumnNumber=2&EndingLineNumber=1&StartingColumnNumber=2&StartingLineNumber=1`;
  const checkout = "0024CheckoutTestsswift_ynAHf";
  const message =
    "Call can throw, but it is not marked with 'try' and the error is not handled";
  const issue = (sourceURL: string, text = message) => ({
    issueType: "Swift Compiler Error",
    message: text,
    sourceURL,
  });
  const origin = (originLine: number, file = "CheckoutTests.swift") => ({
    line: 2,
    col: 3,
    message:
      "call can throw, but it is not marked with 'try' and the error is not handled",
    file: `/repo/Tests/MyAppTests/${file}`,
    originLine,
    originCol: 42,
  });
  const at = (
    diagnostics: { file: string; line: number | ""; col: number | "" }[],
  ) => diagnostics.map(({ file, line, col }) => `${file}:${line}:${col}`);

  it("reports each mistake where its macro starts, not inside the expansion", () => {
    const diagnostics = toDiagnostics(
      [
        issue(expansion("10MyAppTests", checkout, "6_4_")),
        issue(expansion("10MyAppTests", checkout, "11_4_")),
      ],
      [origin(7), origin(14)],
    );
    // Two identical mistakes, each at 2:3 of its own expansion: the macro's
    // line is what keeps them two rows.
    expect(at(diagnostics)).toEqual([
      "/repo/Tests/MyAppTests/CheckoutTests.swift:7:5",
      "/repo/Tests/MyAppTests/CheckoutTests.swift:12:5",
    ]);
    expect(diagnostics[0]?.message).toBe(message);
  });

  it("falls back to the file name when there is no transcript to give a path", () => {
    expect(
      at(toDiagnostics([issue(expansion("10MyAppTests", checkout, "6_4_"))])),
    ).toEqual(["CheckoutTests.swift:7:5"]);
  });

  it("collapses one file compiled into two targets into one row", () => {
    const diagnostics = toDiagnostics(
      [
        issue(expansion("10MyAppTests", checkout, "6_4_")),
        issue(expansion("13MyAppMacTests", checkout, "6_4_")),
      ],
      [origin(7), origin(7)],
    );
    expect(diagnostics).toHaveLength(1);
  });

  it("matches a transcript message that differs in case and carries a group", () => {
    const [only] = toDiagnostics(
      [issue(expansion("10MyAppTests", checkout, "6_4_"))],
      [{ ...origin(7), message: `${origin(7).message} [#ThrowingCall]` }],
    );
    expect(only?.file).toBe("/repo/Tests/MyAppTests/CheckoutTests.swift");
  });

  it("does not borrow the path of a different message at the same position", () => {
    const [only] = toDiagnostics(
      [issue(expansion("10MyAppTests", checkout, "6_4_"))],
      [{ ...origin(7), message: "cannot find 'total' in scope" }],
    );
    expect(only?.file).toBe("CheckoutTests.swift");
  });

  it("keeps the file name when two paths are equally near", () => {
    const [only] = toDiagnostics(
      [issue(expansion("10MyAppTests", checkout, "6_4_"))],
      [
        origin(7),
        { ...origin(7), file: "/repo/Tests/MyAppUITests/CheckoutTests.swift" },
      ],
    );
    expect(only?.file).toBe("CheckoutTests.swift");
  });

  it("keeps two files of one name apart when it cannot tell their paths", () => {
    // CheckoutTests.swift in two targets, one mistake each, no log: the same
    // row twice is a duplicate, but dropping one could lose a real error.
    const diagnostics = toDiagnostics([
      issue(expansion("10MyAppTests", checkout, "6_4_")),
      issue(expansion("12MyAppUITests", checkout, "6_4_")),
    ]);
    expect(at(diagnostics)).toEqual([
      "CheckoutTests.swift:7:5",
      "CheckoutTests.swift:7:5",
    ]);
  });

  it("leaves an attached macro where the bundle put it", () => {
    // Its name carries no position, and a message at 2:3 of some expansion
    // is something any other macro may share.
    const attached =
      "file:///var/folders/T/swift-generated-sources/@__swiftmacro_5MyApp4CartV5StatefMp_.swift#StartingColumnNumber=2&StartingLineNumber=1";
    expect(at(toDiagnostics([issue(attached)], [origin(9)]))).toEqual([
      "/var/folders/T/swift-generated-sources/@__swiftmacro_5MyApp4CartV5StatefMp_.swift:2:3",
    ]);
  });
});

describe("describeDevice", () => {
  it("names the device and the OS it ran", () => {
    expect(
      describeDevice({
        deviceName: "iPhone 17 Pro",
        platform: "iOS Simulator",
        osVersion: "26.5",
      }),
    ).toBe("iPhone 17 Pro · iOS Simulator 26.5");
  });

  it("says unknown rather than emitting an empty field", () => {
    expect(describeDevice(undefined)).toBe("unknown");
  });
});

describe("relativize and /private", () => {
  // On macOS `process.cwd()` inside /tmp reports /private/tmp while the
  // diagnostic's sourceURL may report either. Comparing them raw made every
  // path look outside the tree and stay absolute.
  it("relativizes across the /private prefix", () => {
    expect(relativize("/private/tmp/probe/Sources/A.swift", "/tmp/probe")).toBe(
      "Sources/A.swift",
    );
    expect(relativize("/tmp/probe/Sources/A.swift", "/private/tmp/probe")).toBe(
      "Sources/A.swift",
    );
  });

  it("normalizes even when the file is outside the working directory", () => {
    expect(relativize("/private/tmp/elsewhere/A.swift", "/repo")).toBe(
      "/tmp/elsewhere/A.swift",
    );
  });
});

describe("failureLocation", () => {
  /**
   * The shape a real `xcresulttool get test-results test-details` returns for
   * an XCTAssertEqual written on line 10 — and it reports `lineNumber: 10`,
   * one-based, unlike the zero-based fragment a build diagnostic carries.
   */
  const details = {
    testIdentifier: "CheckoutTests/testTotalIsWrong()",
    testRuns: [
      {
        nodeType: "Device",
        name: "iPhone 17",
        children: [
          {
            nodeType: "Test Plan Configuration",
            name: "Test Scheme Action",
            children: [
              {
                nodeType: "Test Case Run",
                name: "XCTAssertEqual failed",
                result: "Failed",
                sourceLocation: {
                  filePath: "/w/Tests/MyAppTests/CheckoutTests.swift",
                  lineNumber: 10,
                },
                children: [
                  {
                    nodeType: "Source Code Reference",
                    name: "",
                    sourceLocation: {
                      filePath: "/w/Tests/MyAppTests/CheckoutTests.swift",
                      lineNumber: 10,
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  it("reports the line as the file numbers it, without an offset", () => {
    expect(failureLocation(details)).toEqual({
      file: "/w/Tests/MyAppTests/CheckoutTests.swift",
      line: 10,
    });
  });

  it("prefers the deepest reference, which is the assertion itself", () => {
    const nested = {
      testRuns: [
        {
          nodeType: "Test Case Run",
          name: "failed",
          sourceLocation: { filePath: "/w/Case.swift", lineNumber: 4 },
          children: [
            {
              nodeType: "Source Code Reference",
              name: "",
              sourceLocation: {
                filePath: "/w/Assertion.swift",
                lineNumber: 42,
              },
            },
          ],
        },
      ],
    };
    expect(failureLocation(nested)).toEqual({
      file: "/w/Assertion.swift",
      line: 42,
    });
  });

  it("returns nothing rather than guessing when no node carries a location", () => {
    expect(
      failureLocation({ testRuns: [{ nodeType: "Device", name: "x" }] }),
    ).toEqual({ file: "", line: "" });
    expect(failureLocation({})).toEqual({ file: "", line: "" });
  });
});

describe("meaningfulErrors", () => {
  const CANCELLED = {
    issueType: "Uncategorized",
    message: "Testing cancelled because the build failed.",
  };
  const GENERIC = { message: "xcodebuild encountered an error (65)" };
  const CAUSE = {
    issueType: "Error",
    message:
      "Build input file cannot be found: '/tmp/MyApp/Sources/Checkout.swift'. Did you forget to declare this file as an output of a script phase or custom build rule which produces it?",
  };

  // Issue #38: the restatement came first, ahead of the cause.
  it("drops the rows that only say something failed when a cause is there", () => {
    expect(meaningfulErrors([CANCELLED, CAUSE])).toEqual([CAUSE]);
    expect(meaningfulErrors([GENERIC, CAUSE])).toEqual([CAUSE]);
  });

  it("keeps them when there is nothing else to say", () => {
    expect(meaningfulErrors([CANCELLED])).toEqual([CANCELLED]);
    expect(meaningfulErrors([GENERIC])).toEqual([GENERIC]);
    expect(meaningfulErrors(undefined)).toEqual([]);
  });

  it("counts only errors that say something", () => {
    expect(buildErrorCount({ errors: [CANCELLED, CAUSE] })).toBe(1);
    expect(buildErrorCount({ errors: [CANCELLED] })).toBe(0);
    expect(buildErrorCount({ errors: [GENERIC] })).toBe(0);
    expect(buildErrorCount({ errorCount: 3 })).toBe(3);
  });
});

describe("isRestatement", () => {
  it("is true only for rows that say something failed but not why", () => {
    expect(
      isRestatement({ message: "Testing cancelled because the build failed." }),
    ).toBe(true);
    expect(
      isRestatement({ message: "xcodebuild encountered an error (65)" }),
    ).toBe(true);
    expect(isRestatement({ message: "Cannot find 'total' in scope" })).toBe(
      false,
    );
  });
});

describe("testTally", () => {
  it("keeps the three-count line when nothing is an expected failure", () => {
    expect(testTally({ passedTests: 7, failedTests: 1, skippedTests: 2 })).toBe(
      "7 passed / 1 failed / 2 skipped",
    );
  });

  // xcresulttool counts an XCTExpectFailure test in none of the other three,
  // so an 11-test run read as "7 passed" with four tests unaccounted for.
  it("counts expected failures, which are in none of the other three", () => {
    expect(
      testTally({
        passedTests: 7,
        failedTests: 0,
        skippedTests: 0,
        expectedFailures: 4,
      }),
    ).toBe("7 passed / 0 failed / 0 skipped / 4 expected failures");
    expect(testTally({ passedTests: 1, expectedFailures: 1 })).toBe(
      "1 passed / 0 failed / 0 skipped / 1 expected failure",
    );
  });
});

describe("repeated runs", () => {
  // Shapes from real bundles: `--iterations`, `--retry` and
  // `--until-failure` over two XCTest and two Swift Testing tests.
  const url = (id: string) => `test://com.apple.xcode/MyApp/MyAppTests/${id}`;
  const reps = (
    id: string,
    count: number,
    failOn: number[] = [],
    names = (n: number) => `Repetition ${n}`,
  ): TestNode[] =>
    Array.from({ length: count }, (_, index) => {
      const n = index + 1;
      const failed = failOn.includes(n);
      return {
        nodeType: "Repetition",
        name: names(n),
        nodeIdentifier: String(n),
        nodeIdentifierURL: url(id),
        result: failed ? "Failed" : "Passed",
        ...(failed
          ? {
              children: [
                { nodeType: "Failure Message", name: `failed on run ${n}` },
              ],
            }
          : {}),
      };
    });
  const testCase = (
    id: string,
    result: string,
    children: TestNode[] = [],
  ): TestNode => ({
    nodeType: "Test Case",
    name: id.split("/").pop(),
    nodeIdentifier: id,
    nodeIdentifierURL: url(id),
    result,
    duration: "0.28s",
    children,
  });
  const tree = (...cases: TestNode[]): TestTree => ({
    testNodes: [
      {
        nodeType: "Test Plan",
        name: "MyApp",
        children: [
          { nodeType: "Unit test bundle", name: "MyAppTests", children: cases },
        ],
      },
    ],
  });

  const iterations = tree(
    testCase("CheckoutTests/testFlaky", "Failed", reps("x", 10, [4])),
    testCase("CheckoutTests/testSteady", "Passed", reps("x", 10)),
    testCase("CartTests/flaky()", "Failed", reps("x", 10, [7])),
    testCase("CartTests/steady()", "Passed", reps("x", 10)),
  );

  it("counts runs, not tests, and says what they were runs of", () => {
    const runs = runTally(iterations);
    expect(runs).toMatchObject({
      tests: 4,
      runs: 40,
      passed: 38,
      failed: 2,
      iterations: 10,
    });
    expect(testTally({ passedTests: 2, failedTests: 2 }, runs)).toBe(
      "38 passed / 2 failed / 0 skipped (4 tests × 10 iterations)",
    );
  });

  it("never needs TOON quotes", () => {
    for (const runs of [runTally(iterations), runTally(retried)]) {
      expect(renderFields({ tests: testTally({}, runs) })).not.toContain('"');
    }
  });

  it("keeps the iterations when skips and arguments break the product", () => {
    const runs = runTally(
      tree(
        testCase("CheckoutTests/testSteady", "Passed", reps("x", 10)),
        testCase("CheckoutTests/testSkipped", "Skipped"),
        testCase("PriceTests/positive(value:)", "Passed", [
          { nodeType: "Arguments", name: "1", children: reps("x", 10) },
          { nodeType: "Arguments", name: "2", children: reps("x", 10) },
        ]),
      ),
    );
    expect(testTally({}, runs)).toBe(
      "30 passed / 0 failed / 1 skipped (31 runs of 3 tests over 10 iterations)",
    );
  });

  it("counts an expected failure per run", () => {
    const known = testCase(
      "CheckoutTests/testKnown",
      "Expected Failure",
      reps("x", 3).map((rep) => ({ ...rep, result: "Expected Failure" })),
    );
    expect(testTally({}, runTally(tree(known)))).toBe(
      "0 passed / 0 failed / 0 skipped / 3 expected failures (1 test × 3 iterations)",
    );
  });

  // Only the retried test has repetitions, and they are retries.
  const retriedFlaky = testCase(
    "CheckoutTests/testFlaky",
    "Passed",
    reps("x", 2, [1], (n) => (n === 1 ? "First Run" : `Retry ${n - 1}`)),
  );
  const retried = tree(
    retriedFlaky,
    testCase("CheckoutTests/testSteady", "Passed"),
    testCase("CartTests/flaky()", "Passed"),
    testCase("CartTests/steady()", "Passed"),
  );

  it("names a test that passed only on a retry", () => {
    const runs = runTally(retried);
    expect(runs?.passedOnRetry).toEqual(["MyAppTests/CheckoutTests/testFlaky"]);
    expect(testTally({}, runs)).toBe(
      "4 passed / 1 failed / 0 skipped (5 runs of 4 tests)",
    );
  });

  it("does not call retries iterations, even for a single test", () => {
    expect(runTally(tree(retriedFlaky))?.iterations).toBeUndefined();
  });

  it("counts a test that failed the first run of --until-failure as one run", () => {
    const runs = runTally(
      tree(
        testCase("CheckoutTests/testFlaky", "Failed", [
          { nodeType: "Failure Message", name: "failed on run 1" },
        ]),
        testCase("CheckoutTests/testSteady", "Passed", reps("x", 20)),
        testCase("CartTests/flaky()", "Failed", reps("x", 3, [3])),
        testCase("CartTests/steady()", "Passed", reps("x", 20)),
      ),
    );
    expect(runs).toMatchObject({ runs: 44, failed: 2 });
    expect(runs?.iterations).toBeUndefined();
  });

  it("leaves a plain run to the summary", () => {
    expect(
      runTally(tree(testCase("CheckoutTests/testSteady", "Passed"))),
    ).toBeUndefined();
  });

  it("says how many of a failing test's runs failed", () => {
    const runs = runTally(iterations)!;
    expect(
      failedRuns({ testIdentifierURL: url("CheckoutTests/testFlaky") }, runs),
    ).toBe("1/10");
    expect(
      failedRuns(
        { targetName: "MyAppTests", testIdentifierString: "CartTests/flaky()" },
        runs,
      ),
    ).toBe("1/10");
    expect(failedRuns({ testIdentifierURL: url("Gone/testGone") }, runs)).toBe(
      "",
    );
  });

  it("never gives one target's count to a test of the same name in another", () => {
    const runs = runTally(
      tree(testCase("CheckoutTests/testFlaky", "Failed", reps("x", 10, [4]))),
    )!;
    expect(
      failedRuns(
        {
          targetName: "MyAppUITests",
          testIdentifierString: "CheckoutTests/testFlaky",
        },
        runs,
      ),
    ).toBe("");
  });

  it("matches a tree that has no URLs on the identifier it does have", () => {
    const runs = runTally(
      tree({
        nodeType: "Test Case",
        nodeIdentifier: "CheckoutTests/testFlaky()",
        result: "Failed",
        children: reps("x", 10, [4]),
      }),
    )!;
    expect(
      failedRuns(
        {
          testIdentifierURL: url("CheckoutTests/testFlaky"),
          testIdentifierString: "CheckoutTests/testFlaky()",
        },
        runs,
      ),
    ).toBe("1/10");
  });

  it("counts every argument of a parameterized test a retry touched once", () => {
    const runs = runTally(
      tree(
        testCase("PriceTests/positive(value:)", "Passed", [
          { nodeType: "Arguments", name: "1", result: "Passed" },
          {
            nodeType: "Arguments",
            name: "2",
            result: "Passed",
            children: reps("x", 2, [1], (n) =>
              n === 1 ? "First Run" : `Retry ${n - 1}`,
            ),
          },
          { nodeType: "Arguments", name: "3", result: "Passed" },
        ]),
      ),
    );
    expect(runs).toMatchObject({ runs: 4, passed: 3, failed: 1 });
  });

  it("keeps a run with an unrecognised result in the tally", () => {
    const runs = runTally(
      tree(
        testCase("CheckoutTests/testCrash", "Failed", [
          ...reps("x", 2),
          { nodeType: "Repetition", name: "Repetition 3", result: "Unknown" },
        ]),
      ),
    );
    expect(testTally({}, runs)).toBe(
      "2 passed / 0 failed / 0 skipped / 1 other (1 test × 3 iterations)",
    );
  });

  it("reads the tree only when the summary hints at repetitions", () => {
    expect(mayHaveRepeated({ statistics: [] })).toBe(false);
    expect(
      mayHaveRepeated({
        statistics: [
          {
            title: "1 configuration ran with test repetitions",
            subtitle: "40 test runs",
          },
        ],
      }),
    ).toBe(true);
  });

  it("places a repeated failure at the run its message came from", () => {
    // The message is the first failing run's, so the line must be too --
    // not the deepest location of whichever run failed last.
    const at = (line: number): TestNode => ({
      nodeType: "Test Case Run",
      result: "Failed",
      sourceLocation: {
        filePath: "/repo/CheckoutTests.swift",
        lineNumber: line,
      },
      children: [
        {
          nodeType: "Source Code Reference",
          sourceLocation: {
            filePath: "/repo/CheckoutTests.swift",
            lineNumber: line,
          },
        },
      ],
    });
    const location = failureLocation({
      testRuns: [
        { nodeType: "Repetition", result: "Failed", children: [at(8)] },
        { nodeType: "Repetition", result: "Passed" },
        { nodeType: "Repetition", result: "Failed", children: [at(12)] },
      ],
    });
    expect(location.line).toBe(8);
  });

  it("falls back to any run's location when the first failure has none", () => {
    // A run that crashed records no assertion; a later one may.
    const location = failureLocation({
      testRuns: [
        { nodeType: "Repetition", result: "Failed" },
        {
          nodeType: "Repetition",
          result: "Failed",
          children: [
            {
              nodeType: "Test Case Run",
              sourceLocation: {
                filePath: "/repo/CheckoutTests.swift",
                lineNumber: 12,
              },
            },
          ],
        },
      ],
    });
    expect(location.line).toBe(12);
  });
});
