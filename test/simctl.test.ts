import { describe, expect, it } from "vitest";
import { findDeviceType, prettyRuntime } from "../src/simctl.js";
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

describe("findDeviceType", () => {
  const types = [
    {
      identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
      name: "iPhone 17 Pro",
      family: "iPhone",
      minRuntime: "26.0.0",
    },
    {
      identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max",
      name: "iPhone 17 Pro Max",
      family: "iPhone",
      minRuntime: "26.0.0",
    },
  ];

  // The exact name has to win over the substring, or "iPhone 17 Pro" creates
  // a Pro Max whenever the Max happens to be listed first.
  it("prefers an exact name to one that merely contains it", () => {
    expect(findDeviceType(types, "iPhone 17 Pro")?.name).toBe("iPhone 17 Pro");
    expect(findDeviceType([...types].reverse(), "iPhone 17 Pro")?.name).toBe(
      "iPhone 17 Pro",
    );
  });

  it("takes the identifier simctl documents as well as the name", () => {
    expect(
      findDeviceType(
        types,
        "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max",
      )?.name,
    ).toBe("iPhone 17 Pro Max");
  });

  it("finds nothing rather than guessing", () => {
    expect(findDeviceType(types, "Pixel 9")).toBeUndefined();
  });
});

describe("sim delete", () => {
  // Deleting every simulator is gigabytes of state that cannot be recreated
  // as the same devices, so --all needs --yes the way `migrate --format`
  // does.
  it("refuses to delete everything without --yes", async () => {
    await expect(simCommand(["delete", "--all"])).rejects.toThrow(
      /cannot be undone/,
    );
  });
});
