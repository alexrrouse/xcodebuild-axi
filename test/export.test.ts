import { describe, expect, it } from "vitest";
import { exportOptionsPlist } from "../src/archive.js";
import { generatedPlistOptions, plistUploads } from "../src/commands/export.js";

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
