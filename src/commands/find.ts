import { AxiError } from "../errors.js";
import { runMetadata, stripPreamble } from "../xcodebuild.js";
import { renderFields, renderHelp, renderOutput, tildePath } from "../toon.js";
import { getFlag, positionals, rejectUnknownFlags } from "../args.js";

export const FIND_HELP = `usage: xcodebuild-axi find <name> [flags]
Resolves an executable or library to its full path in the active toolchain —
the same lookup \`xcrun\` does, without the guesswork about which SDK.
flags[3]:
  --library           look for a library instead of an executable
  --sdk <name>        SDK to search, e.g. iphoneos
  --toolchain <name>  toolchain to search
examples:
  xcodebuild-axi find clang
  xcodebuild-axi find swiftc --sdk iphonesimulator
  xcodebuild-axi find libLTO.dylib --library
`;

export const FIND_FLAGS = ["--library", "--sdk", "--toolchain"] as const;
const VALUE_FLAGS = ["--sdk", "--toolchain"] as const;

export async function findCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "find", FIND_FLAGS, VALUE_FLAGS);

  const [name] = positionals(args, VALUE_FLAGS);
  if (name === undefined) {
    throw new AxiError("find needs a name to look for", "VALIDATION_ERROR", [
      "xcodebuild-axi find clang",
      "xcodebuild-axi find libz.tbd --library --sdk iphoneos",
    ]);
  }

  const library = args.includes("--library");
  const sdk = getFlag(args, "--sdk");
  const toolchain = getFlag(args, "--toolchain");

  const { stdout, stderr, exitCode } = await runMetadata([
    library ? "-find-library" : "-find-executable",
    name,
    ...(sdk ? ["-sdk", sdk] : []),
    ...(toolchain ? ["-toolchain", toolchain] : []),
  ]);

  const found = stripPreamble(stdout)
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("/"));

  if (exitCode !== 0 || !found) {
    // "Not here" is an answer, but a nonzero exit means the lookup itself
    // failed, so keep it an error rather than a definitive empty state.
    throw new AxiError(
      `No ${library ? "library" : "executable"} named '${name}'${sdk ? ` in SDK ${sdk}` : ""}`,
      "NOT_FOUND",
      [
        library
          ? "`--library` searches the toolchain's usr/lib, so pass the file name, e.g. libLTO.dylib"
          : "Run `xcodebuild-axi info --sdks` to see the installed SDKs",
        ...detail(stderr),
      ],
    );
  }

  return renderOutput([
    renderFields({
      [library ? "library" : "executable"]: name,
      path: tildePath(found),
      ...(sdk ? { sdk } : {}),
    }),
    renderHelp([]),
  ]);
}

/** xcodebuild prefixes its refusals with a timestamped line about a temp
 * result bundle nobody will ever open; `stripPreamble` already drops it. */
function detail(stderr: string): string[] {
  const line = stripPreamble(stderr)
    .split("\n")
    .map((entry) => entry.trim())
    // A bare "'name' not found." only restates the message above it.
    .find((entry) => entry.length > 0 && !/not found\.?$/.test(entry));
  return line ? [line] : [];
}
