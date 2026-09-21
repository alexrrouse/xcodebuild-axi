import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AxiError, xcodeNotInstalledError } from "./errors.js";
import type { ProjectContext } from "./context.js";

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
  /** Filename stem for the log and result bundle, e.g. "Futures-iPhone-17-Pro". */
  label: string;
  /** Omit for invocations that act on the toolchain rather than a project. */
  project?: ProjectContext;
  /** Overrides the cache location for both artifacts. */
  outDir?: string;
}

/**
 * Run a build or test, streaming the transcript straight to disk.
 *
 * The transcript is the thing this tool exists to keep out of the agent's
 * context, so it is never buffered: a single passing test run of one app in a
 * real repo measured 549 KB, and a full verify run 2.5 MB. Only the last few
 * KB are kept in memory, for the failures that produce no result bundle.
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

    child.on("error", (error) => {
      log.end();
      rejectPromise(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? xcodeNotInstalledError()
          : error,
      );
    });

    child.on("close", (code) => {
      log.end(() =>
        resolvePromise({
          exitCode: code ?? 1,
          logPath,
          resultPath,
          seconds: (Date.now() - started) / 1000,
          tail: tail.join("").slice(-8000),
        }),
      );
    });
  });
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
