import { describe, expect, it } from "vitest";
import {
  answerLooksComplete,
  destinationSlug,
  isPlaceholder,
  parseDestinationLine,
  parseDestinations,
  parseDestinationAnswer,
  incompatibleHelp,
  pickDefault,
  type Destination,
} from "../src/destination.js";

describe("parseDestinationLine", () => {
  it("reads a simulator row", () => {
    const parsed = parseDestinationLine(
      "\t\t{ platform:iOS Simulator, arch:arm64, id:55D87B92-69D0-46C0-8EB0-DD68E2C5C103, OS:26.5, name:iPad (A16) }",
    );
    expect(parsed).toEqual({
      platform: "iOS Simulator",
      arch: "arm64",
      id: "55D87B92-69D0-46C0-8EB0-DD68E2C5C103",
      os: "26.5",
      name: "iPad (A16)",
      variant: "",
      eligible: true,
    });
  });

  // Device names carry spaces and parentheses, so the fields cannot be split
  // on commas alone.
  it("keeps a name containing spaces and parentheses intact", () => {
    expect(
      parseDestinationLine(
        "{ platform:iOS Simulator, name:Apple Watch Series 11 (46mm) }",
      )?.name,
    ).toBe("Apple Watch Series 11 (46mm)");
  });

  it("reads a placeholder row, which the caller filters out by id", () => {
    const parsed = parseDestinationLine(
      "{ platform:iOS, id:dvtdevice-DVTiPhonePlaceholder-iphoneos:placeholder, name:Any iOS Device }",
    );
    expect(parsed?.id).toContain("placeholder");
  });

  // The one value in a destination row that contains a comma, which is why the
  // split is driven by the next `key:`.
  it("keeps a variant containing a comma intact", () => {
    const parsed = parseDestinationLine(
      "{ platform:macOS, arch:arm64, variant:Designed for [iPad,iPhone], id:00008112-000539543488C01E, name:My Mac }",
    );
    expect(parsed?.variant).toBe("Designed for [iPad,iPhone]");
    expect(parsed?.name).toBe("My Mac");
  });

  it("reads the plain macOS row as having no variant", () => {
    expect(
      parseDestinationLine(
        "{ platform:macOS, arch:arm64, id:00008112-000539543488C01E, name:My Mac }",
      )?.variant,
    ).toBe("");
  });

  it("ignores lines that are not destination rows", () => {
    expect(
      parseDestinationLine("Available destinations for the MyApp scheme:"),
    ).toBeUndefined();
    expect(parseDestinationLine("")).toBeUndefined();
  });
});

describe("isPlaceholder", () => {
  const row = (line: string): Destination => {
    const parsed = parseDestinationLine(line);
    if (parsed === undefined) throw new Error(`unparsed: ${line}`);
    return parsed;
  };

  it("catches the id a project gives a placeholder", () => {
    expect(
      isPlaceholder(
        row(
          "{ platform:iOS, id:dvtdevice-DVTiPhonePlaceholder-iphoneos:placeholder, name:Any iOS Device }",
        ),
      ),
    ).toBe(true);
  });

  // A Swift package omits `id` entirely rather than spelling it "placeholder",
  // which let "Any Mac" and "Any DriverKit Host" through on every package.
  it("catches the missing id a Swift package gives one instead", () => {
    expect(isPlaceholder(row("{ platform:macOS, name:Any Mac }"))).toBe(true);
    expect(
      isPlaceholder(
        row("{ platform:macOS, variant:Mac Catalyst, name:Any Mac }"),
      ),
    ).toBe(true);
    expect(
      isPlaceholder(row("{ platform:DriverKit, name:Any DriverKit Host }")),
    ).toBe(true);
  });

  it("leaves a real destination alone", () => {
    expect(
      isPlaceholder(
        row(
          "{ platform:iOS Simulator, arch:arm64, id:55D87B92-69D0-46C0-8EB0-DD68E2C5C103, OS:26.5, name:iPad (A16) }",
        ),
      ),
    ).toBe(false);
    expect(
      isPlaceholder(
        row(
          "{ platform:macOS, arch:arm64, variant:DriverKit, id:00008112-000539543488C01E, name:My Mac }",
        ),
      ),
    ).toBe(false);
  });
});

describe("destinationSlug", () => {
  it("makes a filename-safe stem", () => {
    expect(destinationSlug("iPad Pro 11-inch (M5) · 26.5")).toBe(
      "iPad-Pro-11-inch-M5-26-5",
    );
  });
});

describe("pickDefault", () => {
  const destination = (
    platform: string,
    name: string,
    os: string,
  ): Destination => ({
    platform,
    name,
    os,
    id: `${name}-${os}`,
    arch: "arm64",
    variant: "",
    eligible: true,
  });

  it("prefers iOS even when another platform has a higher OS number", () => {
    // The shape a cross-platform Swift package reports.
    const picked = pickDefault([
      destination("watchOS Simulator", "Apple Watch SE 3 (40mm)", "26.5"),
      destination("iOS Simulator", "iPhone 17 Pro", "26.4"),
    ]);
    expect(picked.name).toBe("iPhone 17 Pro");
  });

  it("takes the newest OS within the preferred platform", () => {
    const picked = pickDefault([
      destination("iOS Simulator", "iPhone 17", "26.2"),
      destination("iOS Simulator", "iPhone 17 Pro", "26.5"),
    ]);
    expect(picked.os).toBe("26.5");
  });

  it("falls back to hardware only when no simulator is eligible", () => {
    const picked = pickDefault([destination("iOS", "My iPhone", "26.5")]);
    expect(picked.name).toBe("My iPhone");
  });

  it("breaks a same-OS tie toward an iPhone", () => {
    const picked = pickDefault([
      destination("iOS Simulator", "iPad (A16)", "26.5"),
      destination("iOS Simulator", "iPhone 17 Pro", "26.5"),
    ]);
    expect(picked.name).toBe("iPhone 17 Pro");
  });

  it("still takes the newest OS over the device tiebreak", () => {
    const picked = pickDefault([
      destination("iOS Simulator", "iPad (A16)", "26.5"),
      destination("iOS Simulator", "iPhone 17 Pro", "26.2"),
    ]);
    expect(picked.name).toBe("iPad (A16)");
  });

  it("ranks an unknown platform after the ones it knows", () => {
    const picked = pickDefault([
      destination("someOS Simulator", "Future Device", "99.0"),
      destination("watchOS Simulator", "Apple Watch", "26.5"),
    ]);
    expect(picked.name).toBe("Apple Watch");
  });
});

describe("answerLooksComplete", () => {
  const row = (platform: string, name: string): Destination => ({
    platform,
    name,
    id: "00008112-000539543488C01E",
    os: "",
    arch: "arm64",
    variant: "",
    eligible: true,
  });

  it("accepts an answer that reached the simulators", () => {
    expect(
      answerLooksComplete(
        [row("macOS", "My Mac"), row("iOS Simulator", "iPhone 17 Pro")],
        0,
      ),
    ).toBe(true);
  });

  // The shape of the bug: xcodebuild stopped after the generic block, so the
  // only thing left is the Mac. Trusted, that becomes "this scheme has no
  // iPhone 17 Pro" for a scheme that does.
  it("rejects an answer that never got past the Mac", () => {
    expect(
      answerLooksComplete(
        [row("macOS", "My Mac"), row("DriverKit", "Any DriverKit Host")],
        0,
      ),
    ).toBe(false);
  });

  it("rejects any answer from a probe that failed, however full", () => {
    expect(
      answerLooksComplete([row("iOS Simulator", "iPhone 17 Pro")], 74),
    ).toBe(false);
  });

  it("rejects an empty answer", () => {
    expect(answerLooksComplete([], 0)).toBe(false);
  });

  // A physical device is as good a sign the enumeration ran as a simulator is.
  it("accepts an answer that reached a connected device", () => {
    expect(answerLooksComplete([row("iOS", "Alex's iPhone")], 0)).toBe(true);
  });
});

describe("parseDestinations", () => {
  const transcript = [
    '\tDestinations compatible with the "DesignSystem" scheme:',
    "\t\t{ platform:macOS, arch:arm64, id:00008112-0005, name:My Mac }",
    "\t\t{ platform:iOS Simulator, arch:arm64, id:55D8, OS:26.5, name:iPhone 17 Pro }",
    "",
    '\tIneligible destinations for the "DesignSystem" scheme:',
    "\t\t{ platform:iOS, id:dvtdevice-DVTiPhonePlaceholder-iphoneos:placeholder, name:Any iOS Device }",
    "\t\t{ platform:iOS Simulator, arch:arm64, id:9F9F, OS:18.0, name:iPhone 15 }",
  ].join("\n");

  it("splits the two headings and drops the placeholders", () => {
    const parsed = parseDestinations(transcript);
    expect(parsed.map((d) => [d.name, d.eligible])).toEqual([
      ["My Mac", true],
      ["iPhone 17 Pro", true],
      ["iPhone 15", false],
    ]);
  });

  it("finds nothing in a transcript that never listed a row", () => {
    expect(
      parseDestinations("Command line invocation:\nResolve Package Graph"),
    ).toEqual([]);
  });
});

describe("parseDestinationAnswer on Xcode 27", () => {
  // Xcode 27 renamed the headings. Reading only the old one marked every
  // incompatible simulator eligible and picked one to build against.
  const answer = `
	Destinations compatible with the "MyApp" scheme:
		{ platform:iOS, id:dvtdevice-DVTiPhonePlaceholder-iphoneos:placeholder, name:Any iOS Device }
		{ platform:iOS Simulator, id:dvtdevice-DVTiOSDeviceSimulatorPlaceholder-iphonesimulator:placeholder, name:Any iOS Simulator Device }
	Destinations incompatible with the "MyApp" scheme:
		{ platform:macOS, arch:arm64e, id:00008112-000539543488C01E, name:My Mac, error:My Mac’s macOS platform doesn’t match MyApp.app’s supported platforms. You can change MyApp.app’s Base SDK or Supported Platforms to support My Mac. }
		{ platform:iOS Simulator, arch:arm64, id:025E999B-B68A-45D3-9014-8B72ED097670, OS:26.5, name:iPhone 17 Pro, error:iPhone 17 Pro’s iOS Simulator 26.5 doesn’t match MyApp.app’s iOS Simulator 27.0  deployment target. Upgrade iPhone 17 Pro’s iOS Simulator version or lower MyApp.app’s deployment target. }
`;

  it("marks the incompatible rows ineligible", () => {
    const { destinations } = parseDestinationAnswer(answer);
    expect(destinations.map((d) => [d.name, d.eligible])).toEqual([
      ["My Mac", false],
      ["iPhone 17 Pro", false],
    ]);
  });

  it("keeps xcodebuild's reason, whitespace folded", () => {
    const phone = parseDestinationAnswer(answer).destinations[1];
    expect(phone?.reason).toBe(
      "iPhone 17 Pro’s iOS Simulator 26.5 doesn’t match MyApp.app’s iOS Simulator 27.0 deployment target. Upgrade iPhone 17 Pro’s iOS Simulator version or lower MyApp.app’s deployment target.",
    );
    expect(phone?.name).toBe("iPhone 17 Pro");
  });

  it("collects the eligible placeholders as generic platforms", () => {
    expect(parseDestinationAnswer(answer).generic).toEqual([
      "iOS",
      "iOS Simulator",
    ]);
  });

  it("still reads Xcode 26's headings", () => {
    const { destinations } = parseDestinationAnswer(`
	Available destinations for the "MyApp" scheme:
		{ platform:iOS Simulator, arch:arm64, id:AAAA, OS:26.5, name:iPhone 17 }
	Ineligible destinations for the "MyApp" scheme:
		{ platform:iOS Simulator, arch:arm64, id:BBBB, OS:18.0, name:iPhone 16 }
`);
    expect(destinations.map((d) => d.eligible)).toEqual([true, false]);
  });
});

describe("incompatibleHelp", () => {
  const phone = (name: string, reason: string): Destination => ({
    platform: "iOS Simulator",
    name,
    id: name,
    os: "26.5",
    arch: "arm64",
    variant: "",
    eligible: false,
    reason,
  });

  it("quotes the named device and points at a runtime download", () => {
    const help = incompatibleHelp(
      [
        phone(
          "iPhone 17",
          "iPhone 17’s iOS Simulator 26.5 doesn’t match the deployment target.",
        ),
        phone(
          "iPhone 17 Pro",
          "iPhone 17 Pro’s iOS Simulator 26.5 doesn’t match the deployment target.",
        ),
      ],
      "MyApp",
      "iPhone 17 Pro",
    );
    expect(help[0]).toContain("iPhone 17 Pro’s");
    expect(help[1]).toContain("xcodebuild-axi platforms download iOS");
  });
});
