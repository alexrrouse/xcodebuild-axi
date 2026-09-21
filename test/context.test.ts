import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AxiError } from "../src/errors.js";
import { requireProject, resolveProject } from "../src/context.js";

const created: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "axi-context-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveProject", () => {
  it("finds a workspace", () => {
    const dir = scratch();
    mkdirSync(join(dir, "Apps.xcworkspace"));
    const project = resolveProject(dir);
    expect(project?.kind).toBe("workspace");
    expect(project?.name).toBe("Apps");
    expect(project?.flags).toEqual([
      "-workspace",
      join(dir, "Apps.xcworkspace"),
    ]);
  });

  // Xcode itself opens the workspace when both are present, and a project
  // inside one usually cannot resolve the workspace's package graph alone.
  it("prefers a workspace over a project in the same directory", () => {
    const dir = scratch();
    mkdirSync(join(dir, "Apps.xcworkspace"));
    mkdirSync(join(dir, "Tides.xcodeproj"));
    expect(resolveProject(dir)?.kind).toBe("workspace");
  });

  // Every .xcodeproj contains one; it is never the thing a user builds.
  it("ignores the project.xcworkspace inside an .xcodeproj", () => {
    const dir = scratch();
    mkdirSync(join(dir, "project.xcworkspace"));
    mkdirSync(join(dir, "Tides.xcodeproj"));
    const project = resolveProject(dir);
    expect(project?.kind).toBe("project");
    expect(project?.name).toBe("Tides");
  });

  it("falls back to a Swift package, which needs no container flag", () => {
    const dir = scratch();
    writeFileSync(join(dir, "Package.swift"), "// swift-tools-version:6.0\n");
    const project = resolveProject(dir);
    expect(project?.kind).toBe("package");
    expect(project?.flags).toEqual([]);
  });

  it("returns undefined when there is nothing to build", () => {
    expect(resolveProject(scratch())).toBeUndefined();
  });

  it("returns undefined for a directory that does not exist", () => {
    expect(resolveProject("/definitely/not/here")).toBeUndefined();
  });

  it("refuses to guess between two workspaces, and names them", () => {
    const dir = scratch();
    mkdirSync(join(dir, "A.xcworkspace"));
    mkdirSync(join(dir, "B.xcworkspace"));
    expect(() => resolveProject(dir)).toThrow(/A.xcworkspace, B.xcworkspace/);
  });
});

describe("requireProject", () => {
  it("raises a structured error with a way forward", () => {
    const dir = scratch();
    try {
      requireProject(dir);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AxiError);
      expect((error as AxiError).code).toBe("NO_PROJECT");
      expect((error as AxiError).suggestions).not.toHaveLength(0);
    }
  });
});
