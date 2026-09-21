import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AxiError, mapXcodebuildError } from "../errors.js";
import {
  BUILD_FLAG_HELP,
  resolveBuildContext,
  runAction,
  runLabel,
  SHARED_BUILD_FLAGS,
  SHARED_BUILD_VALUE_FLAGS,
} from "../action.js";
import { artifactDir } from "../xcodebuild.js";
import {
  duration,
  renderFields,
  renderHelp,
  renderList,
  renderOutput,
  tildePath,
} from "../toon.js";
import { getFlag, getIntFlag, hasFlag, rejectUnknownFlags } from "../args.js";

export const TESTS_HELP = `usage: xcodebuild-axi tests [flags]
Lists the tests a scheme would run, without running them. Grouped by suite,
because a thousand identifiers is not an answer.
flags[42]:
${BUILD_FLAG_HELP}
  --test-plan <name>  test plan to enumerate
  --filter <text>     only suites or tests whose identifier contains this
  --list              print every test identifier instead of per-suite counts
  --max <n>           rows to list before summarizing the rest (default: 40)
note:
  Enumerating compiles the test bundle, so the first run is as slow as a build.
  It is still far cheaper than running the tests to find out what they are.
examples:
  xcodebuild-axi tests --scheme Ration
  xcodebuild-axi tests --scheme Ration --filter AppFeature --list
`;

const FLAGS = [
  ...SHARED_BUILD_FLAGS,
  "--test-plan",
  "--filter",
  "--list",
  "--max",
] as const;
const VALUE_FLAGS = [
  ...SHARED_BUILD_VALUE_FLAGS,
  "--test-plan",
  "--filter",
  "--max",
] as const;

interface EnumerationFile {
  errors?: unknown[];
  values?: {
    enabledTests?: { identifier?: string }[];
    disabledTests?: { identifier?: string }[];
  }[];
}

export async function testsCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "tests", FLAGS, VALUE_FLAGS);

  const context = await resolveBuildContext({ args, command: "tests" });
  const outputPath = join(
    artifactDir(context.project),
    `${runLabel(context, "tests")}.json`,
  );
  const testPlan = getFlag(args, "--test-plan");

  // xcodebuild appends to an existing enumeration file rather than replacing
  // it, so a stale one from a previous scheme would silently pad the list.
  rmSync(outputPath, { force: true });

  const run = await runAction({
    context,
    command: "tests",
    // -enumerate-tests only takes effect alongside the `test` action; without
    // it xcodebuild builds for testing and writes no enumeration at all.
    actions: ["test"],
    extraArgs: [
      ...(testPlan ? ["-testPlan", testPlan] : []),
      "-enumerate-tests",
      "-test-enumeration-format",
      "json",
      "-test-enumeration-style",
      "flat",
      "-test-enumeration-output-path",
      outputPath,
    ],
  });

  const parsed = readEnumeration(outputPath);
  if (!parsed) {
    const mapped = mapXcodebuildError(run.tail);
    throw new AxiError(
      mapped?.message ?? "xcodebuild enumerated no tests",
      mapped?.code ?? "UNKNOWN",
      [
        ...(mapped?.suggestions ?? []),
        `full transcript: ${tildePath(run.logPath)}`,
      ],
    );
  }

  const filter = getFlag(args, "--filter")?.toLowerCase();
  const max = getIntFlag(args, "--max") ?? 40;

  const all = (parsed.values ?? []).flatMap(
    (value) => value.enabledTests ?? [],
  );
  const disabled = (parsed.values ?? []).flatMap(
    (value) => value.disabledTests ?? [],
  );
  let identifiers = all
    .map((test) => test.identifier)
    .filter((identifier): identifier is string => identifier !== undefined);

  if (filter) {
    identifiers = identifiers.filter((identifier) =>
      identifier.toLowerCase().includes(filter),
    );
  }

  if (identifiers.length === 0) {
    return renderOutput([
      renderFields({
        tests: filter
          ? `0 tests match '${getFlag(args, "--filter")}' in scheme ${context.scheme}`
          : `0 tests in scheme ${context.scheme}`,
      }),
      renderHelp([
        "Run `xcodebuild-axi tests` without --filter to see every suite",
      ]),
    ]);
  }

  const blocks = [
    renderFields({
      scheme: context.scheme,
      tests: identifiers.length,
      ...(disabled.length > 0 ? { disabled: disabled.length } : {}),
      duration: duration(run.seconds),
    }),
  ];

  if (hasFlag(args, "--list")) {
    const shown = identifiers
      .slice(0, max)
      .map((identifier) => ({ test: identifier }));
    blocks.push(
      renderList(
        identifiers.length > shown.length
          ? `test_list (${shown.length} of ${identifiers.length})`
          : "test_list",
        shown,
      ),
    );
    if (identifiers.length > shown.length) {
      blocks.push(
        renderHelp([
          `Run \`xcodebuild-axi tests --list --max ${identifiers.length}\` for all of them`,
        ]),
      );
    }
  } else {
    const suites = groupBySuite(identifiers);
    const shown = suites.slice(0, max);
    blocks.push(
      renderList(
        suites.length > shown.length
          ? `suites (${shown.length} of ${suites.length})`
          : "suites",
        shown,
      ),
    );
    blocks.push(
      renderHelp([
        "Run `xcodebuild-axi tests --list` to see individual test identifiers",
        `Run \`xcodebuild-axi test --scheme ${context.scheme} --only <suite>\` to run one suite`,
      ]),
    );
  }

  return renderOutput(blocks);
}

/**
 * Collapse `Target/Suite/testName()` identifiers into one row per suite.
 *
 * A scheme with a thousand tests produces a thousand unreadable rows; the
 * shape an agent needs to pick what to run is the suite and how big it is
 * (AXI principle 2).
 */
export function groupBySuite(
  identifiers: string[],
): { suite: string; tests: number }[] {
  const counts = new Map<string, number>();
  for (const identifier of identifiers) {
    const parts = identifier.split("/");
    // Drop the test method, keeping target and suite. A two-part identifier
    // is already suite-level, so it stands for itself.
    const suite = parts.length > 2 ? parts.slice(0, -1).join("/") : identifier;
    counts.set(suite, (counts.get(suite) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([suite, tests]) => ({ suite, tests }))
    .sort((a, b) => b.tests - a.tests || a.suite.localeCompare(b.suite));
}

function readEnumeration(path: string): EnumerationFile | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as EnumerationFile;
  } catch {
    return undefined;
  }
}
