/**
 * The two skills this package bundles: how the workflow works, and how to work
 * with git inside it.
 *
 * They are separate because they answer different questions at different moments.
 * One is read when a session is about to change a file and needs to know where it
 * may write; the other when it is about to touch git and needs the repository's
 * conventions. Bundling them would make every commit read the write rules and
 * every write read the commit convention.
 *
 * ## Why a skill rather than a git hook
 *
 * A hook lives in `.git/hooks`, is not versioned, has to be installed into every
 * clone by hand, and can only *reject* a message after the model has already
 * composed it. A skill shapes the message before it is written, ships with the
 * plugin, and needs nothing installed. A hook is the right instrument for a rule
 * a human must not be able to talk their way past; a convention is not that rule.
 *
 * ## Bodies are assets, never strings here
 *
 * Both bodies are Markdown files in this package's `assets/` directory, read on
 * each load rather than cached, so the file is the single source of truth for the
 * text and a broken asset is a failed skill load rather than a failed boot. No
 * instruction text lives in this module, in any form.
 *
 * ## Bodies are rendered from the settings
 *
 * The rules name values a deployment configures — the branch prefix, the
 * integration branch, the worktree root, how long a branch subject may be — so an
 * asset carries `{{branchPrefix}}` and its siblings rather than a literal `feat/`
 * that a configured row would contradict. The substitution happens on each load,
 * beside the read, so a model is told the rules it is actually held to while the
 * asset stays the single source of the text. A placeholder nothing defines is left
 * standing: that is a typo in the asset, and letting it reach the model is how it
 * gets noticed.
 *
 * The asset URLs are one directory deeper than they look: this module builds to
 * `lib/boundary/skill.js` while the assets ship at the package root, so each URL
 * climbs two directories. Nothing type-checks that depth — a wrong one fails at
 * the first model request, not at build time.
 *
 * ## Layer
 *
 * The boundary: dsh calls in here, and this is the only layer that talks to it.
 * References point downward — `core` and `platform` are both fair game — and
 * never upward: nothing below this layer may import it.
 *
 * @module @dsh-external/dotdsh-git-flow/skill
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillDefinition, type SkillProvider } from "@deepseek-ai/dsh-skill";
import type { FlowSettings } from "../platform/settings.js";

/** Name this provider registers under in the skill registry. */
const PROVIDER_NAME = "git-flow";

/** The directory the bodies' relative resources, if any, resolve against. */
const RESOURCE_BASE = { kind: "directory", path: fileURLToPath(new URL("../../assets/", import.meta.url)) } as const;

/**
 * Who may invoke these skills.
 *
 * `userInvocable` is `false` on purpose: this plugin's human surface is its slash
 * commands, and advertising a human-invocable skill would promise a picker entry
 * whose behaviour is not part of what this package verifies.
 */
const INVOCATION = { modelInvocable: true, userInvocable: false } as const;

/** One bundled skill: its discovery entry and the asset holding its body. */
interface BundledSkill {
  /** The skill's name, and the name a project skill would use to override it. */
  readonly name: string;
  /** One line the model reads when choosing a skill. */
  readonly description: string;
  /** When this skill is worth loading. */
  readonly whenToUse: string;
  /** The Markdown asset that is the whole of its body. */
  readonly body: URL;
}

/** The workflow's rules: where a session may write, and how a branch is finished. */
const WORKFLOW_SKILL: BundledSkill = {
  name: "git-flow",
  description: "Where this session may write, and how a feature branch is opened and finished",
  whenToUse: "before the first file edit of a session, or after a write was refused",
  body: new URL("../../assets/git-flow.md", import.meta.url),
};

/** Working with git itself, starting with the commit convention. */
const GIT_MASTER_SKILL: BundledSkill = {
  name: "git-master",
  description: "How to work with git here: the commit-message convention this repository follows",
  whenToUse: "whenever you are about to run a git command or write a commit message",
  body: new URL("../../assets/git-master.md", import.meta.url),
};

/** Every skill this package bundles. */
const SKILLS: readonly BundledSkill[] = [WORKFLOW_SKILL, GIT_MASTER_SKILL];

/**
 * The names of the bundled skills.
 *
 * Exported because a refusal has to send the model to the right one: when the
 * pre-write guard turns a call down, the message it returns names
 * {@link GIT_FLOW_SKILL_NAMES.workflow}, and a name written twice would be a name
 * that can drift.
 */
export const GIT_FLOW_SKILL_NAMES = {
  /** The workflow's rules. */
  workflow: WORKFLOW_SKILL.name,
  /** Git itself. */
  gitMaster: GIT_MASTER_SKILL.name,
} as const;

/** Project one bundled skill onto its discovery entry. */
function candidateOf(skill: BundledSkill): SkillCandidate {
  return {
    name: skill.name,
    description: skill.description,
    whenToUse: skill.whenToUse,
    invocation: INVOCATION,
    source: "bundled",
    provider: PROVIDER_NAME,
    resourceBase: RESOURCE_BASE,
    rank: BUNDLED_SKILL_RANK,
    locator: skill.body,
  };
}

/**
 * Render an asset body with the values this deployment configured.
 *
 * The map is written out rather than derived from the settings object, so the
 * placeholders an asset may use are a list somebody chose: `{{branchPrefix}}` and
 * not `{{anythingOnTheSettings}}`. A placeholder that is not in the map is left
 * exactly as it was written.
 *
 * @param body - the asset's text, as read from disk.
 * @param settings - the plugin's resolved configuration.
 * @returns the text the model reads.
 */
function render(body: string, settings: FlowSettings): string {
  const values: Record<string, string> = {
    branchPrefix: settings.branchPrefix,
    integrationBranch: settings.integrationBranch,
    worktreeRoot: settings.worktreeRoot,
    branchSubjectMaxLength: String(settings.branchSubjectMaxLength),
  };
  return body.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (whole, name: string) => values[name] ?? whole);
}

/**
 * Build the skills this plugin contributes, rendered for one deployment.
 *
 * One provider rather than one per skill: the registry keys providers, not
 * skills, and a second provider would only repeat the same registration. The
 * wiring module is the one that holds the settings, so it builds the provider:
 *
 * ```ts
 * ctx.effect(() => ctx.skills.registerProvider(() => createSkillProvider(settings)));
 * ```
 *
 * @param settings - the plugin's resolved configuration, for the placeholders the
 *   bodies carry.
 * @returns the provider the skill registry pulls from.
 */
export function createSkillProvider(settings: FlowSettings): SkillProvider {
  return {
    name: PROVIDER_NAME,
    list: () => Promise.resolve(SKILLS.map(candidateOf)),
    async get(candidate: SkillCandidate): Promise<SkillDefinition | undefined> {
      const skill = SKILLS.find((entry) => entry.name === candidate.name);
      if (skill === undefined) return undefined;
      const content = render(await readFile(skill.body, "utf8"), settings);
      return {
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse,
        invocation: INVOCATION,
        source: "bundled",
        provider: PROVIDER_NAME,
        resourceBase: RESOURCE_BASE,
        content,
      };
    },
  };
}
