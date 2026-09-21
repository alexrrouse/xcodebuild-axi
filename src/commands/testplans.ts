import { requireProject } from "../context.js";
import { requireScheme } from "../scheme.js";
import { runMetadata, stripPreamble } from "../xcodebuild.js";
import { renderFields, renderHelp, renderOutput } from "../toon.js";
import { getFlag, rejectUnknownFlags } from "../args.js";

export const TESTPLANS_HELP = `usage: xcodebuild-axi testplans [flags]
Lists the test plans a scheme is configured with.
flags[1]:
  --scheme <name>  scheme to inspect (required only when the project has more than one)
examples:
  xcodebuild-axi testplans
  xcodebuild-axi testplans --scheme MyApp
`;

export async function testplansCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "testplans", ["--scheme"], ["--scheme"]);

  const project = requireProject();
  const scheme = await requireScheme(
    project,
    getFlag(args, "--scheme"),
    "testplans",
  );

  const { stdout, stderr } = await runMetadata([
    ...project.flags,
    "-scheme",
    scheme,
    "-showTestPlans",
  ]);
  const output = stripPreamble(`${stdout}\n${stderr}`);

  // A scheme without test plans is a normal, common configuration — not a
  // failure. Say so in the scheme's own words so the agent stops looking.
  if (/not configured to use test plans/i.test(output)) {
    return renderOutput([
      renderFields({
        scheme,
        testplans: "none — this scheme does not use test plans",
      }),
      renderHelp([
        `Run \`xcodebuild-axi test --scheme ${scheme}\` to run its tests directly`,
      ]),
    ]);
  }

  const plans = parseTestPlans(output);

  if (plans.length === 0) {
    return renderOutput([
      renderFields({ scheme, testplans: "0 test plans found" }),
    ]);
  }

  return renderOutput([
    renderFields({ scheme, testplans: plans }),
    renderHelp([
      `Run \`xcodebuild-axi test --scheme ${scheme} --test-plan <name>\` to run one`,
    ]),
  ]);
}

/**
 * `-showTestPlans` prints a prose heading and then one indented plan per line.
 * The first plan is the scheme's default, which xcodebuild does not mark, so
 * neither do we rather than guess.
 */
export function parseTestPlans(output: string): string[] {
  const plans: string[] = [];
  let inList = false;
  for (const line of output.split("\n")) {
    if (/Test plans? associated with the ".*" scheme:/i.test(line)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (!/^\s/.test(line)) break;
    plans.push(trimmed);
  }
  return plans;
}
