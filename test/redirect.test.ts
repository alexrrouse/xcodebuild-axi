import { describe, expect, it } from "vitest";
import {
  companionRedirect,
  nearest,
  redirectArgv,
  shellQuote,
  simSubcommandRedirect,
  simctlRedirect,
  translateXcodebuild,
  xcodebuildFlagHint,
} from "../src/redirect.js";
import { COMMAND_FLAGS } from "../src/cli.js";

const COMMANDS = Object.keys(COMMAND_FLAGS);

/** The first `Run \`…\`` suggestion, unwrapped. */
function firstRun(error: { suggestions: string[] } | undefined): string {
  const line = error?.suggestions.find((entry) => entry.startsWith("Run `"));
  return line?.match(/`([^`]+)`/)?.[1] ?? "";
}

describe("translateXcodebuild", () => {
  it("turns a whole test invocation into one command", () => {
    const translation = translateXcodebuild([
      "-workspace",
      "MyApps.xcworkspace",
      "-scheme",
      "MyApp",
      "-destination",
      "platform=iOS Simulator,name=iPhone 17 Pro",
      "test",
      "-only-testing:MyAppTests/CheckoutTests",
    ]);
    expect(translation.command).toBe(
      'test --scheme MyApp --device "iPhone 17 Pro" --only MyAppTests/CheckoutTests',
    );
    expect(translation.unsupported).toEqual([]);
    expect(translation.notes.join("\n")).toContain("-workspace");
  });

  // A pinned OS is something only the specifier can express.
  it("keeps a destination the device flag cannot express", () => {
    expect(
      translateXcodebuild([
        "-destination",
        "platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5",
        "build",
      ]).command,
    ).toBe(
      "build --destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5'",
    );
  });

  it("reads a mode option as the command it implies", () => {
    expect(translateXcodebuild(["-showsdks"]).command).toBe("info --sdks");
    expect(translateXcodebuild(["-list"]).command).toBe("schemes");
    expect(
      translateXcodebuild(["-scheme", "MyApp", "-showBuildSettings"]).command,
    ).toBe("settings --scheme MyApp");
  });

  it("folds clean into build and moves settings onto --setting", () => {
    expect(
      translateXcodebuild([
        "-scheme",
        "MyApp",
        "clean",
        "build",
        "CODE_SIGNING_ALLOWED=NO",
      ]).command,
    ).toBe("build --clean --scheme MyApp --setting CODE_SIGNING_ALLOWED=NO");
  });

  it("maps the action words that became flags", () => {
    expect(translateXcodebuild(["build-for-testing"]).command).toBe(
      "build --for-testing",
    );
    expect(translateXcodebuild(["test-without-building"]).command).toBe(
      "test --without-building",
    );
  });

  it("spells YES/NO switches as the flag or nothing", () => {
    expect(
      translateXcodebuild(["test", "-enableCodeCoverage", "YES"]).command,
    ).toBe("test --coverage");
    expect(
      translateXcodebuild(["test", "-enableCodeCoverage", "NO"]).command,
    ).toBe("test");
    expect(
      translateXcodebuild(["test", "-parallel-testing-enabled", "NO"]).command,
    ).toBe("test --no-parallel");
    expect(
      translateXcodebuild(["build", "-enableAddressSanitizer", "YES"]).command,
    ).toBe("build --sanitizer address");
  });

  it("drops what the tool already does, silently", () => {
    const translation = translateXcodebuild(["build", "-quiet", "-json"]);
    expect(translation.command).toBe("build");
    expect(translation.notes).toEqual([]);
  });

  it("names an option that belongs to another command", () => {
    const translation = translateXcodebuild(["build", "-only-testing:A/B"]);
    expect(translation.notes.join("\n")).toContain("test --only");
  });

  it("reports an option it has never heard of as unsupported", () => {
    expect(translateXcodebuild(["build", "-frobnicate"]).unsupported).toContain(
      "-frobnicate",
    );
  });
});

describe("xcodebuildFlagHint", () => {
  it("respells a single-dash flag on a real command, keeping the rest", () => {
    const hint = xcodebuildFlagHint("test", [
      "-only-testing:MyAppTests/CheckoutTests",
      "--device",
      "iPhone 17 Pro",
    ]);
    expect(hint?.[0]).toContain(
      "xcodebuild-axi test --only MyAppTests/CheckoutTests --device 'iPhone 17 Pro'",
    );
  });

  it("leaves a flag xcodebuild never had to the ordinary error", () => {
    expect(xcodebuildFlagHint("build", ["-x"])).toBeUndefined();
  });
});

describe("redirectArgv", () => {
  it("passes real commands and the SDK's own words through", () => {
    for (const argv of [["build"], [], ["--help"], ["-v"], ["update"]]) {
      expect(redirectArgv(argv, COMMANDS)).toBeUndefined();
    }
  });

  it("answers a raw xcodebuild line with this tool's command", () => {
    expect(firstRun(redirectArgv(["xcodebuild", "-list"], COMMANDS))).toBe(
      "xcodebuild-axi schemes",
    );
    expect(
      firstRun(redirectArgv(["-scheme", "MyApp", "build"], COMMANDS)),
    ).toBe("xcodebuild-axi build --scheme MyApp");
    expect(
      firstRun(redirectArgv(["xcrun", "xcodebuild", "-showsdks"], COMMANDS)),
    ).toBe("xcodebuild-axi info --sdks");
  });

  it("answers xcodebuild's own words typed as commands", () => {
    expect(firstRun(redirectArgv(["showBuildSettings"], COMMANDS))).toBe(
      "xcodebuild-axi settings",
    );
    expect(firstRun(redirectArgv(["build-for-testing"], COMMANDS))).toBe(
      "xcodebuild-axi build --for-testing",
    );
  });

  // `install` is an xcodebuild action too, and almost never what is meant.
  it("offers the simulator install before the install action", () => {
    const error = redirectArgv(["install"], COMMANDS);
    expect(error?.suggestions[0]).toContain("sim install");
    expect(error?.suggestions[1]).toContain("build --install");
  });

  it("catches a typo", () => {
    expect(firstRun(redirectArgv(["buld"], COMMANDS))).toBe(
      "xcodebuild-axi build",
    );
    expect(firstRun(redirectArgv(["destination"], COMMANDS))).toBe(
      "xcodebuild-axi destinations",
    );
  });

  it("lists every command for a word it cannot place", () => {
    const error = redirectArgv(["frobnicate"], COMMANDS);
    expect(error?.message).toBe("Unknown command 'frobnicate'");
    expect(error?.suggestions[0]).toContain("run, test");
  });

  it("routes companion tools to the command that wraps them", () => {
    expect(
      firstRun(
        redirectArgv(["xcrun", "simctl", "boot", "iPhone 17 Pro"], COMMANDS),
      ),
    ).toBe('xcodebuild-axi sim boot "iPhone 17 Pro"');
    expect(
      firstRun(
        redirectArgv(["xccov", "view", "--report", "r.xcresult"], COMMANDS),
      ),
    ).toBe("xcodebuild-axi coverage r.xcresult");
  });
});

describe("simctlRedirect", () => {
  it("maps io to screenshot or video by its verb", () => {
    expect(
      firstRun(simctlRedirect(["io", "booted", "screenshot", "shot.png"])),
    ).toBe("xcodebuild-axi sim screenshot booted shot.png");
    expect(
      firstRun(simctlRedirect(["io", "booted", "recordVideo", "a.mov"])),
    ).toBe("xcodebuild-axi sim video booted a.mov");
  });

  it("gives the raw command for a subcommand this tool declines", () => {
    const error = simctlRedirect(["keychain", "booted", "reset"]);
    expect(error.message).toContain("does not wrap simctl keychain");
    expect(error.suggestions[0]).toBe(
      "Run it directly: `xcrun simctl keychain booted reset`",
    );
  });

  it("sends a spawned log read to sim logs", () => {
    const error = simctlRedirect(["spawn", "booted", "log", "stream"]);
    expect(firstRun(error)).toContain("xcodebuild-axi sim logs booted");
    expect(error.suggestions.join("\n")).toContain(
      "xcrun simctl spawn booted log stream",
    );
  });
});

describe("simSubcommandRedirect", () => {
  it("respells a simctl name sim takes differently", () => {
    expect(
      firstRun(simSubcommandRedirect("openurl", ["booted", "myapp://x"])),
    ).toBe("xcodebuild-axi sim open booted myapp://x");
    expect(firstRun(simSubcommandRedirect("listapps", ["booted"]))).toBe(
      "xcodebuild-axi sim apps booted",
    );
  });

  it("leaves a word simctl does not have to the ordinary error", () => {
    expect(simSubcommandRedirect("bogus", [])).toBeUndefined();
  });
});

describe("companionRedirect", () => {
  it("picks the most specific xcresulttool subcommand", () => {
    expect(
      firstRun(
        companionRedirect("xcresulttool", [
          "get",
          "test-results",
          "tests",
          "--path",
          "r.xcresult",
        ]),
      ),
    ).toBe("xcodebuild-axi result r.xcresult --tests");
  });
});

describe("nearest", () => {
  it("allows one edit on a short word and two on a longer one", () => {
    expect(nearest("tst", ["test", "tests"])).toEqual(["test"]);
    expect(nearest("destnations", ["destinations"])).toEqual(["destinations"]);
    expect(nearest("xyz", ["test"])).toEqual([]);
  });
});

describe("shellQuote", () => {
  it("quotes only what a shell would split", () => {
    expect(shellQuote("MyApp")).toBe("MyApp");
    expect(shellQuote("iPhone 17 Pro")).toBe("'iPhone 17 Pro'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});
