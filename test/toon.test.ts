import { describe, expect, it } from "vitest";
import {
  duration,
  renderHelp,
  renderOutput,
  tildePath,
  truncate,
} from "../src/toon.js";

describe("truncate", () => {
  it("leaves text that already fits", () => {
    expect(truncate("short", 100)).toEqual({
      text: "short",
      truncated: false,
      total: 5,
    });
  });

  // Omitting the field forces a hunt; including it wastes tokens. Say how much
  // was withheld so the agent can decide (AXI principle 3).
  it("reports the full size when it cuts", () => {
    const result = truncate("x".repeat(50), 10);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(50);
    expect(result.text).toContain("truncated, 50 chars total");
  });
});

describe("renderHelp", () => {
  it("counts and indents the suggestions", () => {
    expect(renderHelp(["one", "two"])).toBe("help[2]:\n  one\n  two");
  });

  it("renders nothing when there is nothing to suggest", () => {
    expect(renderHelp([])).toBe("");
    expect(renderHelp([""])).toBe("");
  });
});

describe("renderOutput", () => {
  it("drops empty blocks rather than leaving blank lines", () => {
    expect(renderOutput(["a", "", "b"])).toBe("a\nb");
  });
});

describe("duration", () => {
  it("uses seconds below a minute and m/s above", () => {
    expect(duration(4.25)).toBe("4.3s");
    expect(duration(934)).toBe("15m34s");
    expect(duration(120)).toBe("2m00s");
  });

  it("says unknown rather than printing NaN", () => {
    expect(duration(Number.NaN)).toBe("unknown");
  });
});

describe("tildePath", () => {
  it("collapses the home directory", () => {
    const home = process.env["HOME"];
    expect(home).toBeTruthy();
    expect(tildePath(`${home}/Developer/x`)).toBe("~/Developer/x");
  });

  it("leaves other absolute paths alone", () => {
    expect(tildePath("/tmp/x")).toBe("/tmp/x");
  });
});
