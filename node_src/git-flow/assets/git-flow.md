# The git-flow workflow

## Where you may write

- This session has a working tree of its own. Write **inside it** — not the main
  checkout, not another session's tree.
- A write aimed anywhere else is refused before it happens, and the refusal names
  the path to use instead. Use that path; do not retry the one you picked.
- The rule is enforced against the path a tool declares. Reaching a file another
  way — through a shell command, for instance — does not make it allowed.

## Before your first edit

- A session needs a feature branch before it can change anything. Call the
  `git_start` tool with a branch name; a `feat/` prefix is added when the name has
  none. The human can do the same thing with `/git-start`.
- If the session so far does not say enough to name the feature, ask the human
  what they are working on, then call `git_start` with the answer. Do not invent a
  name to get past the refusal.

## Finishing a step

- **Commit after each completed step**, not once at the end: a step is a change
  that stands on its own, and a commit is the checkpoint that makes a wrong step
  cheap to undo. The `git-master` skill is where the message convention lives.
- `/git-complete` or the `git_complete` tool replays the branch if master has
  moved, merges it with `--no-ff`, and releases the worktree. It needs a merge
  message, so write one that says what the feature did.
- Do not merge, rebase or delete branches by hand, and never force-push: the
  commands exist so that these steps are the same every time.
