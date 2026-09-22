import {
  installSessionStartHooks,
  sessionStartHookStatus,
  uninstallSessionStartHooks,
} from "axi-sdk-js";
import { AxiError } from "../errors.js";
import { renderFields, renderHelp, renderOutput } from "../toon.js";
import { hasFlag, positionals, rejectUnknownFlags } from "../args.js";

export const SETUP_HELP = `usage: xcodebuild-axi setup hooks [flags]
Installs session-start hooks so an agent sees this project's schemes and last
run before it does anything (AXI principle 7). Covers Claude Code, Codex, and
OpenCode.
flags[3]:
  --project    install into this repository instead of your home directory
  --status     report what is installed, writing nothing
  --uninstall  remove the hooks this tool installed
examples:
  xcodebuild-axi setup hooks
  xcodebuild-axi setup hooks --project
  xcodebuild-axi setup hooks --status
`;

export const SETUP_FLAGS = ["--project", "--status", "--uninstall"] as const;

/**
 * Passed explicitly rather than left to the SDK to infer.
 *
 * `inferHookOptions` reads the marker out of `process.argv[1]` and only
 * matches a `dist/bin/<name>.js` path, so it works from the installed binary
 * and throws everywhere else — `npm run dev -- setup hooks --status` failed
 * with "unable to infer a hook marker from the current process". The installed
 * binary infers this exact string, so stating it changes nothing there and
 * makes `--status` and `--uninstall` work from a dev checkout too.
 *
 * Install is still correctly refused from a `.ts` entrypoint: the SDK's own
 * policy rejects one, which is right — a hook wired to a tsx path would break
 * as soon as the checkout moved.
 */
const MARKER = "xcodebuild-axi";

/**
 * How long the session-start hook is allowed to take.
 *
 * The SDK defaults to 10s, which is not enough. The home view runs
 * `xcodebuild -list`, and against a workspace with 16 local Swift packages
 * that resolves the package graph on a cold run: measured 10.9s cold, then
 * 2.9s and 1.4s warm. Cold is exactly the case a session start hits, and a
 * hook that times out contributes nothing at all — the whole point of it is
 * lost silently, with no error to notice.
 *
 * 30s is headroom over the slowest real measurement rather than a guess. It is
 * a ceiling, not a cost: a warm run still returns in a second or two.
 */
const HOOK_TIMEOUT_SECONDS = 30;

export async function setupCommand(args: string[]): Promise<string> {
  rejectUnknownFlags(args, "setup", SETUP_FLAGS);

  const [target] = positionals(args, []);
  if (target !== "hooks") {
    throw new AxiError(
      target === undefined
        ? "setup needs a target"
        : `Unknown setup target '${target}'`,
      "VALIDATION_ERROR",
      ["xcodebuild-axi setup hooks"],
    );
  }

  const scope = hasFlag(args, "--project")
    ? ("project" as const)
    : ("user" as const);

  if (hasFlag(args, "--status")) {
    const status = sessionStartHookStatus({ scope, marker: MARKER });
    return renderOutput([
      renderFields({
        setup: "status",
        scope,
        claude: status.claude?.installed
          ? (status.claude.path ?? "installed")
          : "not installed",
        codex: status.codex?.installed
          ? (status.codex.path ?? "installed")
          : "not installed",
        opencode: status.opencode?.installed
          ? (status.opencode.path ?? "installed")
          : "not installed",
      }),
    ]);
  }

  if (hasFlag(args, "--uninstall")) {
    await uninstallSessionStartHooks({ scope, marker: MARKER });
    return renderOutput([renderFields({ setup: "hooks removed", scope })]);
  }

  await installSessionStartHooks({
    scope,
    marker: MARKER,
    timeoutSeconds: HOOK_TIMEOUT_SECONDS,
  });
  const status = sessionStartHookStatus({ scope, marker: MARKER });

  return renderOutput([
    renderFields({
      setup: "hooks installed or already up to date",
      scope,
      claude: status.claude?.path ?? "skipped",
      codex: status.codex?.path ?? "skipped",
      opencode: status.opencode?.path ?? "skipped",
    }),
    renderHelp([
      "Start a new agent session to pick them up",
      "Run `xcodebuild-axi setup hooks --status` to verify",
      "Run `xcodebuild-axi setup hooks --uninstall` to remove them",
    ]),
  ]);
}
