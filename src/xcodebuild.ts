import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { AxiError, xcodeNotInstalledError } from "./errors.js";
import type { ProjectContext } from "./context.js";
import { renderFields, tildePath } from "./toon.js";

const MAX_METADATA_BYTES = 8 * 1024 * 1024;

/** Override the wrapped binary. Unset keeps the PATH lookup. */
export function xcodebuildBin(): string {
  const fromEnv = process.env["XCODEBUILD_BIN"]?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : "xcodebuild";
}

export interface MetadataResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a short, read-only xcodebuild invocation and buffer its output.
 *
 * Only for the `-list`/`-showdestinations`/`-showBuildSettings` family, whose
 * output is measured in kilobytes. Builds and tests go through `runBuild`,
 * which never holds a transcript in memory.
 */
export function runMetadata(args: string[]): Promise<MetadataResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      xcodebuildBin(),
      args,
      { maxBuffer: MAX_METADATA_BYTES, encoding: "utf-8" },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          rejectPromise(xcodeNotInstalledError());
          return;
        }
        if (
          error &&
          (error as NodeJS.ErrnoException).code ===
            "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
        ) {
          rejectPromise(
            new AxiError(
              "xcodebuild produced more output than this command buffers",
              "UNKNOWN",
              [
                "Use `xcodebuild-axi build` or `test`, which stream to a log instead",
              ],
            ),
          );
          return;
        }
        resolvePromise({
          stdout,
          stderr,
          exitCode:
            typeof error?.code === "number" ? error.code : error ? 1 : 0,
        });
      },
    );
  });
}

export interface BuildRun {
  exitCode: number;
  logPath: string;
  resultPath: string;
  /** Wall-clock seconds the invocation took. */
  seconds: number;
  /** The tail of the transcript, for failures no result bundle explains. */
  tail: string;
}

export interface BuildRunOptions {
  args: string[];
  /** Filename stem for the log and result bundle, e.g. "MyApp-iPhone-17-Pro". */
  label: string;
  /** Omit for invocations that act on the toolchain rather than a project. */
  project?: ProjectContext;
  /** Overrides the cache location for both artifacts. */
  outDir?: string;
  /** Tee the transcript to `progress` as it arrives, as well as to the log. */
  live?: boolean;
  /** Where the log path and a live transcript go. Default: stderr. */
  progress?: NodeJS.WritableStream;
  /** How long a run goes before its log path is announced. */
  announceAfterMs?: number;
}

/**
 * Past this, a run announces where its log is, so a wedged one can be tailed
 * while it hangs. The report prints the same path, but only when the run
 * ends -- which is the case that does not happen. Anything faster never
 * needed a tail, and a line on every quick incremental build would cost a
 * third of the report it precedes.
 */
export const ANNOUNCE_AFTER_MS = 30_000;

/** How long the report waits for a slow stderr reader before going ahead. */
const PROGRESS_DRAIN_MS = 2_000;

/**
 * Run a build or test, streaming the transcript straight to disk.
 *
 * The transcript is the thing this tool exists to keep out of the agent's
 * context, so it is never buffered: a single passing test run of one app in a
 * real repo measured 549 KB, and a full verify run 2.5 MB. Only the last few
 * KB are kept in memory, for the failures that produce no result bundle.
 *
 * Nothing but the report goes to stdout. What is for watching a run -- the log
 * path once it has gone on a while, and the transcript under `live` -- goes to
 * `progress`, which is stderr, so stdout is the same with or without it.
 */
export function runBuild(options: BuildRunOptions): Promise<BuildRun> {
  const dir =
    options.outDir ??
    (options.project ? artifactDir(options.project) : globalArtifactDir());
  mkdirSync(dir, { recursive: true });

  const logPath = join(dir, `${options.label}.log`);
  const resultPath = join(dir, `${options.label}.xcresult`);

  // xcodebuild refuses to write over an existing result bundle and dies before
  // running anything — "error: Existing file at -resultBundlePath". The bundle
  // is our artifact, not the user's, so clear it rather than make every caller
  // remember to.
  rmSync(resultPath, { recursive: true, force: true });

  const args = [...options.args, "-resultBundlePath", resultPath];
  const started = Date.now();

  const progress = options.progress ?? process.stderr;
  const watcher = watchRun(progress, logPath);

  return new Promise((resolvePromise, rejectPromise) => {
    const log = createWriteStream(logPath);
    const child = spawn(xcodebuildBin(), args, {
      cwd: process.cwd(),
      // NSUnbufferedIO makes xcodebuild flush per line, so a wedged run leaves
      // a usable log instead of an empty one.
      env: { ...process.env, NSUnbufferedIO: "YES" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const tail: string[] = [];
    const keepTail = (chunk: Buffer) => {
      tail.push(chunk.toString("utf-8"));
      while (tail.length > 40) tail.shift();
    };

    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.stdout.on("data", keepTail);
    child.stderr.on("data", keepTail);

    if (options.live) {
      watcher.announce();
      child.stdout.on("data", watcher.write);
      child.stderr.on("data", watcher.write);
    }
    const timer = options.live
      ? undefined
      : setTimeout(
          watcher.announce,
          options.announceAfterMs ?? ANNOUNCE_AFTER_MS,
        );
    timer?.unref();

    child.on("error", (error) => {
      clearTimeout(timer);
      watcher.detach();
      log.end();
      rejectPromise(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? xcodeNotInstalledError()
          : error,
      );
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      log.end(() =>
        watcher.settle().then(() =>
          resolvePromise({
            exitCode: code ?? 1,
            logPath,
            resultPath,
            seconds: (Date.now() - started) / 1000,
            tail: tail.join("").slice(-8000),
          }),
        ),
      );
    });
  });
}

/**
 * Everything `runBuild` says while a run is going, rather than after it.
 *
 * The tee ignores backpressure on purpose. Piping into a slow stderr reader
 * would pause the child's stdout, and xcodebuild would block on its own
 * writes: watching the run would stall it. Buffering instead is bounded by
 * the transcript, a few MB at worst.
 *
 * A reader that goes away (`2>&1 | head`) is an EPIPE on stderr, which the
 * SDK does not handle the way it does stdout. Unhandled, it would kill the
 * process before the report, so a failed sink is simply stopped writing to.
 */
function watchRun(progress: NodeJS.WritableStream, logPath: string) {
  let announced = false;
  let broken = false;
  let pending = 0;
  let lastByte = "\n";
  let drained: (() => void) | undefined;

  const onError = () => {
    broken = true;
    drained?.();
  };
  progress.on("error", onError);

  const send = (text: string) => {
    if (broken || text.length === 0) return;
    pending += 1;
    lastByte = text.slice(-1);
    progress.write(text, (error) => {
      if (error) broken = true;
      pending -= 1;
      if (pending === 0) drained?.();
    });
  };

  const detach = () => progress.removeListener("error", onError);

  return {
    announce() {
      if (announced) return;
      announced = true;
      send(`${renderFields({ log: tildePath(logPath) })}\n`);
    },
    write(chunk: Buffer) {
      send(chunk.toString("utf-8"));
    },
    detach,
    /**
     * Finish the transcript on its own line and let it drain, so under
     * `2>&1` the report does not start mid-line or land inside it. Capped,
     * so a reader that never drains cannot hold the report hostage.
     */
    settle(): Promise<void> {
      if (announced && lastByte !== "\n") send("\n");
      return new Promise<void>((done) => {
        const finish = () => {
          clearTimeout(cap);
          detach();
          done();
        };
        const cap = setTimeout(finish, PROGRESS_DRAIN_MS);
        if (broken || pending === 0) finish();
        else drained = finish;
      });
    },
  };
}

/**
 * Where toolchain-level runs land — platform downloads and the like, which
 * belong to the machine rather than to any one project.
 */
export function globalArtifactDir(): string {
  return join(homedir(), "Library", "Caches", "xcodebuild-axi", "toolchain");
}

/**
 * Where logs and result bundles land.
 *
 * Under the user's cache directory rather than the repo, so running this tool
 * never dirties a working tree or a `.gitignore`. The project path is hashed
 * into the name so two checkouts of the same repo do not collide.
 */
export function artifactDir(project: ProjectContext): string {
  const hash = createHash("sha256")
    .update(project.path)
    .digest("hex")
    .slice(0, 8);
  return join(
    homedir(),
    "Library",
    "Caches",
    "xcodebuild-axi",
    `${project.name}-${hash}`,
  );
}

/**
 * Where something exported out of a result bundle lands.
 *
 * Keyed on the bundle rather than on the project, because `result` takes an
 * arbitrary path and may be pointed at a bundle from anywhere — including a
 * CI artifact in a checked-out repository, which is exactly the tree that must
 * not be dirtied by asking what is in it.
 */
export function exportDir(bundlePath: string, kind: string): string {
  const hash = createHash("sha256")
    .update(bundlePath)
    .digest("hex")
    .slice(0, 8);
  const stem = basename(bundlePath).replace(/\.xcresult$/, "");
  return join(
    homedir(),
    "Library",
    "Caches",
    "xcodebuild-axi",
    "exports",
    `${stem}-${hash}`,
    kind,
  );
}

/**
 * Where a merged bundle lands when the caller did not say.
 *
 * Hashed over every input rather than just the first, so merging a different
 * set of shards does not quietly overwrite the last merge of a different set.
 */
export function mergedBundlePath(paths: string[]): string {
  const hash = createHash("sha256")
    .update(paths.join("\n"))
    .digest("hex")
    .slice(0, 8);
  return join(
    homedir(),
    "Library",
    "Caches",
    "xcodebuild-axi",
    "exports",
    `merged-${hash}`,
    "merged.xcresult",
  );
}

/** Where a merged coverage report and archive land when nobody said. */
export function mergedCoveragePath(paths: string[]): string {
  const hash = createHash("sha256")
    .update(paths.join("\n"))
    .digest("hex")
    .slice(0, 8);
  return join(
    homedir(),
    "Library",
    "Caches",
    "xcodebuild-axi",
    "exports",
    `coverage-${hash}`,
    "merged.xccovreport",
  );
}

/**
 * Where a screenshot or a screen recording lands.
 *
 * Under the cache directory like everything else this tool writes, and named
 * for the device and the moment so a second capture does not overwrite the
 * first -- the usual reason for taking two is to compare them.
 */
export function capturePath(device: string, extension: string): string {
  const slug = device.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return join(
    homedir(),
    "Library",
    "Caches",
    "xcodebuild-axi",
    "captures",
    `${slug}-${stamp}.${extension}`,
  );
}

/**
 * Strip xcodebuild's fixed preamble.
 *
 * Every invocation — including the read-only ones — reprints the command line,
 * "Resolve Package Graph", and the full resolved package list. In a workspace
 * with 16 local packages that is ~1.2 KB of identical text in front of a 349-byte
 * answer, paid on every call.
 */
export function stripPreamble(output: string): string {
  const lines = output.split("\n");
  const kept: string[] = [];
  let skippingPackageList = false;

  for (const line of lines) {
    if (skippingPackageList) {
      // The list is indented; the first unindented line ends it.
      if (line.trim().length === 0 || /^\s/.test(line)) continue;
      skippingPackageList = false;
    }
    if (/^Resolved source packages:/.test(line)) {
      skippingPackageList = true;
      continue;
    }
    if (NOISE.some((pattern) => pattern.test(line))) continue;
    kept.push(line);
  }

  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const NOISE: RegExp[] = [
  /^Command line invocation:/,
  /^\s+\/.*\/xcodebuild /,
  /^Resolve Package Graph$/,
  /^Prepare packages$/,
  /^User defaults from command line:/,
  /^Build settings from command line:/,
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+ xcodebuild\[\d+:\d+\]/,
  /^note: /,
];
