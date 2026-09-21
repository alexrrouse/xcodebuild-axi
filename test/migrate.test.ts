import { describe, expect, it } from "vitest";
import {
  errorLine,
  parseFormats,
  parseWorkspaceProjects,
} from "../src/commands/migrate.js";

const REJECTION =
  "xcodebuild: error: Could not find requested format 'bogus'. Pass a project format by name or version number: Xcode 2.4, Xcode 3.0, Xcode 3.0, Xcode 3.1, Xcode 27.0.";

describe("parseFormats", () => {
  it("reads the list out of xcodebuild's rejection", () => {
    expect(parseFormats(REJECTION)).toEqual([
      "Xcode 2.4",
      "Xcode 3.0",
      "Xcode 3.1",
      "Xcode 27.0",
    ]);
  });

  it("drops the duplicate xcodebuild prints", () => {
    expect(
      parseFormats(REJECTION).filter((f) => f === "Xcode 3.0"),
    ).toHaveLength(1);
  });

  it("returns nothing when the output has no list", () => {
    expect(parseFormats("xcodebuild: error: something else entirely")).toEqual(
      [],
    );
  });
});

describe("errorLine", () => {
  it("strips the prefix and the format list the suggestions already carry", () => {
    expect(errorLine(REJECTION)).toBe(
      "Could not find requested format 'bogus'.",
    );
  });

  it("ignores xcodebuild's timestamped chatter", () => {
    const noisy = [
      "2026-09-21 09:00:00.000 xcodebuild[1:2] Writing error result bundle to /tmp/x",
      "xcodebuild: error: The directory does not contain an Xcode project.",
    ].join("\n");
    expect(errorLine(noisy)).toBe(
      "The directory does not contain an Xcode project.",
    );
  });

  it("is empty when nothing failed", () => {
    expect(errorLine("** BUILD SUCCEEDED **")).toBe("");
  });
});

describe("parseWorkspaceProjects", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Workspace version = "1.0">
   <FileRef location = "group:MyApp.xcodeproj"></FileRef>
   <FileRef location = "group:Nested/Second.xcodeproj"></FileRef>
   <FileRef location = "group:NotAProject.swift"></FileRef>
</Workspace>`;

  it("resolves project references against the workspace's directory", () => {
    expect(parseWorkspaceProjects(xml, "/repo")).toEqual([
      "/repo/MyApp.xcodeproj",
      "/repo/Nested/Second.xcodeproj",
    ]);
  });

  it("ignores references that are not projects", () => {
    expect(parseWorkspaceProjects(xml, "/repo")).not.toContain(
      "/repo/NotAProject.swift",
    );
  });

  it("handles container: and self: prefixes", () => {
    expect(
      parseWorkspaceProjects(
        '<FileRef location = "container:App.xcodeproj"></FileRef>',
        "/repo",
      ),
    ).toEqual(["/repo/App.xcodeproj"]);
  });

  it("is empty for a workspace that references no projects", () => {
    expect(parseWorkspaceProjects("<Workspace></Workspace>", "/repo")).toEqual(
      [],
    );
  });
});
