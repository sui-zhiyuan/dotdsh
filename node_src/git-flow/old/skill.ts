/**
 * The bundled commit-message skill.
 *
 * The requirement was a skill that standardises commit messages — or a
 * `pre-commit` hook. A skill is the right instrument and a hook is not, for a
 * reason worth stating: a hook lives in `.git/hooks`, is not versioned, has to be
 * installed into every clone by hand, and can only *reject* a message after the
 * model has already composed it. A skill shapes the message before it is
 * written, ships with the plugin, and needs nothing installed. A hook would be
 * the right addition for a rule a human must not be able to talk their way past;
 * a stylistic convention is not that rule.
 *
 * The skill ships as a Markdown asset inside this package and is registered
 * through the same seam the harness's own bundled skills use, so it needs no
 * `.dsh/skills/` directory on the machine and no file written outside the
 * package. It is registered at the bundled rank, which means a project-level
 * skill of the same name in `<project>/.dsh/skills/` outranks it — the intended
 * escape hatch for a repository with its own convention.
 *
 * @module @dsh-external/dotdsh-git-flow/skill
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillDefinition, type SkillProvider } from "@deepseek-ai/dsh-skill";

/** Name this provider registers under in the skill registry. */
const PROVIDER_NAME = "git-flow";

/** The skill's own name, and the name a project skill would have to use to override it. */
export const SKILL_NAME = "git-commit";

/** The packaged body, resolved relative to the built module so it survives installation. */
const BODY_URL = new URL("../assets/git-commit.md", import.meta.url);

/** The directory the body's relative resources, if any, resolve against. */
const RESOURCE_BASE = { kind: "directory", path: fileURLToPath(new URL("../assets/", import.meta.url)) } as const;

const DESCRIPTION =
  "How to write a commit message: the Conventional Commits 1.0.0 shape, one idea per commit, why over what";

const WHEN_TO_USE = "whenever composing a git commit message";

/**
 * The skill's discovery entry.
 *
 * `userInvocable` is `false` on purpose: this plugin's human surface is its two
 * slash commands, and advertising a human-invocable skill would promise a picker
 * entry whose behaviour is not part of what this package verifies.
 */
const CANDIDATE: SkillCandidate = {
  name: SKILL_NAME,
  description: DESCRIPTION,
  whenToUse: WHEN_TO_USE,
  invocation: { modelInvocable: true, userInvocable: false },
  source: "bundled",
  provider: PROVIDER_NAME,
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: BODY_URL,
};

/**
 * The provider object. Its body is read on each load rather than cached, matching
 * the harness's own bundled provider and keeping the package the single source of
 * truth for the text.
 */
const provider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get(candidate: SkillCandidate): Promise<SkillDefinition | undefined> {
    if (candidate.name !== SKILL_NAME) return undefined;
    const content = await readFile(BODY_URL, "utf8");
    return {
      name: SKILL_NAME,
      description: DESCRIPTION,
      whenToUse: WHEN_TO_USE,
      invocation: CANDIDATE.invocation,
      source: "bundled",
      provider: PROVIDER_NAME,
      resourceBase: RESOURCE_BASE,
      content,
    };
  },
};

/**
 * Register the bundled skill provider.
 *
 * @param ctx - the plugin context, with `skills` injected.
 * @returns the disposer that unregisters the provider.
 */
export function registerSkill(ctx: Context): () => void {
  return ctx.skills.registerProvider(() => provider);
}
