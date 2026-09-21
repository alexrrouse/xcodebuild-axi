import { describe, expect, it } from "vitest";
import {
  packageArgs,
  PACKAGE_FLAGS,
  PACKAGE_VALUE_FLAGS,
} from "../src/packages.js";

describe("packageArgs", () => {
  it("is empty when nothing is asked for", () => {
    expect(packageArgs(["--scheme", "Tides"])).toEqual([]);
  });

  it("maps switches to xcodebuild's names", () => {
    expect(packageArgs(["--offline", "--skip-package-updates"])).toEqual([
      "-onlyUsePackageVersionsFromResolvedFile",
      "-skipPackageUpdates",
    ]);
  });

  it("maps value flags with their values", () => {
    expect(
      packageArgs(["--cache", "/tmp/pkgs", "--scm-provider", "xcode"]),
    ).toEqual([
      "-clonedSourcePackagesDirPath",
      "/tmp/pkgs",
      "-scmProvider",
      "xcode",
    ]);
  });

  it("declares every value flag as a flag", () => {
    for (const flag of PACKAGE_VALUE_FLAGS) {
      expect(PACKAGE_FLAGS as readonly string[]).toContain(flag);
    }
  });
});
