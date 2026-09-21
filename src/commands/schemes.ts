import { requireProject } from "../context.js";
import { listSchemes } from "../scheme.js";
import { renderFields, renderHelp, renderOutput } from "../toon.js";
import { rejectUnknownFlags } from "../args.js";

export const SCHEMES_HELP = `usage: xcodebuild-axi schemes
Lists the buildable schemes in the workspace or project in the current directory.
flags[0]: (none)
examples:
  xcodebuild-axi schemes
`;

export async function schemesCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "schemes", []);

  const project = requireProject();
  const info = await listSchemes(project);

  if (info.schemes.length === 0) {
    return renderOutput([
      renderFields({ schemes: `0 shared schemes in ${info.name}` }),
      renderHelp([
        "Open the project in Xcode and mark a scheme as Shared so xcodebuild can see it",
      ]),
    ]);
  }

  const blocks = [
    renderFields({ [project.kind]: info.name }),
    // A TOON array of primitives renders inline and unquoted
    // (`schemes[12]: A,B,C`); the same names in one comma-joined string would
    // be quoted for containing commas, and pay for the quotes.
    renderFields({ schemes: info.schemes }),
  ];

  if (info.configurations.length > 0) {
    blocks.push(renderFields({ configurations: info.configurations }));
  }

  blocks.push(
    renderHelp([
      "Run `xcodebuild-axi build --scheme <name>` to build one",
      "Run `xcodebuild-axi destinations --scheme <name>` to see where it can run",
    ]),
  );

  return renderOutput(blocks);
}
