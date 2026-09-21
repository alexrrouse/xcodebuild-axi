# CLAUDE.md

See @AGENTS.md for this project's agent memory — what the tool is, the
xcodebuild behaviors it exists to paper over, and the conventions its output
follows. That file is the single source of truth; this one only adds what is
specific to working here with Claude Code.

## Before you finish

```sh
npm run format:check && npm run lint && npx tsc --noEmit && npm test
npm run build && npm run build:skill -- --check && npm run coverage:check
```

`build:skill --check` and `coverage:check` fail on committed files that are
generated rather than written. If either complains, rerun the generator
(`npm run build:skill`, `npm run coverage`) instead of editing the output.

## Dogfood it

Validating a change means running it against a real Xcode project, which lives
outside this repository. Use the local build rather than an installed copy:

```sh
npm run dev -- test --scheme <name>
npm run dev -- destinations --scheme <name>
```

Two things follow from that being someone's real app:

- **Never commit a name from it.** Schemes, targets, bundle ids, and device
  names from the project under test do not belong in help text, tests, or the
  README. The fictional vocabulary to use instead is in AGENTS.md.
- **Never run the benchmark unprompted.** `npm run benchmark` without `--quick`
  drives four cold builds and can take tens of minutes; it once exhausted
  memory on the developer's machine. Ask first, prefer `--quick`, and use
  `--only <scenario> --resume` to add one slow row at a time.

## Reading this tool's own output

Commands print TOON, not JSON, and errors print to **stdout** with a non-zero
exit. A command that "printed nothing" almost always exited 2 on a usage error
that went to stdout — read it rather than rerunning with more flags.
