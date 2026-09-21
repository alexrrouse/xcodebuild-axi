import { describe, expect, it } from "vitest";
import { COMMAND_HELP, TOP_HELP } from "../src/cli.js";

/**
 * Every help block declares its own length — `flags[9]:` — because TOON arrays
 * carry a count and an agent uses it to decide whether it saw everything. A
 * wrong count is worse than no count, and counts drift the moment a flag is
 * added, so they are checked rather than trusted.
 */
function declaredCounts(help: string): Array<[string, number, number]> {
  const lines = help.split("\n");
  const results: Array<[string, number, number]> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const header = /^([a-z_]+)\[(\d+)\]:$/.exec(lines[index] as string);
    if (!header) continue;

    let actual = 0;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] as string;
      if (line.trim().length === 0 || !/^\s/.test(line)) break;
      // Only a line indented exactly two spaces starts a new entry; anything
      // deeper is a continuation of the entry above it.
      if (!/^ {2}\S/.test(line)) continue;
      actual += countEntries(line.trim());
    }
    results.push([header[1] as string, Number(header[2]), actual]);
  }
  return results;
}

/**
 * Some blocks pack several short names onto one line — `build, test, tests`.
 * A line is a list when every comma-separated piece is a bare token; anything
 * with a space in it is prose, e.g. `--sdk <name>  base SDK, e.g. iphoneos`.
 */
function countEntries(text: string): number {
  const pieces = text.split(",").map((piece) => piece.trim());
  return pieces.length > 1 && pieces.every((piece) => !/\s/.test(piece))
    ? pieces.length
    : 1;
}

describe("help texts", () => {
  it("declares accurate counts in the top-level help", () => {
    for (const [label, declared, actual] of declaredCounts(TOP_HELP)) {
      expect(`${label}[${declared}]`).toBe(`${label}[${actual}]`);
    }
  });

  for (const [command, help] of Object.entries(COMMAND_HELP)) {
    it(`declares accurate counts in \`${command} --help\``, () => {
      for (const [label, declared, actual] of declaredCounts(help)) {
        expect(`${command} ${label}[${declared}]`).toBe(
          `${command} ${label}[${actual}]`,
        );
      }
    });

    it(`opens \`${command} --help\` with a usage line`, () => {
      expect(help.startsWith(`usage: xcodebuild-axi ${command}`)).toBe(true);
    });
  }

  it("lists every command that has a help text", () => {
    const block = TOP_HELP.split("flags[")[0] ?? "";
    for (const command of Object.keys(COMMAND_HELP)) {
      expect(block).toContain(command);
    }
  });
});
