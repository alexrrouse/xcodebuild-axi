import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  bundleKind,
  listBundles,
  newestBundle,
  pruneRuns,
  runStem,
  runStillGoing,
} from "../src/bundles.js";

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

  // The one command whose name has hyphens of its own; split naively it read
  // as "testing".
  it("reads build-for-testing whole", () => {
    expect(
      bundleKind(
        "/cache/MyApp-iPhone-17-Pro-26-5-build-for-testing-4821.xcresult",
      ),
    ).toBe("build-for-testing");
    expect(bundleKind("/cache/MyApp-build-for-testing.xcresult")).toBe(
      "build-for-testing",
    );
  });

  it("handles a scheme with no device slug", () => {
    expect(bundleKind("/cache/MyApp-build.xcresult")).toBe("build");
  });

  // Every run now carries the pid that wrote it, and a second run of one label
  // in one process a counter after that. Neither is the command.
  it("reads past a per-run suffix", () => {
    expect(
      bundleKind("/cache/MyApp-iPhone-17-Pro-26-5-test-4821.xcresult"),
    ).toBe("test");
    expect(bundleKind("/cache/MyApp-build-4821-2.xcresult")).toBe("build");
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

  it("passes over a newer build for the last test run when both carry a pid", () => {
    const dir = cache({
      "MyApp-iPhone-17-Pro-26-5-test-4821.xcresult": 600,
      "MyApp-build-5102.xcresult": 60,
    });
    const { chosen, skipped } = newestBundle(dir, "test");
    expect(chosen?.path).toBe(
      join(dir, "MyApp-iPhone-17-Pro-26-5-test-4821.xcresult"),
    );
    expect(skipped?.kind).toBe("build");
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

describe("runStillGoing", () => {
  const now = Date.now();
  const at = (ms: number) => new Date(ms).toString();

  it("counts a live process that started before the run's files", () => {
    expect(runStillGoing(process.pid, now, () => at(now - 60_000))).toBe(true);
  });

  // After a reboot, low pids come round again and can live for days. A
  // process that started after the run's first file cannot have written it.
  it("does not count a reused pid", () => {
    expect(runStillGoing(process.pid, now - 3_600_000, () => at(now))).toBe(
      false,
    );
  });

  it("does not count a process that is gone", () => {
    expect(runStillGoing(2 ** 22 + 1, now, () => undefined)).toBe(false);
  });
});

describe("runStem", () => {
  it("names a run for its label and the process that wrote it", () => {
    expect(runStem("MyApp-test", 4821)).toBe("MyApp-test-4821");
    expect(runStem("MyApp-test", 4821, 2)).toBe("MyApp-test-4821-2");
  });
});

describe("pruneRuns", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
    created.length = 0;
  });

  /** A directory holding `entries`, each written that many seconds ago. */
  function cache(entries: Record<string, number>): string {
    const dir = mkdtempSync(join(tmpdir(), "axi-prune-"));
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

  function prune(dir: string, label: string, live: number[] = []) {
    const exports = join(dir, "exports");
    const removed = pruneRuns(dir, label, {
      alive: (pid) => live.includes(pid),
      exportRoot: (bundle) =>
        join(exports, basename(bundle).replace(/\.xcresult$/, "")),
    });
    return { removed: removed.map((path) => basename(path)).sort(), exports };
  }

  // The bug this exists for: a run that has not finished reading its own
  // bundle must never lose it to the next run of the same label.
  it("keeps every run whose process is still alive", () => {
    const dir = cache({
      "MyApp-test-100.xcresult": 900,
      "MyApp-test-100.log": 900,
      "MyApp-test-200.xcresult": 600,
      "MyApp-test-300.xcresult": 300,
    });
    expect(prune(dir, "MyApp-test", [100, 200]).removed).toEqual([]);
    expect(existsSync(join(dir, "MyApp-test-100.xcresult"))).toBe(true);
  });

  it("keeps the newest finished bundle and removes everything of the older runs", () => {
    const dir = cache({
      "MyApp-test-100.xcresult": 900,
      "MyApp-test-100.log": 900,
      "MyApp-tests-150.json": 800,
      "MyApp-run-160-console.log": 800,
      "MyApp-test-200.xcresult": 600,
      "MyApp-test-200.log": 600,
      "MyApp-test-200-2.log": 500,
    });
    mkdirSync(join(dir, "exports", "MyApp-test-100"), { recursive: true });

    const { removed, exports } = prune(dir, "MyApp-test");
    expect(removed).toEqual([
      "MyApp-test-100",
      "MyApp-test-100.log",
      "MyApp-test-100.xcresult",
      "MyApp-test-200-2.log",
    ]);
    expect(existsSync(join(exports, "MyApp-test-100"))).toBe(false);
    expect(existsSync(join(dir, "MyApp-test-200.xcresult"))).toBe(true);
    // Other labels are not this run's to clean up.
    expect(existsSync(join(dir, "MyApp-tests-150.json"))).toBe(true);
    expect(existsSync(join(dir, "MyApp-run-160-console.log"))).toBe(true);
  });

  it("recognises every artifact a run leaves beside its bundle", () => {
    const dir = cache({
      "MyApp-tests-150.json": 900,
      "MyApp-tests-150.log": 900,
      "MyApp-tests-150.xcresult": 900,
      "MyApp-tests-250.xcresult": 100,
    });
    expect(prune(dir, "MyApp-tests").removed).toEqual([
      "MyApp-tests-150.json",
      "MyApp-tests-150.log",
      "MyApp-tests-150.xcresult",
    ]);

    const run = cache({
      "MyApp-run-160-console.log": 900,
      "MyApp-run-160.log": 900,
      "MyApp-run-260.xcresult": 100,
    });
    expect(prune(run, "MyApp-run").removed).toEqual([
      "MyApp-run-160-console.log",
      "MyApp-run-160.log",
    ]);
  });

  // A `run --no-build` leaves only a console, and a run killed before
  // xcodebuild started only an empty log. Neither is a run anyone can read a
  // result from, so neither may push the last real bundle out.
  it("keeps the last bundle past newer runs that wrote none", () => {
    const dir = cache({
      "MyApp-run-100.xcresult": 900,
      "MyApp-run-100.log": 900,
      "MyApp-run-200-console.log": 600,
      "MyApp-run-300.log": 300,
    });
    expect(prune(dir, "MyApp-run").removed).toEqual([
      "MyApp-run-200-console.log",
      "MyApp-run-300.log",
    ]);
    expect(existsSync(join(dir, "MyApp-run-100.xcresult"))).toBe(true);
  });

  // Written before runs carried a pid. Treated as finished, so the first new
  // run keeps it as the previous one and the second removes it.
  it("ages out a bundle from before runs were suffixed", () => {
    const dir = cache({
      "MyApp-test.xcresult": 900,
      "MyApp-test.log": 900,
    });
    expect(prune(dir, "MyApp-test").removed).toEqual([]);

    const now = Date.now() / 1000;
    mkdirSync(join(dir, "MyApp-test-4821.xcresult"));
    utimesSync(join(dir, "MyApp-test-4821.xcresult"), now, now);
    expect(prune(dir, "MyApp-test").removed).toEqual([
      "MyApp-test.log",
      "MyApp-test.xcresult",
    ]);
  });

  it("never touches a label that merely starts the same way, or other files", () => {
    const dir = cache({
      "MyApp-test-100.xcresult": 900,
      "MyApp-test-200.xcresult": 100,
      "MyApp-tests-300.xcresult": 1000,
      "MyApp-test-extra-400.xcresult": 1000,
      "MyApp.xcarchive": 1000,
      "notes.txt": 1000,
    });
    expect(prune(dir, "MyApp-test").removed).toEqual([
      "MyApp-test-100.xcresult",
    ]);
    for (const name of [
      "MyApp-tests-300.xcresult",
      "MyApp-test-extra-400.xcresult",
      "MyApp.xcarchive",
      "notes.txt",
    ]) {
      expect(existsSync(join(dir, name))).toBe(true);
    }
  });

  it("answers nothing, rather than throwing, for a directory it cannot read", () => {
    expect(
      pruneRuns(join(tmpdir(), "axi-does-not-exist"), "MyApp-test"),
    ).toEqual([]);
  });
});
