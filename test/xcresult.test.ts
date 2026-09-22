import { describe, expect, it } from "vitest";
import {
  failureLocation,
  parseSourceURL,
  relativize,
  toDiagnostics,
  describeDevice,
} from "../src/xcresult.js";

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
