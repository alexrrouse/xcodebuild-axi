import { describe, expect, it } from "vitest";
import { findDeviceType, prettyRuntime } from "../src/simctl.js";
import {
  appRow,
  isPayloadPath,
  simCommand,
  statusOverrides,
  statusRows,
  uiSetting,
} from "../src/commands/sim.js";

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

describe("statusRows", () => {
  // Real output from `simctl status_bar <udid> list` after a pin.
  const listed = [
    "Current Status Bar Overrides:",
    "  Time: 9:41",
    "  DataNetworkType: 11",
    "  WiFi Mode: 3, WiFi Bars: 3",
    "  Cell Mode: 3, Cell Bars: 4",
    "  Battery State: 2, Battery Level: 100, Not Charging: 0",
  ].join("\n");

  it("reports simctl's enum ordinals as the words its flags take", () => {
    expect(statusRows(listed)).toMatchObject({
      data_network: "5g",
      wifi_mode: "active",
      cell_mode: "active",
      battery_state: "charged",
    });
  });

  // TOON quotes a numeric-looking string, so a level that came back as text
  // has to become a number before it is rendered.
  it("keeps numbers as numbers", () => {
    expect(statusRows(listed)).toMatchObject({
      battery_level: 100,
      wifi_bars: 3,
      cell_bars: 4,
    });
  });

  it("reads nothing out of a status bar nobody has overridden", () => {
    expect(statusRows("Current Status Bar Overrides:\n")).toEqual({});
  });
});

describe("statusOverrides", () => {
  it("sets the mode alongside the bars, which simctl needs to show them", () => {
    expect(statusOverrides(["--bars", "2"])).toEqual([
      "--wifiMode",
      "active",
      "--wifiBars",
      "2",
      "--cellularMode",
      "active",
      "--cellularBars",
      "2",
    ]);
  });

  // Wifi tops out a bar below cellular, and simctl rejects the whole
  // override rather than clamping it.
  it("caps wifi at the three bars it has", () => {
    expect(statusOverrides(["--bars", "4"])).toContain("3");
  });

  it("refuses a battery level that is not a percentage", () => {
    expect(() => statusOverrides(["--battery", "900"])).toThrow(/percentage/);
  });

  it("refuses more bars than a status bar has", () => {
    expect(() => statusOverrides(["--bars", "9"])).toThrow(/0 to 4 bars/);
  });

  it("asks for nothing when nothing was asked for", () => {
    expect(statusOverrides([])).toEqual([]);
  });
});

describe("isPayloadPath", () => {
  // `sim push <device> [bundle-id] [payload.json]` takes both in either
  // order, so one of them has to be recognisable on sight.
  it("tells a payload from a bundle id", () => {
    expect(isPayloadPath("./alert.json")).toBe(true);
    expect(isPayloadPath("/tmp/alert.JSON")).toBe(true);
    expect(isPayloadPath("com.example.MyApp")).toBe(false);
  });
});

describe("uiSetting", () => {
  it("takes an appearance on its own", () => {
    expect(uiSetting("dark", undefined)).toEqual(["appearance", "dark"]);
  });

  it("takes simctl's own names as well as the short ones", () => {
    expect(uiSetting("contrast", "enabled")).toEqual([
      "increase_contrast",
      "enabled",
    ]);
    expect(uiSetting("content_size", "large")).toEqual([
      "content_size",
      "large",
    ]);
  });

  it("refuses a setting simctl does not have", () => {
    expect(() => uiSetting("volume", "11")).toThrow(/no ui setting/);
  });
});
