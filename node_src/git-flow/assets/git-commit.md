# Writing commit messages

A commit message is read far more often than it is written, and it is read by
someone who has lost the context you have right now. Write for that reader.

The shape below is **Conventional Commits 1.0.0** (CC BY 3.0). Where a rule is
normative the spec's own wording is kept — *MUST*, *MAY* — so it is clear what a
tool consuming these messages is entitled to rely on. Everything marked **house
style** is this project's preference layered on top, not part of the spec.

## The shape

```
<type>[optional scope][optional !]: <description>

[optional body]

[optional footer(s)]
```

- *MUST*: the commit is prefixed with a **type** — a noun such as `feat` or `fix`
  — followed by the optional scope, the optional `!`, and a required terminal
  colon and space.
- *MUST*: a **scope**, when present, is a noun describing a section of the
  codebase in parentheses: `fix(parser): …`.
- *MUST*: the **description** immediately follows the colon and space, and is a
  short summary of the change.
- *MUST*: the **body**, when present, begins one blank line after the
  description. It is free-form and *MAY* be any number of paragraphs.
- *MAY*: one or more **footers**, one blank line after the body.

```
feat(lang): add Polish language
```

```
fix: prevent racing of requests

Introduce a request id and a reference to latest request. Dismiss
incoming responses other than from latest request.

Reviewed-by: Z
Refs: #123
```

## Types, and the version bump each one promises

The spec fixes the meaning of exactly two types, and they are the two that carry
a promise about the next release:

| Type | Meaning | Release |
| --- | --- | --- |
| `feat` | *MUST* be used when the commit adds a new feature | `MINOR` |
| `fix` | *MUST* be used when the commit is a bug fix | `PATCH` |
| any type with a breaking change | see below | `MAJOR` |

Other types *MAY* be used, and carry no implicit version effect. The set this
project uses, following Angular's convention:

`build`, `chore`, `ci`, `docs`, `style`, `refactor`, `perf`, `test`, `revert`.

Choose the type by what changes **for a consumer of the code**, not by which
files moved:

- a new capability, however small, is `feat`;
- a change in existing behaviour that fixes something wrong is `fix`;
- moving code without changing behaviour is `refactor` — reviewers can then read
  the diff with the right expectations;
- reformatting, renaming a private symbol, or a comment is `style` or `chore`.

If a commit seems to conform to more than one type, the answer is normally **not**
to pick the strongest one: go back and make multiple commits.

## Breaking changes

*MUST*: a breaking change is indicated either in the type/scope prefix or as a
footer.

- In the prefix: `!` immediately before the `:`. A `BREAKING CHANGE:` footer *MAY*
  then be omitted, and the description itself becomes the explanation.
- As a footer: the uppercase text `BREAKING CHANGE`, a colon, a space, and a
  description.

```
feat!: send an email to the customer when a product is shipped
```

```
feat(api)!: send an email to the customer when a product is shipped
```

```
feat!: drop support for Node 6

BREAKING CHANGE: use JavaScript features not available in Node 6.
```

A breaking change is meaningful in a commit of **any** type, not only `feat` and
`fix` — including `refactor` or `chore`.

## Footers

*MAY*: one or more footers, each beginning one blank line after the body.

- *MUST*: each footer is a word token, then either `:<space>` or `<space>#`, then
  a string value. This follows the git trailer convention.
- *MUST*: a footer token uses `-` in place of whitespace — `Acked-by`,
  `Reviewed-by`, `Refs`. The one exception is `BREAKING CHANGE`, which *MAY* also
  be used as a token despite the space.
- *MUST*: a footer value may contain spaces and newlines; parsing stops at the
  next valid token/separator pair.
- *MUST*: `BREAKING-CHANGE` is synonymous with `BREAKING CHANGE` as a footer
  token.

Common footers: `Refs: #123`, `Closes: #123`, `Reviewed-by: Z`,
`Co-authored-by: Name <email>`.

## Case

*MUST NOT*: implementors may not treat the units of a Conventional Commit as
case-sensitive — **with the exception of `BREAKING CHANGE`, which *MUST* be
uppercase**.

**House style**: lowercase type, scope and description, and no trailing period on
the description. Consistency matters more than the choice.

## One commit, one idea

**House style**, and the rule that makes the rest useful. If the body needs "and
also", the commit is probably two commits.

This matters more than usual in an agent-driven workflow, where commits are the
checkpoints that make a bad step cheap to undo: a commit mixing a refactor with a
behaviour change cannot be reverted without losing both.

Split by what a reviewer would want to accept or reject independently. A
mechanical rename across many files belongs in its own commit, ahead of the
behaviour change that needed it.

## The body says why, not what

**House style**. The diff already shows what changed. The body is for the
constraint you were under, the cause of the bug, the approach you rejected and
why. Skip it when the description truly says everything.

Also state what the commit does *not* do: if the change is partial, say what is
still missing, so nobody reads the merge as completeness.

## Do not

- Do not write `fix bug`, `update code`, `wip`, or a restatement of the diff.
- Do not claim more than the commit does.
- Do not leave a commit that does not build or pass tests, unless the body says
  so and why it is deliberate.
- Do not mix unrelated formatting into a functional change.
- Do not attribute the work to a tool. The message describes the change, not the
  process that produced it.
- Do not use a type outside the set above; a typo such as `feet` does not fail
  anything, it just makes the commit invisible to every tool reading the history.

## When a message is already wrong

Before the commit is merged or released, fix it in history with `git rebase -i`
and reword it. After a release the cleanup depends on your tooling — which is the
reason to get it right the first time.

A commit that does not conform is not a catastrophe: it simply means tools based
on the spec will skip it.

For a revert, use the `revert` type and reference what is being reverted:

```
revert: let us never again speak of the noodle incident

Refs: 676104e, a215868
```

## Why the shape is worth the discipline

- It is machine-readable: changelogs and semantic version bumps can be derived
  from the history instead of maintained by hand.
- It forces the question "is this one change or two?", which is the question that
  produces reviewable commits.
- It survives the handover: the reason a change exists is in the history, not in
  someone's memory.

Treat these rules as applying from the very first commit, including during
initial development. Somebody is already using the software — at minimum your
future self.

## Examples

```
feat(git-flow): add the pre-write branch guard

A session that edits files while the integration branch is checked out
would commit onto it directly. The guard runs before dispatch and starts a
feature branch first, so the invariant holds without relying on the model
to remember it.
```

```
fix(ignore): verify the rule with check-ignore instead of trusting the write

A `.gitignore` line is a claim, not a fact: a later `!` rule or a parent
directory's rule can override it, and the failure is silent — the worktree
is simply staged as an embedded repository. The guard now re-asks git and
refuses to create the worktree when the answer is no.
```

```
refactor(flow): run the merge in the tree that has the integration branch

Behaviour is unchanged. The single-session and parallel-session paths shared
no merge code; both now target whichever tree git reports for the branch,
falling back to a temporary worktree when no tree has it.
```

```
perf(exec)!: drop the shell from every git invocation

BREAKING CHANGE: `runGit(command)` is replaced by `gitClient({ argv })`.
Callers that relied on shell expansion — redirection, `&&`, globbing — must
pass explicit arguments; none were found in this repository.
```
