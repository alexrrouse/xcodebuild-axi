import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleKind, listBundles, newestBundle } from "../src/bundles.js";

describe("bundleKind", () => {
  // `runLabel` writes `<scheme>[-<device>]-<command>`, so the trailing segment
  // is the command. This is what keeps a build bundle from being read as a
  // test result.
  it("reads the command off a bundle name", () => {
    expect(bundleKind("/cache/MyApp-iPhone-17-Pro-26-5-build.xcresult")).toBe(
      "build",
    );
    expect(bundleKind("/cache/MyApp-iPhone-17-Pro-26-5-test.xcresult")).toBe(
      "test",
    );
    expect(bundleKind("/cache/MyApp-analyze.xcresult")).toBe("analyze");
  });

  it("handles a scheme with no device slug", () => {
    expect(bundleKind("/cache/MyApp-build.xcresult")).toBe("build");
  });

  it("falls back rather than returning empty", () => {
    expect(bundleKind("/cache/.xcresult")).toBe("run");
  });
});

describe("newestBundle", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
    created.length = 0;
  });

  /** A cache directory holding `names`, each written `ages[i]` seconds ago. */
  function cache(entries: Record<string, number>): string {
    const dir = mkdtempSync(join(tmpdir(), "axi-bundles-"));
    created.push(dir);
    const now = Date.now() / 1000;
    for (const [name, age] of Object.entries(entries)) {
      const path = join(dir, name);
      if (name.endsWith(".xcresult")) mkdirSync(path);
      else writeFileSync(path, "");
      utimesSync(path, now - age, now - age);
    }
    return dir;
  }

  it("picks the newest bundle and ignores a newer log", () => {
    const dir = cache({
      "MyApp-iPhone-17-Pro-test.xcresult": 600,
      "MyApp-build.xcresult": 60,
      "MyApp-build.log": 1,
    });
    const { chosen, skipped } = newestBundle(dir);
    expect(chosen?.path).toBe(join(dir, "MyApp-build.xcresult"));
    expect(chosen?.kind).toBe("build");
    expect(skipped).toBeUndefined();
  });

  // The UI-probe case: a build that finished after the test run is newer,
  // and has no attachments to export.
  it("passes over a newer build for the last test run, and says so", () => {
    const dir = cache({
      "MyApp-iPhone-17-Pro-test.xcresult": 600,
      "MyApp-build.xcresult": 60,
    });
    const { chosen, skipped } = newestBundle(dir, "test");
    expect(chosen?.path).toBe(join(dir, "MyApp-iPhone-17-Pro-test.xcresult"));
    expect(skipped?.path).toBe(join(dir, "MyApp-build.xcresult"));
  });

  // `tests` enumerates and runs nothing, so its bundle is not a test run.
  it("does not count an enumeration as a test run", () => {
    const dir = cache({ "MyApp-tests.xcresult": 10 });
    const { chosen, skipped } = newestBundle(dir, "test");
    expect(chosen).toBeUndefined();
    expect(skipped?.kind).toBe("tests");
  });

  it("answers nothing, rather than throwing, for a missing or empty directory", () => {
    expect(newestBundle(join(tmpdir(), "axi-does-not-exist"))).toEqual({});
    expect(newestBundle(cache({}))).toEqual({});
  });

  it("orders equal times by name, so the answer is the same every call", () => {
    const dir = cache({ "B-test.xcresult": 5, "A-test.xcresult": 5 });
    expect(listBundles(dir).map((bundle) => bundle.kind)).toEqual([
      "test",
      "test",
    ]);
    expect(newestBundle(dir).chosen?.path).toBe(join(dir, "A-test.xcresult"));
  });
});
