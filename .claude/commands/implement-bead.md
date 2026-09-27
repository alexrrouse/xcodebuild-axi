---
description: Take one GitHub issue from understanding to a merged PR — plan, implement with tests, document, review, fix, ship
argument-hint: <issue-number>
---

Implement GitHub issue #$ARGUMENTS end to end. Work through the phases below in
order and do not skip one. If no issue number was given, run `gh issue list`
and ask which one to take.

## 1. Understand the problem

Nothing gets planned until the problem is understood.

- Read the issue and every comment: `gh issue view $ARGUMENTS --comments`.
- Read the code it touches, and the relevant sections of AGENTS.md — most
  issues here are an xcodebuild or simctl sharp edge, and AGENTS.md may already
  describe it or a close neighbour.
- If the report describes behaviour you cannot explain from the code, **go and
  find out** rather than guessing: reproduce it against a real Xcode project
  with `npm run dev -- …` (see "Dogfood it" in CLAUDE.md), read the transcript
  and result bundle, try the raw `xcodebuild`/`simctl` spelling.
- Write down, in a few sentences: what is wrong, why it happens, and what
  "fixed" looks like from the agent's side of the CLI. If after investigating
  you still cannot say that, or the issue admits two reasonable fixes with
  different output shapes, ask the user before going further.

## 2. Plan with a subagent

Spawn a `Plan` subagent. Give it your understanding from step 1 verbatim — the
issue text, the root cause, the files involved, and anything the reproduction
showed — so it does not re-derive it. Ask it for:

- the change, file by file;
- the tests that should fail before the change and pass after;
- every doc surface the change touches (see step 4);
- output-shape decisions, checked against the AXI principles in AGENTS.md;
- risks, and anything it thinks the understanding got wrong.

Read the plan critically. You own the implementation; adopt what is right,
push back on what is not, and say briefly what you changed from it.

## 3. Implement, with tests alongside

- Branch off an up-to-date `main`: `git switch main && git pull && git switch -c <short-descriptive-name>`.
- Write each test next to the code it covers, and see it fail before the fix
  where that is possible. Tests live in `test/` and are pure — fixture the
  xcodebuild/xcresulttool/simctl output rather than shelling out.
- Match the surrounding code's naming, comment density and idiom. Examples use
  the fictional vocabulary from AGENTS.md (`MyApp`, `MyApps`,
  `MyAppTests/CheckoutTests`) and never a name from the project you dogfooded
  against.

## 4. Update documentation

Go through every one of these and update what the change touches:

- **Help text** in the command, then `npm run build:skill` to regenerate
  `skills/xcodebuild-axi/SKILL.md`. Never hand-edit the skill.
- **`src/surface.ts`** for any new or changed flag, then `npm run coverage` to
  regenerate the README coverage section. Never hand-edit it.
- **AGENTS.md** — a new xcodebuild/simctl sharp edge, or a non-obvious decision,
  gets a bullet in the matching section.
- **README.md** — any user-visible behaviour it describes.
- **CHANGELOG.md** — an entry under `## [Unreleased]`, written like the ones
  already there.

## 5. Verify

Run the full gate from CLAUDE.md and make it green:

```sh
npm run format:check && npm run lint && npx tsc --noEmit && npm test
npm run build && npm run build:skill -- --check && npm run coverage:check
```

Then dogfood the change against a real Xcode project with `npm run dev -- …`
and keep the commands and output — they go in the PR as proof. Never run
`npm run benchmark` without asking.

## 6. Code review, then fix

Commit the work, then run the `code-review` skill on the branch's diff against
`main`.

Bias toward fixing. Fix every finding that is relevant to this change —
correctness, missed cases, tests that do not actually pin the behaviour, stale
docs — even when it is small. Skip a finding only when it is wrong, or is
about code this change did not touch; note each skip and why. Re-run step 5
after the fixes.

## 7. Open the PR

Push and open a PR with `gh pr create`. Title: a plain-English sentence of what
changed, like the existing history (`git log --oneline -20`). Body, matching
earlier PRs:

```
Closes #<issue>.

## Problem
## Change
## Proof      <- test counts, and the dogfood commands with their output
## Review     <- findings fixed, and any skipped with the reason
```

Scrub the body of any name from the project you dogfooded against.

## 8. Get CI green, then merge

- `gh pr checks --watch`. On a failure, read the log (`gh run view --log-failed`),
  fix it, push, and watch again. Do not merge on red.
- When green: `gh pr merge --squash --delete-branch`, then
  `git switch main && git pull`.
- Confirm the issue closed (`gh issue view $ARGUMENTS`), and report back the PR
  URL, what shipped, and anything deferred.
