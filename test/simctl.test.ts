import { describe, expect, it } from "vitest";
import { prettyRuntime } from "../src/simctl.js";
import { appRow, simCommand } from "../src/commands/sim.js";

describe("prettyRuntime", () => {
  it("turns a runtime identifier into something readable", () => {
    expect(prettyRuntime("com.apple.CoreSimulator.SimRuntime.iOS-26-5")).toBe(
      "iOS 26.5",
    );
    expect(
      prettyRuntime("com.apple.CoreSimulator.SimRuntime.watchOS-11-0"),
    ).toBe("watchOS 11.0");
  });

  it("leaves an identifier it does not recognise alone", () => {
    expect(prettyRuntime("something-else")).toBe("something-else");
  });
});

describe("appRow", () => {
  // TOON quotes `"1.0"` and `"1"` because they look like numbers, so two
  // quoted columns become one readable string.
  it("reads a version and a build as one field", () => {
    expect(
      appRow({
        bundleId: "com.example.MyApp",
        name: "MyApp",
        version: "1.2",
        build: "44",
        type: "user",
        path: "/tmp/MyApp.app",
      }),
    ).toEqual({
      app: "MyApp",
      bundle_id: "com.example.MyApp",
      version: "1.2 (44)",
    });
  });

  it("says unknown rather than printing an empty column", () => {
    expect(
      appRow({
        bundleId: "com.example.MyApp",
        name: "MyApp",
        version: "",
        build: "",
        type: "user",
        path: "",
      }),
    ).toMatchObject({ version: "unknown" });
  });
});

describe("sim subcommands", () => {
  it("names the subcommands it has when given one it does not", async () => {
    await expect(simCommand(["frobnicate"])).rejects.toThrow(
      /Unknown sim subcommand 'frobnicate'/,
    );
  });
});
