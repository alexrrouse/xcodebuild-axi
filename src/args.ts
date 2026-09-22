import { AxiError } from "./errors.js";

/**
 * Flag parsing with AXI principle 6's "fail loud on unrecognized input".
 *
 * Every command declares the flags it knows; anything else is rejected by name
 * with the valid set listed inline, so the agent self-corrects in one turn
 * rather than spending a round trip on `--help`.
 */

/** Read `--flag value` or `--flag=value` without consuming it. */
export function getFlag(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === name) return args[i + 1];
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

export function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

/** Read a `--flag a,b,c` list, also accepting the flag repeated. */
export function getListFlag(args: string[], name: string): string[] {
  const prefix = `${name}=`;
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === name) {
      const value = args[i + 1];
      if (value !== undefined) out.push(value);
      i++;
    } else if (arg.startsWith(prefix)) {
      out.push(arg.slice(prefix.length));
    }
  }
  return out.flatMap((v) => v.split(",")).filter((v) => v.length > 0);
}

/**
 * Every occurrence of the named flags, in the order they were written.
 *
 * Order is meaning for a few xcodebuild options: `-headers` belongs to the
 * `-library` before it and `-debug-symbols` to the slice before that, so a
 * command that regrouped them by flag would pair the wrong ones together.
 */
export function orderedFlags(
  args: string[],
  names: readonly string[],
): Array<{ flag: string; value: string }> {
  const out: Array<{ flag: string; value: string }> = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--") break;

    const equals = arg.indexOf("=");
    const bare = equals < 0 ? arg : arg.slice(0, equals);
    if (!names.includes(bare)) continue;

    if (equals >= 0) {
      out.push({ flag: bare, value: arg.slice(equals + 1) });
      continue;
    }
    const value = args[i + 1];
    if (value !== undefined) out.push({ flag: bare, value });
    i++;
  }
  return out;
}

/** Read an integer flag, rejecting values that are not numbers. */
export function getIntFlag(args: string[], name: string): number | undefined {
  const raw = getFlag(args, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new AxiError(
      `${name} expects a non-negative integer, got "${raw}"`,
      "VALIDATION_ERROR",
    );
  }
  return parsed;
}

/** Positional arguments — everything that is not a flag or a flag's value. */
export function positionals(
  args: string[],
  valueFlags: readonly string[],
): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("-")) {
      const bare = arg.split("=")[0] ?? arg;
      if (valueFlags.includes(bare) && !arg.includes("=")) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

/**
 * Reject unknown flags by name and list the valid ones inline.
 *
 * `--help` always passes (AXI principle 6). `valueFlags` are the flags that
 * take a value, so their values are not mistaken for flags themselves.
 */
export function rejectUnknownFlags(
  args: string[],
  command: string,
  known: readonly string[],
  valueFlags: readonly string[] = [],
): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--") break;
    if (!arg.startsWith("-") || arg === "-") continue;

    const bare = arg.split("=")[0] ?? arg;
    if (bare === "--help") continue;

    if (!known.includes(bare)) {
      const renamed = RENAMED_FLAGS[bare];
      throw new AxiError(
        `unknown flag ${bare} for \`${command}\``,
        "VALIDATION_ERROR",
        renamed
          ? [renamed]
          : [
              `valid flags for \`${command}\`: ${known.join(", ")} (--help always allowed)`,
            ],
      );
    }

    if (valueFlags.includes(bare) && !arg.includes("=")) {
      const value = args[i + 1];
      if (value === undefined) {
        throw new AxiError(`${bare} requires a value`, "VALIDATION_ERROR", [
          `valid flags for \`${command}\`: ${known.join(", ")}`,
        ]);
      }
      i++;
    }
  }
}

/**
 * Flags this CLI used to accept, pointed at their replacement so a stale call
 * site self-corrects in one step instead of reading the whole valid-flag list.
 */
const RENAMED_FLAGS: Record<string, string> = {
  "--simulator": "--simulator was renamed; use --device instead",
  "--verbose":
    "--verbose was removed; the full transcript is always written to the log path in the output",
};
