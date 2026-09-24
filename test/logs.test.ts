import { describe, expect, it } from "vitest";
import { parseLogLines } from "../src/commands/sim.js";
import { failureReason } from "../src/simctl.js";
import { parseAppSettings } from "../src/commands/settings.js";
import { innermost } from "../src/commands/tests.js";
import { rerunIdentifier } from "../src/commands/test.js";

describe("parseLogLines", () => {
  it("reads compact log rows and folds continuation lines", () => {
    const rows = parseLogLines(
      [
        "Timestamp               Ty Process[PID:TID]",
        "2026-09-22 15:15:39.751 Df MyApp[42552:24bde94] [com.example.MyApp:app] MyApp launched",
        "2026-09-22 15:15:39.779 E  MyApp[42552:24bdebe] (CoreFoundation) Something failed",
        "  with a second line",
      ].join("\n"),
    );
    expect(rows).toEqual([
      {
        time: "15:15:39.751",
        level: "default",
        category: "com.example.MyApp:app",
        message: "MyApp launched",
      },
      {
        time: "15:15:39.779",
        level: "error",
        category: "CoreFoundation",
        message: "Something failed\n  with a second line",
      },
    ]);
  });
});

describe("failureReason", () => {
  // A rejected install puts the actual reason on the fourth line.
  it("skips simctl's framing to the line that says what failed", () => {
    expect(
      failureReason(
        [
          "An error was encountered processing the command (domain=IXUserPresentableErrorDomain, code=1):",
          "App installation failed: Unable to Install “MyApp”",
          "Please try again later.",
          "Appex bundle at /x/MyApp.app/PlugIns/Share.appex does not have a CFBundleDisplayName key",
          "Underlying error (domain=IXUserPresentableErrorDomain, code=1):",
        ].join("\n"),
      ),
    ).toBe(
      "Appex bundle at /x/MyApp.app/PlugIns/Share.appex does not have a CFBundleDisplayName key",
    );
  });

  it("prefers xcodebuild's own error line over its timestamped preamble", () => {
    expect(
      failureReason(
        [
          "2026-09-22 15:05:05.722 xcodebuild[27809:38462756] Writing error result bundle to /var/folders/x.xcresult",
          'xcodebuild: error: The workspace named "MyApps" does not contain a scheme named "Nope".',
        ].join("\n"),
      ),
    ).toBe(
      'The workspace named "MyApps" does not contain a scheme named "Nope".',
    );
  });
});

describe("parseAppSettings", () => {
  // A scheme that lists an extension after the app would otherwise hand back
  // the .appex as the thing to install.
  it("picks the application target over whatever came last", () => {
    const json = JSON.stringify([
      {
        target: "MyApp",
        buildSettings: {
          PRODUCT_TYPE: "com.apple.product-type.application",
          FULL_PRODUCT_NAME: "MyApp.app",
        },
      },
      {
        target: "MyApp-Widget",
        buildSettings: {
          PRODUCT_TYPE: "com.apple.product-type.app-extension",
          FULL_PRODUCT_NAME: "MyApp-Widget.appex",
        },
      },
    ]);
    expect(parseAppSettings(json)["FULL_PRODUCT_NAME"]).toBe("MyApp.app");
  });

  it("falls back to the merged view when nothing is an application", () => {
    const json = JSON.stringify([
      {
        target: "Core",
        buildSettings: { FULL_PRODUCT_NAME: "Core.framework" },
      },
    ]);
    expect(parseAppSettings(json)["FULL_PRODUCT_NAME"]).toBe("Core.framework");
  });
});

describe("innermost", () => {
  it("digs the cause out of xcodebuild's nested underlying errors", () => {
    expect(
      innermost(
        "MyApp encountered an error. (Underlying Error: Failed to install or launch the test runner. (Underlying Error: Unable to Install “com.example.MyApp”. No code signature found.))",
      ),
    ).toBe("Unable to Install “com.example.MyApp”. No code signature found.");
  });
});

describe("rerunIdentifier", () => {
  it("qualifies the identifier with its test target", () => {
    expect(
      rerunIdentifier({
        targetName: "MyAppTests",
        testIdentifierString: "CheckoutTests/testFails()",
      }),
    ).toBe("MyAppTests/CheckoutTests/testFails");
  });

  it("does not qualify twice", () => {
    expect(
      rerunIdentifier({
        targetName: "MyAppTests",
        testIdentifierString: "MyAppTests/CheckoutTests/testFails()",
      }),
    ).toBe("MyAppTests/CheckoutTests/testFails");
  });

  it("gives nothing without an identifier", () => {
    expect(rerunIdentifier({ targetName: "MyAppTests" })).toBeUndefined();
  });
});
