import { describe, expect, it } from "vitest";
import { resolveSubject } from "../src/scheme.js";
import { AxiError } from "../src/errors.js";
import type { ProjectContext } from "../src/context.js";

const project: ProjectContext = {
  kind: "project",
  path: "/tmp/MyApp.xcodeproj",
  name: "MyApp",
  flags: ["-project", "/tmp/MyApp.xcodeproj"],
};

const workspace: ProjectContext = { ...project, kind: "workspace" };

describe("resolveSubject", () => {
  it("spells a rerun hint the caller could paste back", async () => {
    // `label` is prose -- "all targets" -- and a hint built from it reads
    // `--target all targets`, which is a command that does not run.
    await expect(
      resolveSubject(project, { targets: [], allTargets: true }, "settings"),
    ).resolves.toEqual({
      label: "all targets",
      slug: "all-targets",
      flags: ["-alltargets"],
      rerun: "--all-targets",
      targetMode: true,
    });

    await expect(
      resolveSubject(
        project,
        { targets: ["MyApp", "MyAppTests"], allTargets: false },
        "settings",
      ),
    ).resolves.toEqual({
      label: "MyApp,MyAppTests",
      slug: "MyApp-MyAppTests",
      flags: ["-target", "MyApp", "-target", "MyAppTests"],
      rerun: "--target MyApp --target MyAppTests",
      targetMode: true,
    });
  });

  // xcodebuild's own refusal here arrives only after it has resolved the whole
  // package graph, which on a large workspace is a minute of waiting for a
  // verdict that was knowable up front.
  it("refuses targets against a workspace", async () => {
    await expect(
      resolveSubject(
        workspace,
        { targets: ["MyApp"], allTargets: false },
        "settings",
      ),
    ).rejects.toThrow(AxiError);
  });

  it("refuses a scheme and targets together", async () => {
    await expect(
      resolveSubject(
        project,
        { scheme: "MyApp", targets: ["MyApp"], allTargets: false },
        "settings",
      ),
    ).rejects.toThrow(AxiError);
  });
});
