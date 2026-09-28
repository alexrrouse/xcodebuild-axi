import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactsDirFrom,
  buildPassthroughArgs,
  buildFailureHints,
} from "../src/action.js";
import { AxiError } from "../src/errors.js";
import { buildCommand, runBuiltTestsHint } from "../src/commands/build.js";

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

describe("build --install-src", () => {
  // The refusal has to land before anything is resolved: installsrc copies
  // gigabytes, and `--install-src --clean` is a sentence with two verbs in it.
  it("refuses to copy sources and build in the same run", async () => {
    await expect(buildCommand(["--install-src", "--clean"])).rejects.toThrow(
      /not a build/,
    );
    await expect(
      buildCommand(["--install-src", "--for-testing"]),
    ).rejects.toThrow(/--for-testing/);
  });
});

const LOCKED =
  'unable to attach DB: error: accessing build database "/tmp/dd/Build/Intermediates.noindex/XCBuildData/build.db": database is locked Possibly there are two concurrent builds running in the same filesystem location.';

describe("buildFailureHints", () => {
  // Issue #38: xcodebuild guesses at a concurrent build and stops there.
  it("points a locked build database at a DerivedData of its own", () => {
    expect(
      buildFailureHints({
        command: "test",
        errors: [{ message: LOCKED }],
        hidden: 0,
        tail: "",
      }),
    ).toEqual([expect.stringMatching(/--derived-data <path>/)]);
  });

  // The bundle can carry only a restatement, with the cause in the log.
  it("finds the lock in the transcript when the bundle does not have it", () => {
    expect(
      buildFailureHints({
        command: "build",
        errors: [{ message: "xcodebuild encountered an error (65)" }],
        hidden: 0,
        tail: `Testing failed:\n\t${LOCKED}\n** TEST FAILED **`,
      }),
    ).toEqual([expect.stringMatching(/--derived-data/)]);
  });

  it("says how to see the errors the cap hid", () => {
    expect(
      buildFailureHints({
        command: "test",
        errors: [{ message: "a" }, { message: "b" }],
        hidden: 1,
        tail: "",
      }),
    ).toEqual([
      "Run `xcodebuild-axi test --max-errors 2` to list all 2 errors",
    ]);
  });

  it("says nothing about any other failure", () => {
    expect(
      buildFailureHints({
        command: "build",
        errors: [{ message: "Cannot find 'total' in scope" }],
        hidden: 0,
        tail: "** BUILD FAILED **",
      }),
    ).toEqual([]);
  });
});

describe("runBuiltTestsHint", () => {
  // `test --without-building` finds the products only for the same scheme,
  // destination and DerivedData, so the flags that chose them carry over.
  it("carries over the flags that chose what was built", () => {
    expect(
      runBuiltTestsHint([
        "--scheme",
        "MyApp",
        "--device",
        "iPhone 17 Pro",
        "--derived-data",
        "/tmp/dd",
        "--for-testing",
        "--clean",
      ]),
    ).toBe(
      'Run `xcodebuild-axi test --without-building --scheme MyApp --device "iPhone 17 Pro" --derived-data /tmp/dd` to run the tests just built',
    );
  });

  // The configuration and settings decide where the products land; a hint
  // without them looks for Debug products after a Release build.
  it("carries everything test accepts, and nothing that only shapes the report", () => {
    expect(
      runBuiltTestsHint([
        "--configuration=Release",
        "--setting",
        "SWIFT_VERSION=6",
        "--max-errors",
        "5",
        "--full",
        "--for-testing",
      ]),
    ).toBe(
      "Run `xcodebuild-axi test --without-building --configuration Release --setting SWIFT_VERSION=6` to run the tests just built",
    );
  });

  it("stays bare when nothing was chosen", () => {
    expect(runBuiltTestsHint(["--for-testing"])).toBe(
      "Run `xcodebuild-axi test --without-building` to run the tests just built",
    );
  });
});
