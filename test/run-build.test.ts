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
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { PROGRESS_BACKLOG_BYTES, runBuild } from "../src/xcodebuild.js";

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
    // Kept as bytes and decoded once, so the sink cannot split a character
    // that the code under test passed through whole.
    const chunks: Buffer[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        if (failing) {
          callback(new Error("EPIPE"));
          return;
        }
        chunks.push(chunk);
        callback();
      },
    });
    return { stream, text: () => Buffer.concat(chunks).toString("utf-8") };
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

    expect(progress.text().startsWith(`log: ${run.logPath}\n`)).toBe(true);
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
    expect(progress.text()).toBe(
      `log: ${join(dir, `MyApp-test-${process.pid}.log`)}\n`,
    );

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

  // Swift diagnostics quote names with curly quotes, and a pipe read can end
  // in the middle of one.
  it("passes a character split across two reads through intact", async () => {
    const dir = fakeXcodebuild(
      `printf '\\342\\200'; sleep 0.2; printf '\\230MyApp\\342\\200\\231\\n'`,
    );
    const progress = sink();
    await runBuild({
      args: [],
      label: "MyApp-test",
      outDir: dir,
      live: true,
      progress: progress.stream,
    });
    expect(progress.text()).toContain("\u2018MyApp\u2019");
    expect(progress.text()).not.toContain("\ufffd");
  });

  /**
   * A reader that stalls without closing: it takes every write and never
   * acknowledges one, the way a paused terminal does.
   */
  function stalledSink() {
    const emitter = new EventEmitter();
    let bytes = 0;
    let text = "";
    const stream = Object.assign(emitter, {
      write(chunk: Buffer | string) {
        bytes += chunk.length;
        if (chunk.length < 1024) text += chunk.toString();
        return false;
      },
    }) as unknown as NodeJS.WritableStream;
    return { stream, emitter, bytes: () => bytes, text: () => text };
  }

  // A hung run that loops on output must not grow the process without limit.
  it("stops buffering for a stalled reader and says what it skipped", async () => {
    const dir = fakeXcodebuild(
      `head -c ${PROGRESS_BACKLOG_BYTES + 2 * 1024 * 1024} /dev/zero | tr '\\0' x`,
    );
    const progress = stalledSink();
    const run = await runBuild({
      args: [],
      label: "MyApp-test",
      outDir: dir,
      live: true,
      progress: progress.stream,
    });
    expect(progress.bytes()).toBeLessThanOrEqual(PROGRESS_BACKLOG_BYTES + 1024);
    expect(progress.text()).toMatch(
      /\[--live skipped \d+ bytes while stderr was not being read; the log has all of it\]/,
    );
    expect(readFileSync(run.logPath).length).toBe(
      PROGRESS_BACKLOG_BYTES + 2 * 1024 * 1024,
    );

    // The report went ahead with writes still queued. The reader failing
    // afterwards must still land on a listener rather than crash the process.
    expect(() =>
      progress.emitter.emit("error", new Error("EPIPE")),
    ).not.toThrow();
  });

  it("names no log when xcodebuild never started", async () => {
    const dir = fakeXcodebuild("exit 0");
    vi.stubEnv("XCODEBUILD_BIN", join(dir, "missing-xcodebuild"));
    const progress = sink();
    await expect(
      runBuild({
        args: [],
        label: "MyApp-test",
        outDir: dir,
        live: true,
        progress: progress.stream,
      }),
    ).rejects.toThrow();
    expect(progress.text()).toBe("");
  });
});

// Issue #35: a run that outlived its tests was handed the same log and bundle
// as the next run of that scheme and device, and reported the second run's
// counts as its own.
describe("runBuild artifacts", () => {
  const created: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
    created.length = 0;
  });

  /**
   * A stand-in that behaves like xcodebuild where it matters here: it refuses
   * a result bundle path that already exists, and writes into the one it is
   * given. `AXI_TAG` says which run it is.
   */
  function fakeXcodebuild(): string {
    const dir = mkdtempSync(join(tmpdir(), "axi-artifacts-"));
    created.push(dir);
    const bin = join(dir, "xcodebuild");
    writeFileSync(
      bin,
      `#!/bin/sh
while [ $# -gt 0 ]; do
  if [ "$1" = "-resultBundlePath" ]; then out="$2"; fi
  shift
done
mkdir "$out" || { echo "error: Existing file at -resultBundlePath"; exit 70; }
echo "$AXI_TAG" > "$out/who"
echo "started $AXI_TAG"
sleep 0.3
echo "finished $AXI_TAG"
`,
    );
    chmodSync(bin, 0o755);
    vi.stubEnv("XCODEBUILD_BIN", bin);
    return join(dir, "out");
  }

  it("gives two concurrent runs of one label a log and bundle each", async () => {
    const dir = fakeXcodebuild();
    const quiet = new Writable({ write: (_chunk, _encoding, done) => done() });

    // The environment is read when each run spawns, which is before the
    // first await, so each run keeps the tag it started with.
    vi.stubEnv("AXI_TAG", "first");
    const first = runBuild({
      args: [],
      label: "MyApp-test",
      outDir: dir,
      progress: quiet,
    });
    vi.stubEnv("AXI_TAG", "second");
    const second = runBuild({
      args: [],
      label: "MyApp-test",
      outDir: dir,
      progress: quiet,
    });
    const [a, b] = await Promise.all([first, second]);

    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.resultPath).not.toBe(b.resultPath);
    expect(a.logPath).not.toBe(b.logPath);
    expect(readFileSync(join(a.resultPath, "who"), "utf-8")).toBe("first\n");
    expect(readFileSync(join(b.resultPath, "who"), "utf-8")).toBe("second\n");
    expect(readFileSync(a.logPath, "utf-8")).toBe(
      "started first\nfinished first\n",
    );
    expect(readFileSync(b.logPath, "utf-8")).toBe(
      "started second\nfinished second\n",
    );
  });

  // The pid is what tells a live run from a finished one, so it is the part
  // of the name that keeps one from being pruned under another.
  it("names a run for the process that wrote it", async () => {
    const dir = fakeXcodebuild();
    const quiet = new Writable({ write: (_chunk, _encoding, done) => done() });
    const run = await runBuild({
      args: [],
      label: "MyApp-test",
      outDir: dir,
      progress: quiet,
    });
    expect(run.resultPath).toBe(
      join(dir, `MyApp-test-${process.pid}.xcresult`),
    );
    expect(run.logPath).toBe(join(dir, `MyApp-test-${process.pid}.log`));
  });
});
