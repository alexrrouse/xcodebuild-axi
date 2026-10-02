import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeSwiftPunycode,
  parseMacroExpansionName,
  parseMacroOrigins,
  readMacroOrigins,
} from "../src/macro.js";

// Every name and transcript line here is real output, from compiling
// `#expect(items.allSatisfy(\.inStock))` in a MyAppTests target.
const NAME =
  "/var/folders/T/swift-generated-sources/@__swiftmacro_10MyAppTests0024CheckoutTestsswift_ynAHffMX6_4_6expectfMf_.swift";

const TRANSCRIPT = `SwiftCompile normal arm64 Compiling\\ CheckoutTests.swift
macro expansion #expect:2:3: error: call can throw, but it is not marked with 'try' and the error is not handled
\`- /repo/Tests/MyAppTests/CheckoutTests.swift:7:42: note: expanded code originates here
 5 |   @Test func allInStock() {
 6 |     let items = [Item(inStock: true)]
 7 |     #expect(items.allSatisfy(\\.inStock))
   |     |- note: in expansion of macro 'expect' here
   +--- macro expansion #expect ----------------------------------------
   |1 | Testing.__checkFunctionCall(items.self,calling: {
   |2 |   $0.allSatisfy($1)
   |  |   \`- error: call can throw, but it is not marked with 'try' and the error is not handled

macro expansion #expect:2:3: error: call can throw, but it is not marked with 'try' and the error is not handled
\`- /repo/Tests/MyAppTests/CheckoutTests.swift:14:6: note: expanded code originates here
/repo/Tests/MyAppTests/CheckoutTests.swift:18:9: warning: initialization of variable 'unused' was never used [#NoUsage]
macro expansion #expect:4:1: warning: a header with no note after it
** TEST FAILED **
`;

describe("decodeSwiftPunycode", () => {
  it("restores the dot a file name cannot carry in a symbol", () => {
    expect(decodeSwiftPunycode("CheckoutTestsswift_ynAHf")).toBe(
      "CheckoutTests.swift",
    );
  });

  // The common shape of an extension's file, and the one a "put the dot back
  // before swift" shortcut gets wrong.
  it("restores every character, not only the dot", () => {
    expect(decodeSwiftPunycode("CartCheckoutswift_mjFCfEb")).toBe(
      "Cart+Checkout.swift",
    );
  });

  it("rejects digits outside its alphabet", () => {
    expect(decodeSwiftPunycode("CheckoutTestsswift_yn9")).toBeUndefined();
  });

  it("rejects a code point past Unicode rather than throwing", () => {
    expect(decodeSwiftPunycode("a_JJJJJJa")).toBeUndefined();
  });
});

describe("parseMacroExpansionName", () => {
  it("reads the module, the file, and where the macro starts", () => {
    expect(parseMacroExpansionName(NAME)).toEqual({
      module: "MyAppTests",
      file: "CheckoutTests.swift",
      line: 7,
      col: 5,
    });
  });

  it("reads the second expansion in one function the same way", () => {
    expect(parseMacroExpansionName(NAME.replace("fMf_", "fMf0_"))?.line).toBe(
      7,
    );
  });

  it("counts a bare index as zero and N_ as N + 1", () => {
    const name = parseMacroExpansionName(NAME.replace("MX6_4_", "MX_4_"));
    expect(name).toBeUndefined();
    expect(parseMacroExpansionName(NAME.replace("MX6_4_", "MX0_0_"))).toEqual(
      expect.objectContaining({ line: 1, col: 1 }),
    );
  });

  it("does not guess at an attached macro, which carries no position", () => {
    expect(
      parseMacroExpansionName(
        "/var/folders/T/@__swiftmacro_5MyApp4CartV5StatefMp_.swift",
      ),
    ).toBeUndefined();
  });

  it("rejects a name that is not an expansion", () => {
    expect(
      parseMacroExpansionName("/repo/Tests/MyAppTests/CheckoutTests.swift"),
    ).toBeUndefined();
  });
});

describe("parseMacroOrigins", () => {
  it("pairs each expansion diagnostic with the note after it", () => {
    expect(parseMacroOrigins(TRANSCRIPT)).toEqual([
      {
        line: 2,
        col: 3,
        message:
          "call can throw, but it is not marked with 'try' and the error is not handled",
        file: "/repo/Tests/MyAppTests/CheckoutTests.swift",
        originLine: 7,
        originCol: 42,
      },
      expect.objectContaining({ originLine: 14, originCol: 6 }),
    ]);
  });

  it("reads past another note on the same diagnostic", () => {
    const origins = parseMacroOrigins(
      [
        "macro expansion #expect:2:3: error: cannot find 'total' in scope",
        "|- /repo/Sources/MyApp/Cart.swift:4:7: note: did you mean 'totals'?",
        "`- /repo/Tests/MyAppTests/CheckoutTests.swift:9:30: note: expanded code originates here",
      ].join("\n"),
    );
    expect(origins.map((origin) => origin.originLine)).toEqual([9]);
  });
});

describe("readMacroOrigins", () => {
  const inExpansion = {
    errors: [
      { message: "x", sourceURL: `file://${NAME}#StartingLineNumber=1` },
    ],
  };

  it("never opens the log when no diagnostic is in an expansion", async () => {
    const results = {
      errors: [{ message: "x", sourceURL: "file:///repo/A.swift" }],
    };
    const dir = mkdtempSync(join(tmpdir(), "axi-macro-"));
    const log = join(dir, "MyApp-test-1.log");
    writeFileSync(log, TRANSCRIPT);
    expect(await readMacroOrigins(log, results)).toEqual([]);
  });

  it("answers nothing for a bundle with no log beside it", async () => {
    expect(
      await readMacroOrigins("/nonexistent/MyApp-test-1.log", inExpansion),
    ).toEqual([]);
  });

  it("reads the log for a diagnostic whose file is an expansion, not a directory named like one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "axi-macro-"));
    const log = join(dir, "MyApp-test-1.log");
    writeFileSync(log, TRANSCRIPT);
    const results = {
      errors: [
        { message: "x", sourceURL: "file:///repo/@__swiftmacro_x/A.swift" },
      ],
    };
    expect(await readMacroOrigins(log, results)).toEqual([]);
  });

  it("ignores a log older than the run it sits beside", async () => {
    const dir = mkdtempSync(join(tmpdir(), "axi-macro-"));
    const log = join(dir, "MyApp-test-1.log");
    writeFileSync(log, TRANSCRIPT);
    utimesSync(log, 1_000_000, 1_000_000);
    expect(
      await readMacroOrigins(log, { ...inExpansion, startTime: 2_000_000 }),
    ).toEqual([]);
  });

  it("streams the log for origins", async () => {
    const dir = mkdtempSync(join(tmpdir(), "axi-macro-"));
    const log = join(dir, "MyApp-test-1.log");
    writeFileSync(log, TRANSCRIPT);
    const origins = await readMacroOrigins(log, inExpansion);
    expect(origins.map((origin) => origin.originLine)).toEqual([7, 14]);
  });
});
