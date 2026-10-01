# The git-flow workflow

## Where you may write

- This session has a working tree of its own, and `git_start` answers with it: the
  repository's **main checkout** when no other session was working in it, or a
  worktree of its own under `{{worktreeRoot}}/` when one was.
- Write **inside that tree** — not another session's tree, and not a path outside
  the repository.
- A write aimed anywhere else is refused before it happens, and the refusal names
  the path to use instead. Use that path; do not retry the one you picked.
- The rule is enforced against the path a tool declares. Reaching a file another
  way — through a shell command, for instance — does not make it allowed.

## Before your first edit

- A session needs a feature branch before it can change anything. Call the
  `git_start` tool with the feature's **own name**; the plugin puts it under
  `{{branchPrefix}}` and answers with the tree this session now works in. The human
  can do the same thing with `/git-start`.
- Name the feature, not the work, and give the name alone: letters, digits and
  dashes, starting with a letter, **at most {{branchSubjectMaxLength}} characters**.
  `git-flow-guard` opens the branch `{{branchPrefix}}git-flow-guard`, and
  `{{branchPrefix}}git-flow-guard` is the same name — the prefix is not yours to
  write.
- Do **not** bring a namespace of your own. `test/git-flow-guard` is refused
  rather than prefixed: `{{branchPrefix}}` is the only prefix a family branch has,
  and `test/`, `fix/`, `chore/` are not places this plugin puts branches. If a name
  you want to use does not fit the rule, rename the feature, not the namespace.
- If the session so far does not say enough to name the feature, ask the human
  what they are working on, then call `git_start` with the answer. Do not invent a
  name to get past the refusal.
- Read the answer: it names the tree, and every edit from then on belongs inside
  it. When another session is already in the repository this tree is a worktree of
  your own, which is why a write to the main checkout is then refused with the path
  to use instead.

## Finishing a step

- **Commit after each completed step**, not once at the end: a step is a change
  that stands on its own, and a commit is the checkpoint that makes a wrong step
  cheap to undo. The `git-master` skill is where the message convention lives.

## Handing the work over for acceptance

- Finished is not the same as **accepted**, and the merge is the point of no
  return: it deletes the branch, so anything wrong afterwards is fixed on a new
  branch. That is why the human, not you, decides when it happens.
- `git_complete` merges with `--no-ff`, removes the family's worktree and deletes
  its branch — and it asks the human to approve that one call. The reason they see
  carries the branch and the merge message you wrote. If they reject it, or nobody
  is there to answer, nothing is merged: the branch, the worktree and every commit
  are still there. A rejection is their decision, not a failure — **do not call it
  again on your own initiative.**
- So when the work is ready, stop and report: the branch, what changed, and what
  the human should verify. They can run `/git-complete [<merge-message>]`
  themselves, or let you call the tool and approve it; either way the merge message
  says what the feature did, and one is required. If the ask cannot reach anyone —
  nobody is there to answer, or this deployment composes no approval channel — hand
  the human the subject you composed and let them run the command.
- If `{{integrationBranch}}` has moved past your branch point, the merge is refused
  and nothing is written: the answer reports `not-descendant`, and the branch has to
  be replayed onto `{{integrationBranch}}` yourself before calling again —
  `git rebase --onto {{integrationBranch}} $(git merge-base {{integrationBranch}} <branch>) <branch>`.
- Do not merge, rebase or delete branches by hand — the replay a refused merge asks
  for is the one exception — do not move the main checkout yourself, and never
  force-push: these commands exist so that these steps are the same every time, and
  a branch moved by hand is what makes a release report `not-descendant` or stop on
  `switch-back`.
