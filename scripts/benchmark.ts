/**
 * Measure what this tool actually saves, by running both sides.
 *
 * Every number in the README comes from here: the same question asked of raw
 * `xcodebuild` and of `xcodebuild-axi`, against a real project, with both
 * answers tokenized. Nothing is estimated — if a scenario cannot run on this
 * machine it is reported as skipped rather than guessed at.
 *
 *   npm run benchmark -- --project ~/Developer/Saalt-iOS --scheme Tides
 *   npm run benchmark -- --project ... --scheme ... --quick   # no build or test
 *   npm run benchmark -- --project ... --scheme ... --write   # update README
 *   npm run benchmark -- --project ... --scheme ... --resume  # reuse finished scenarios
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "gpt-tokenizer/model/gpt-4o";
import { format, resolveConfig } from "prettier";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "bin", "xcodebuild-axi.ts");
const readmePath = join(root, "README.md");
const START = "<!-- benchmark:start -->";
const END = "<!-- benchmark:end -->";

interface Scenario {
  name: string;
  /** What the agent is actually trying to find out. */
  question: string;
  raw: string[];
  axi: string[];
  /** Builds and tests take minutes; `--quick` skips them. */
  slow?: boolean;
  /** Wipe both derived-data directories first, so each side builds from cold. */
  cold?: boolean;
}

/**
 * Builds and tests get one derived-data directory per side.
 *
 * Otherwise whichever side runs second builds incrementally, prints a
 * fraction of the output, and wins on a difference that has nothing to do
 * with this tool. Each side starts cold and builds the same work; the test
 * scenario then reuses its own side's directory, so both are equally warm.
 */
const RAW_DERIVED = join(tmpdir(), "xcodebuild-axi-bench", "raw");
const AXI_DERIVED = join(tmpdir(), "xcodebuild-axi-bench", "axi");

function scenarios(scheme: string, device: string): Scenario[] {
  return [
    {
      name: "schemes",
      question: "what can I build?",
      raw: ["-list"],
      axi: ["schemes"],
    },
    {
      name: "destinations",
      question: "what can I run it on?",
      raw: ["-showdestinations", "-scheme", scheme],
      axi: ["destinations", "--scheme", scheme],
    },
    {
      name: "settings",
      question: "what is the bundle id?",
      raw: ["-scheme", scheme, "-showBuildSettings"],
      axi: [
        "settings",
        "--scheme",
        scheme,
        "--key",
        "PRODUCT_BUNDLE_IDENTIFIER",
      ],
    },
    {
      name: "index-settings",
      question: "which targets have index settings?",
      raw: ["-scheme", scheme, "-showBuildSettingsForIndex", "-json"],
      axi: ["settings", "--scheme", scheme, "--for-index"],
    },
    {
      name: "sdks",
      question: "which SDKs are installed?",
      raw: ["-showsdks"],
      axi: ["info", "--sdks"],
    },
    {
      name: "testplans",
      question: "which test plans does this scheme have?",
      raw: ["-scheme", scheme, "-showTestPlans"],
      axi: ["testplans", "--scheme", scheme],
    },
    {
      name: "build",
      question: "did it build, and if not where?",
      raw: [
        "-scheme",
        scheme,
        "-destination",
        `platform=iOS Simulator,name=${device}`,
        "-skipMacroValidation",
        "-derivedDataPath",
        RAW_DERIVED,
        "CODE_SIGNING_ALLOWED=NO",
        "build",
      ],
      axi: [
        "build",
        "--scheme",
        scheme,
        "--device",
        device,
        "--derived-data",
        AXI_DERIVED,
      ],
      slow: true,
      cold: true,
    },
    {
      name: "test",
      question: "did the tests pass, and which failed?",
      raw: [
        "-scheme",
        scheme,
        "-destination",
        `platform=iOS Simulator,name=${device}`,
        "-skipMacroValidation",
        "-derivedDataPath",
        RAW_DERIVED,
        "CODE_SIGNING_ALLOWED=NO",
        "test",
      ],
      axi: [
        "test",
        "--scheme",
        scheme,
        "--device",
        device,
        "--derived-data",
        AXI_DERIVED,
      ],
      slow: true,
    },
  ];
}

interface Measurement {
  bytes: number;
  tokens: number;
  lines: number;
  seconds: number;
  exitCode: number;
}

function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<Measurement> {
  const started = Date.now();
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, NSUnbufferedIO: "YES" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Counted per chunk rather than buffered. A raw `test` transcript runs to
    // hundreds of megabytes, and holding one in memory to measure how big it
    // is would be a poor advertisement for this tool — the first run of this
    // script did exactly that and took the machine down with it.
    let bytes = 0;
    let tokens = 0;
    let lines = 1;
    // A chunk can split a multi-byte character or a token; carry the tail of
    // each chunk to the next so the count stays close to a whole-text encode.
    let carry = "";
    const decoder = new StringDecoder("utf8");

    const consume = (chunk: Buffer) => {
      bytes += chunk.length;
      const text = carry + decoder.write(chunk);
      const split = text.lastIndexOf("\n");
      if (split === -1) {
        carry = text;
        return;
      }
      const whole = text.slice(0, split + 1);
      carry = text.slice(split + 1);
      tokens += encode(whole).length;
      for (const character of whole) if (character === "\n") lines += 1;
    };

    // Both streams count: an agent running this in a shell sees both.
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      const rest = carry + decoder.end();
      if (rest.length > 0) tokens += encode(rest).length;
      resolvePromise({
        bytes,
        tokens,
        lines,
        seconds: (Date.now() - started) / 1000,
        exitCode: code ?? 1,
      });
    });
  });
}

interface Result {
  scenario: Scenario;
  raw: Measurement;
  axi: Measurement;
}

function flag(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function percent(before: number, after: number): string {
  if (before === 0) return "—";
  return `${((1 - after / before) * 100).toFixed(2)}%`;
}

function thousands(value: number): string {
  return value.toLocaleString("en-US");
}

const project = flag("project");
const scheme = flag("scheme");
const device = flag("device", "iPhone 17 Pro") as string;
const quick = process.argv.includes("--quick");
const write = process.argv.includes("--write");

if (!project || !scheme) {
  console.error(
    "usage: npm run benchmark -- --project <path> --scheme <name> [--device <name>] [--quick] [--write]",
  );
  process.exit(2);
}

// `--only` exists because the slow scenarios drive a cold build each and can
// exhaust a machine when run back to back. Taking them one at a time, with
// `--resume`, gets the same table without that risk.
const only = flag("only")
  ?.split(",")
  .map((name) => name.trim())
  .filter((name) => name.length > 0);

const chosen = scenarios(scheme, device).filter(
  (scenario) =>
    !(quick && scenario.slow) && (!only || only.includes(scenario.name)),
);

if (chosen.length === 0) {
  console.error(
    `no scenarios match --only ${only?.join(",")}; known: ${scenarios(
      scheme,
      device,
    )
      .map((scenario) => scenario.name)
      .join(", ")}`,
  );
  process.exit(2);
}

/**
 * Results are written after every scenario, not at the end.
 *
 * A full run drives four cold builds and takes the better part of an hour, so
 * losing all of it to one interruption is not acceptable — the first attempt
 * was killed on the last scenario and took every earlier number with it.
 * `--resume` picks up whatever is already on disk.
 */
const cachePath = join(tmpdir(), `xcodebuild-axi-bench-${scheme}.json`);
const cache: Record<string, { raw: Measurement; axi: Measurement }> =
  process.argv.includes("--resume") && existsSync(cachePath)
    ? JSON.parse(readFileSync(cachePath, "utf-8"))
    : {};

const chosenNames = new Set(chosen.map((scenario) => scenario.name));

const results: Result[] = [];
for (const scenario of scenarios(scheme, device)) {
  // A filtered run still reports every scenario already on disk, so `--write`
  // never silently shrinks the table to whatever this invocation happened to
  // re-measure. Matched by name: `scenarios()` builds fresh objects each call.
  if (chosenNames.has(scenario.name)) continue;
  const previous = cache[scenario.name];
  if (previous) results.push({ scenario, ...previous });
}

for (const scenario of chosen) {
  const cached = cache[scenario.name];
  if (cached) {
    results.push({ scenario, ...cached });
    process.stderr.write(`${scenario.name}… cached\n`);
    continue;
  }

  process.stderr.write(`${scenario.name}… `);
  if (scenario.cold) {
    rmSync(RAW_DERIVED, { recursive: true, force: true });
    rmSync(AXI_DERIVED, { recursive: true, force: true });
  }
  const raw = await run("xcodebuild", scenario.raw, project);
  const axi = await run("npx", ["tsx", cli, ...scenario.axi], project);

  results.push({ scenario, raw, axi });
  cache[scenario.name] = { raw, axi };
  writeFileSync(cachePath, JSON.stringify(cache, null, 2));

  process.stderr.write(
    `${thousands(raw.tokens)} -> ${thousands(axi.tokens)} tokens (${percent(raw.tokens, axi.tokens)})\n`,
  );
}

// The derived-data directories are ~2.5 GB each and have served their purpose.
if (chosen.some((scenario) => scenario.slow)) {
  rmSync(RAW_DERIVED, { recursive: true, force: true });
  rmSync(AXI_DERIVED, { recursive: true, force: true });
}

const order = scenarios(scheme, device).map((scenario) => scenario.name);
results.sort(
  (a, b) => order.indexOf(a.scenario.name) - order.indexOf(b.scenario.name),
);

const totalRaw = results.reduce((sum, result) => sum + result.raw.tokens, 0);
const totalAxi = results.reduce((sum, result) => sum + result.axi.tokens, 0);

const table = [
  "| Question | `xcodebuild` | `xcodebuild-axi` | Saved |",
  "| --- | --- | --- | --- |",
  ...results.map(
    ({ scenario, raw, axi }) =>
      `| ${scenario.question} | ${thousands(raw.tokens)} tok | ${thousands(axi.tokens)} tok | **${percent(raw.tokens, axi.tokens)}** |`,
  ),
  `| **all ${results.length} together** | **${thousands(totalRaw)} tok** | **${thousands(totalAxi)} tok** | **${percent(totalRaw, totalAxi)}** |`,
].join("\n");

const detail = results
  .map(
    ({ scenario, raw, axi }) =>
      `${scenario.name}: ${thousands(raw.bytes)}B/${raw.lines} lines in ${raw.seconds.toFixed(1)}s -> ${thousands(axi.bytes)}B/${axi.lines} lines in ${axi.seconds.toFixed(1)}s` +
      (raw.exitCode !== axi.exitCode
        ? `  (exit ${raw.exitCode} vs ${axi.exitCode})`
        : ""),
  )
  .join("\n");

console.log(`\n${table}\n\n${detail}`);

if (!write) {
  console.log("\nPass --write to put this in the README.");
} else {
  const readme = readFileSync(readmePath, "utf-8");
  const from = readme.indexOf(START);
  const to = readme.indexOf(END);
  if (from < 0 || to < 0) {
    console.error(`README.md is missing the ${START} / ${END} markers`);
    process.exit(1);
  }

  const section = [
    START,
    "",
    table,
    "",
    `Token counts are GPT-4o BPE via \`gpt-tokenizer\` — Anthropic's tokenizer is not public, so this is a stand-in, and the ratios are what matter rather than the absolute numbers. Both stdout and stderr are counted, because that is what an agent running the command in a shell actually reads. Measured by \`npm run benchmark\` against ${scheme} in a real workspace on ${new Date().toISOString().slice(0, 10)}.`,
    "",
    END,
  ].join("\n");

  const prettierConfig = await resolveConfig(readmePath);
  writeFileSync(
    readmePath,
    await format(
      `${readme.slice(0, from)}${section}${readme.slice(to + END.length)}`,
      { ...prettierConfig, filepath: readmePath },
    ),
  );
  console.log("\nREADME.md updated.");
}
