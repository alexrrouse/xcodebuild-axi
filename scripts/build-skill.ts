/**
 * Generate `skills/xcodebuild-axi/SKILL.md` from the CLI's own help text.
 *
 * Single source of truth (AXI principle 7): the skill restates nothing the CLI
 * does not already say, so it cannot drift into describing flags that no
 * longer exist. Run with `--check` in CI to fail on a stale committed copy.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DESCRIPTION, TOP_HELP } from "../src/cli.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "skills", "xcodebuild-axi", "SKILL.md");

const content = `---
name: xcodebuild-axi
description: >
  Build, test, and inspect Xcode projects without reading xcodebuild's output.
  Use for any iOS/macOS build, test run, scheme or destination lookup, build
  setting read, or .xcresult inspection — raw xcodebuild prints hundreds of
  kilobytes to say what this prints in a few lines.
---

# xcodebuild-axi

${DESCRIPTION}

Run it with no arguments first — it reports the project in front of you, its
schemes, and how the last run went.

\`\`\`sh
npx -y xcodebuild-axi
\`\`\`

## Commands

\`\`\`
${TOP_HELP.trim()}
\`\`\`

Every command takes \`--help\` with its own flags and examples. The CLI's own
output is the authority on everything below the top level; prefer asking it
over guessing.

## What to reach for

- Building or testing: \`build\` and \`test\` report only what failed, with
  \`file,line,col\`. The full transcript is written to a log whose path they
  print, so detail is one read away and never the default.
- Picking a device: pass \`--device "iPhone 17 Pro"\`, or nothing at all to get
  the newest simulator. Do not hand-write a \`-destination\` specifier.
- Reading a previous run: \`result <path.xcresult>\`, which re-reads without
  rebuilding.
- Build settings: \`settings --key NAME\`, not a full dump.

## Exit codes

\`0\` success, \`1\` the build or tests failed, \`2\` usage error. A failed build
still prints its full report to stdout.
`;

const check = process.argv.includes("--check");
if (check) {
  const existing = readFileSync(target, "utf-8");
  if (existing !== content) {
    console.error(
      "skills/xcodebuild-axi/SKILL.md is stale — run `npm run build:skill` and commit the result",
    );
    process.exit(1);
  }
  console.log("SKILL.md is up to date");
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  console.log(`wrote ${target}`);
}
