import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { runBuild } from "../src/xcodebuild.js";

// `runBuild` against a stand-in xcodebuild, so what reaches stderr can be
// checked without a project. The fake ignores its arguments, including the
// -resultBundlePath runBuild appends.
describe("runBuild progress", () => {
  const created: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
    created.length = 0;
  });

  function fakeXcodebuild(script: string): string {
    const dir = mkdtempSync(join(tmpdir(), "axi-runbuild-"));
    created.push(dir);
    const bin = join(dir, "xcodebuild");
    writeFileSync(bin, `#!/bin/sh\n${script}\n`);
    chmodSync(bin, 0o755);
    vi.stubEnv("XCODEBUILD_BIN", bin);
    return dir;
  }

  function sink(failing = false) {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        if (failing) {
          callback(new Error("EPIPE"));
          return;
        }
        chunks.push(chunk.toString("utf-8"));
        callback();
      },
    });
    return { stream, text: () => chunks.join("") };
  }

  it("tees the transcript under live, and still writes the log", async () => {
    const dir = fakeXcodebuild(
      `echo "Test Suite 'All tests' started"; echo "warning: stale" >&2; exit 65`,
    );
    const progress = sink();
    const run = await runBuild({
      args: [],
      label: "MyApp-test",
      outDir: dir,
      live: true,
      progress: progress.stream,
    });

    expect(
      progress.text().startsWith(`log: ${join(dir, "MyApp-test.log")}\n`),
    ).toBe(true);
    expect(progress.text()).toContain("Test Suite 'All tests' started");
    expect(progress.text()).toContain("warning: stale");
    const log = readFileSync(run.logPath, "utf-8");
    expect(log).toContain("Test Suite 'All tests' started");
    expect(log).toContain("warning: stale");
    expect(run.exitCode).toBe(65);
  });

  // The case the issue is about: the report names the log only when the run
  // ends, and a wedged run does not end.
  it("names the log while a long run is still going, without the transcript", async () => {
    const dir = fakeXcodebuild(`sleep 1; echo done`);
    const progress = sink();
    const pending = runBuild({
      args: [],
      label: "MyApp-test",
      outDir: dir,
      progress: progress.stream,
      announceAfterMs: 50,
    });

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(progress.text()).toBe(`log: ${join(dir, "MyApp-test.log")}\n`);

    await pending;
    expect(progress.text()).not.toContain("done");
  });

  it("says nothing on a run that finishes quickly", async () => {
    const dir = fakeXcodebuild(`echo done`);
    const progress = sink();
    await runBuild({
      args: [],
      label: "MyApp-test",
      outDir: dir,
      progress: progress.stream,
    });
    expect(progress.text()).toBe("");
  });

  // Under 2>&1 the report must not start mid-line.
  it("ends a live transcript on its own line", async () => {
    const dir = fakeXcodebuild(`printf 'no newline'`);
    const progress = sink();
    await runBuild({
      args: [],
      label: "MyApp-test",
      outDir: dir,
      live: true,
      progress: progress.stream,
    });
    expect(progress.text().endsWith("no newline\n")).toBe(true);
  });

  // `2>&1 | head` closes the reader mid-run. That must cost the stream, not
  // the run or its report.
  it("finishes the run when the reader goes away", async () => {
    const dir = fakeXcodebuild(`echo one; echo two; exit 0`);
    const progress = sink(true);
    progress.stream.on("error", () => {});
    const run = await runBuild({
      args: [],
      label: "MyApp-test",
      outDir: dir,
      live: true,
      progress: progress.stream,
    });
    expect(run.exitCode).toBe(0);
    expect(readFileSync(run.logPath, "utf-8")).toBe("one\ntwo\n");
  });
});
