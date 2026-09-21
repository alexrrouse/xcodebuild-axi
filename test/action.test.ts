import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactsDirFrom, buildPassthroughArgs } from "../src/action.js";
import { AxiError } from "../src/errors.js";

describe("build passthrough flags", () => {
  it("passes nothing when nothing is asked for", () => {
    expect(buildPassthroughArgs([], "build")).toEqual([]);
  });

  it("maps log levels to xcodebuild's own switches", () => {
    expect(buildPassthroughArgs(["--log-level", "quiet"], "build")).toEqual([
      "-quiet",
    ]);
    expect(buildPassthroughArgs(["--log-level", "verbose"], "build")).toEqual([
      "-verbose",
    ]);
    // `normal` is the default, so it maps to no flag rather than to an error.
    expect(buildPassthroughArgs(["--log-level", "normal"], "build")).toEqual(
      [],
    );
  });

  it("rejects a log level xcodebuild does not have", () => {
    expect(() =>
      buildPassthroughArgs(["--log-level", "loud"], "build"),
    ).toThrow(AxiError);
  });

  it("sets both codesize flags together, since one alone does nothing", () => {
    expect(buildPassthroughArgs(["--codesize", "/tmp/out"], "build")).toEqual([
      "-enableCodesizeProfile",
      "YES",
      "-codesizeProfileOutputDir",
      "/tmp/out",
    ]);
  });

  it("passes the result bundle version through", () => {
    expect(buildPassthroughArgs(["--bundle-version", "3"], "build")).toEqual([
      "-resultBundleVersion",
      "3",
    ]);
  });

  it("creates the stream file, because xcodebuild requires it to exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "xcodebuild-axi-stream-"));
    const path = join(dir, "nested", "stream.txt");
    try {
      expect(buildPassthroughArgs(["--stream", path], "build")).toEqual([
        "-resultStreamPath",
        path,
      ]);
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("artifacts dir", () => {
  it("stays out of the way when not asked for", () => {
    expect(artifactsDirFrom([])).toBeUndefined();
  });

  it("passes an absolute path through", () => {
    expect(artifactsDirFrom(["--artifacts-dir", "/tmp/out"])).toBe("/tmp/out");
  });

  // The CI case: a workflow says `build/` meaning the workspace it checked
  // out, and the run happens from somewhere else entirely.
  it("resolves a relative path against the working directory", () => {
    expect(artifactsDirFrom(["--artifacts-dir", "build"])).toBe(
      join(process.cwd(), "build"),
    );
  });
});
