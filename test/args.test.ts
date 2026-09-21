import { describe, expect, it } from "vitest";
import { AxiError } from "../src/errors.js";
import {
  getFlag,
  getIntFlag,
  getListFlag,
  hasFlag,
  positionals,
  rejectUnknownFlags,
} from "../src/args.js";

describe("getFlag", () => {
  it("reads both the spaced and the equals form", () => {
    expect(getFlag(["--scheme", "MyApp"], "--scheme")).toBe("MyApp");
    expect(getFlag(["--scheme=MyApp"], "--scheme")).toBe("MyApp");
  });

  it("returns undefined when absent", () => {
    expect(getFlag(["--other", "x"], "--scheme")).toBeUndefined();
  });
});

describe("getListFlag", () => {
  it("accepts a comma-separated value", () => {
    expect(getListFlag(["--key", "A,B,C"], "--key")).toEqual(["A", "B", "C"]);
  });

  it("accepts the flag repeated", () => {
    expect(getListFlag(["--only", "A", "--only", "B"], "--only")).toEqual([
      "A",
      "B",
    ]);
  });

  it("drops empty entries from a trailing comma", () => {
    expect(getListFlag(["--key=A,"], "--key")).toEqual(["A"]);
  });
});

describe("getIntFlag", () => {
  it("parses an integer", () => {
    expect(getIntFlag(["--max", "5"], "--max")).toBe(5);
  });

  it("rejects a non-integer instead of silently reading zero", () => {
    expect(() => getIntFlag(["--max", "lots"], "--max")).toThrow(AxiError);
    expect(() => getIntFlag(["--max", "-1"], "--max")).toThrow(AxiError);
  });
});

describe("positionals", () => {
  it("skips flags and the values they consume", () => {
    expect(positionals(["--max", "5", "bundle.xcresult"], ["--max"])).toEqual([
      "bundle.xcresult",
    ]);
  });

  it("does not consume a value for the equals form", () => {
    expect(positionals(["--max=5", "bundle.xcresult"], ["--max"])).toEqual([
      "bundle.xcresult",
    ]);
  });

  it("treats everything after -- as positional", () => {
    expect(positionals(["--", "--not-a-flag"], [])).toEqual(["--not-a-flag"]);
  });
});

describe("rejectUnknownFlags", () => {
  // A dropped flag is worse than an error: the agent gets plausible output it
  // believes is filtered, then proceeds on wrong data.
  it("rejects an unknown flag by name and lists the valid ones inline", () => {
    try {
      rejectUnknownFlags(
        ["--scheem", "MyApp"],
        "build",
        ["--scheme"],
        ["--scheme"],
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AxiError);
      const axiError = error as AxiError;
      expect(axiError.message).toBe("unknown flag --scheem for `build`");
      expect(axiError.code).toBe("VALIDATION_ERROR");
      expect(axiError.suggestions[0]).toContain("--scheme");
    }
  });

  it("always allows --help", () => {
    expect(() => rejectUnknownFlags(["--help"], "build", [])).not.toThrow();
  });

  it("points a renamed flag at its replacement instead of the generic list", () => {
    try {
      rejectUnknownFlags(
        ["--simulator", "iPhone"],
        "test",
        ["--device"],
        ["--device"],
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as AxiError).suggestions[0]).toContain(
        "use --device instead",
      );
    }
  });

  it("rejects a value flag given no value", () => {
    expect(() =>
      rejectUnknownFlags(["--scheme"], "build", ["--scheme"], ["--scheme"]),
    ).toThrow(/requires a value/);
  });

  it("does not mistake a flag's value for a flag", () => {
    expect(() =>
      rejectUnknownFlags(
        ["--device", "--weird-name"],
        "test",
        ["--device"],
        ["--device"],
      ),
    ).not.toThrow();
  });

  it("accepts known boolean flags", () => {
    expect(() =>
      rejectUnknownFlags(["--full", "--clean"], "build", ["--full", "--clean"]),
    ).not.toThrow();
  });
});

describe("hasFlag", () => {
  it("detects a bare boolean flag", () => {
    expect(hasFlag(["--full"], "--full")).toBe(true);
    expect(hasFlag([], "--full")).toBe(false);
  });
});
