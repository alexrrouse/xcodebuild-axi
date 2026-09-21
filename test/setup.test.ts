import { describe, expect, it } from "vitest";
import { setupCommand } from "../src/commands/setup.js";

describe("setup hooks", () => {
  // Regression: the SDK infers its hook marker from `process.argv[1]` and only
  // recognizes a `dist/bin/<name>.js` path. Under vitest — as under tsx — that
  // inference fails, which is exactly the shape of the bug this guards. Before
  // the marker was passed explicitly this threw "unable to infer a hook marker
  // from the current process".
  it("reports status without a dist/bin entrypoint to infer from", async () => {
    const output = await setupCommand(["hooks", "--status"]);
    expect(output).toContain("setup: status");
    expect(output).toContain("scope: user");
  });

  it("reports project scope when asked", async () => {
    const output = await setupCommand(["hooks", "--status", "--project"]);
    expect(output).toContain("scope: project");
  });

  it("rejects an unknown target", async () => {
    await expect(setupCommand(["hooced"])).rejects.toThrow(
      /Unknown setup target/,
    );
  });

  it("rejects a missing target", async () => {
    await expect(setupCommand([])).rejects.toThrow(/setup needs a target/);
  });
});
