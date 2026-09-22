import { describe, expect, it } from "vitest";
import { exportOptionsPlist } from "../src/archive.js";
import {
  EXPORT_FLAGS,
  EXPORT_HELP,
  EXPORT_VALUE_FLAGS,
  generatedPlistOptions,
  plistUploads,
} from "../src/commands/export.js";
import { positionals, rejectUnknownFlags } from "../src/args.js";

/**
 * The export options plist is the only place a CI ship can say "upload this"
 * rather than "write an .ipa", and it is a hand-authored XML file everywhere
 * else. Both halves are pinned: what the generated plist contains, and whether
 * this command can tell an upload from an export when it reads one back.
 */
describe("export options plist", () => {
  it("writes only the method when nothing else is asked for", () => {
    const plist = exportOptionsPlist({ method: "release-testing" });
    expect(plist).toContain("<key>method</key>");
    expect(plist).toContain("<string>release-testing</string>");
    expect(plist).not.toContain("destination");
    expect(plist).not.toContain("manageAppVersionAndBuildNumber");
  });

  it("uploads when asked, so a ship never has to author XML", () => {
    const plist = exportOptionsPlist(
      generatedPlistOptions(["--upload"], "app-store-connect"),
    );
    expect(plist).toContain(
      "<key>destination</key>\n  <string>upload</string>",
    );
  });

  // Xcode's own default is to re-pick the build number at upload, which hides
  // which commit a build came from whenever CI set it at archive time.
  it("keeps the archive's build number when told to", () => {
    const plist = exportOptionsPlist(
      generatedPlistOptions(["--no-manage-version"], "app-store-connect"),
    );
    expect(plist).toContain(
      "<key>manageAppVersionAndBuildNumber</key>\n  <false/>",
    );
  });

  it("omits the key entirely when the default is wanted", () => {
    const plist = exportOptionsPlist(
      generatedPlistOptions([], "app-store-connect"),
    );
    expect(plist).not.toContain("manageAppVersionAndBuildNumber");
    expect(plist).not.toContain("uploadSymbols");
  });

  it("declines dSYMs when told to", () => {
    const plist = exportOptionsPlist(
      generatedPlistOptions(["--no-upload-symbols"], "app-store-connect"),
    );
    expect(plist).toContain("<key>uploadSymbols</key>\n  <false/>");
  });

  it("carries the team and signing style through unchanged", () => {
    const plist = exportOptionsPlist(
      generatedPlistOptions(
        ["--team", "ABCDE12345", "--signing-style", "manual", "--upload"],
        "app-store-connect",
      ),
    );
    expect(plist).toContain("<string>ABCDE12345</string>");
    expect(plist).toContain("<string>manual</string>");
    expect(plist).toContain("<string>upload</string>");
  });
});

/**
 * The other twelve keys. Each one used to be a reason to stop using this
 * command and author the XML by hand, which is the whole thing `--method`
 * exists to avoid.
 */
describe("the rest of the export options plist", () => {
  it("writes a provisioning profile per bundle id, and implies manual signing", () => {
    const plist = exportOptionsPlist(
      generatedPlistOptions(
        [
          "--profile",
          "com.example.MyApp=MyApp Distribution",
          "--profile",
          "com.example.MyApp.Widget=Widget Distribution",
        ],
        "release-testing",
      ),
    );
    expect(plist).toContain("<key>provisioningProfiles</key>");
    expect(plist).toContain(
      "    <key>com.example.MyApp</key>\n    <string>MyApp Distribution</string>",
    );
    // Naming a profile and then letting Xcode pick one is not a thing anyone
    // means, and the export that results is signed with something else.
    expect(plist).toContain(
      "<key>signingStyle</key>\n  <string>manual</string>",
    );
  });

  it("leaves an explicit signing style alone", () => {
    const plist = exportOptionsPlist(
      generatedPlistOptions(
        ["--certificate", "Apple Distribution", "--signing-style", "automatic"],
        "release-testing",
      ),
    );
    expect(plist).toContain("<string>automatic</string>");
  });

  it("rejects a profile that names no bundle id", () => {
    expect(() =>
      generatedPlistOptions(
        ["--profile", "MyApp Distribution"],
        "release-testing",
      ),
    ).toThrow(/expects <bundle-id>=<profile>/);
  });

  // Xcode spells its named thinning options with angle brackets; a device
  // model identifier has none.
  it("spells the thinning options the way Xcode does", () => {
    const of = (value: string) =>
      generatedPlistOptions(["--thinning", value], "release-testing").thinning;
    expect(of("none")).toBe("<none>");
    expect(of("<none>")).toBe("<none>");
    expect(of("thin-for-all-variants")).toBe("<thin-for-all-variants>");
    expect(of("iPhone7,1")).toBe("iPhone7,1");
  });

  it("fixes the case of an iCloud environment, and passes anything else through", () => {
    const of = (value: string) =>
      generatedPlistOptions(["--icloud-env", value], "app-store-connect")
        .iCloudContainerEnvironment;
    expect(of("production")).toBe("Production");
    expect(of("Development")).toBe("Development");
    expect(of("SomethingElse")).toBe("SomethingElse");
  });

  // A manifest missing one of its three URLs exports without an error and
  // produces a link that cannot install -- a failure on someone else's device.
  it("refuses a partial distribution manifest", () => {
    expect(() =>
      generatedPlistOptions(
        ["--manifest", "appURL=https://example.com/a.ipa"],
        "release-testing",
      ),
    ).toThrow(/displayImageURL/);
  });

  it("refuses a manifest key Xcode does not have", () => {
    expect(() =>
      generatedPlistOptions(
        ["--manifest", "iconURL=https://example.com/i.png"],
        "release-testing",
      ),
    ).toThrow(/Unknown manifest key/);
  });

  it("escapes a URL with a query string, which would otherwise break the plist", () => {
    const plist = exportOptionsPlist(
      generatedPlistOptions(
        [
          "--manifest",
          "appURL=https://example.com/a.ipa?v=1&build=2",
          "--manifest",
          "displayImageURL=https://example.com/i.png",
          "--manifest",
          "fullSizeImageURL=https://example.com/f.png",
        ],
        "release-testing",
      ),
    );
    expect(plist).toContain("a.ipa?v=1&amp;build=2");
  });

  it("writes the booleans only when they differ from Xcode's default", () => {
    const plist = exportOptionsPlist(
      generatedPlistOptions(
        [
          "--keep-swift-symbols",
          "--internal-only",
          "--app-store-info",
          "--no-embed-odr",
        ],
        "app-store-connect",
      ),
    );
    expect(plist).toContain("<key>stripSwiftSymbols</key>\n  <false/>");
    expect(plist).toContain(
      "<key>testFlightInternalTestingOnly</key>\n  <true/>",
    );
    expect(plist).toContain(
      "<key>generateAppStoreInformation</key>\n  <true/>",
    );
    expect(plist).toContain(
      "<key>embedOnDemandResourcesAssetPacksInBundle</key>\n  <false/>",
    );
    expect(
      exportOptionsPlist(generatedPlistOptions([], "app-store-connect")),
    ).not.toContain("stripSwiftSymbols");
  });
});

describe("recognising an upload in a plist", () => {
  it("reads back its own generated plist", () => {
    const plist = exportOptionsPlist(
      generatedPlistOptions(["--upload"], "app-store-connect"),
    );
    expect(plistUploads(plist)).toBe(true);
  });

  // The reason this reads the file rather than trusting the flag: --options
  // supplies a plist this command did not write, and uploading is the usual
  // reason to bring one. Getting it wrong reports a delivered build as an
  // empty export.
  it("recognises a hand-written one, whitespace and case included", () => {
    expect(
      plistUploads("<key>destination</key>\n<string>upload</string>"),
    ).toBe(true);
    expect(
      plistUploads("<key> destination </key> <string> Upload </string>"),
    ).toBe(true);
  });

  it("does not mistake an export for an upload", () => {
    const plist = exportOptionsPlist({
      method: "app-store-connect",
      destination: "export",
    });
    expect(plistUploads(plist)).toBe(false);
    expect(plistUploads("<key>method</key><string>upload</string>")).toBe(
      false,
    );
  });
});

/**
 * `export` was the one command on a release pipeline that could not say where
 * its log went — build, archive and test all gained `--artifacts-dir`, and the
 * command that actually talks to App Store Connect was left writing into the
 * tool's own cache, where CI's artifact upload never looks.
 */
describe("export --artifacts-dir", () => {
  it("is a value flag, so the path is not read as the archive", () => {
    expect(EXPORT_HELP).toContain("--artifacts-dir <path>");
  });

  it("declines an unknown flag rather than ignoring it", () => {
    expect(() =>
      rejectUnknownFlags(
        ["--artifacts-dir", "build/x"],
        "export",
        EXPORT_FLAGS,
        EXPORT_VALUE_FLAGS,
      ),
    ).not.toThrow();
    expect(() =>
      rejectUnknownFlags(
        ["--artifacts-directory", "build/x"],
        "export",
        EXPORT_FLAGS,
        EXPORT_VALUE_FLAGS,
      ),
    ).toThrow();
  });

  // A value flag that isn't declared as one gets its path read as the
  // positional archive path, which fails as "No archive at build/logs".
  it("does not swallow the archive path", () => {
    expect(
      positionals(
        ["--artifacts-dir", "build/logs", "MyApp.xcarchive"],
        EXPORT_VALUE_FLAGS,
      ),
    ).toEqual(["MyApp.xcarchive"]);
  });
});
