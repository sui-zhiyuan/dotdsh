/**
 * Reading the session: what it is working on, where, and as whom.
 *
 * Three facts are needed from the harness, and the exact accessor for each
 * matters because none of them is where one would first guess:
 *
 * - the working directory is `agent.session.header.cwd` — a session has no
 *   `meta`; `meta` on the creation options is an *input* that the store folds
 *   into the immutable header;
 * - the session id is `agent.session.id`;
 * - the conversation is `agent.session.deriveMessages()`, a plain synchronous
 *   method returning a fresh snapshot, filterable to genuine human prompts by
 *   `source.kind === 'user'` (which excludes injected context and skill bodies).
 *
 * The agent is typed structurally rather than imported, so this module — and
 * everything that only needs "a session" — stays independent of the harness
 * packages and testable without them.
 *
 * @module @dsh-external/dotdsh-git-flow/session
 */

/** The narrow slice of an agent this plugin reads. `Agent` satisfies it structurally. */
export interface AgentLike {
  readonly session: {
    /** Durable session id. */
    readonly id: string;
    /** Immutable creation metadata; `cwd` is the absolute working directory. */
    readonly header: { readonly cwd?: string | undefined };
    /** Derive the message history synchronously. */
    deriveMessages(): readonly unknown[];
    /**
     * The request header in force after the log's last header event, which is
     * where the session's own provider route and model live. Optional because a
     * session that has not made a request yet has none.
     */
    requestHeader?():
      | { readonly config: { readonly provider: string; readonly model: string } }
      | undefined;
  };
  /**
   * The provider route and model this agent's requests use, when the host sets
   * them. Optional because an agent created without an explicit selection runs on
   * the configured default instead, which the namer falls back to.
   */
  readonly options?: {
    readonly provider?: string | undefined;
    readonly model?: string | undefined;
  };
}

/** The narrow slice of a content block this module reads. */
interface ContentBlockLike {
  readonly type: string;
  readonly text?: string;
}

/** The narrow slice of a message this module reads. */
interface MessageLike {
  readonly role?: string;
  readonly source?: { readonly kind?: string } | undefined;
  readonly content?: readonly ContentBlockLike[];
}

/** How many of the session's opening prompts are considered when naming a branch. */
const INTENT_MESSAGES_SCANNED = 8;

/** Longest first line treated as a nameable intent. */
const INTENT_LINE_MAX_CHARS = 200;

/**
 * The session's working directory.
 *
 * @param agent - the calling agent.
 * @returns the absolute cwd, or `undefined` when the session has none.
 */
export function sessionCwd(agent: AgentLike): string | undefined {
  const cwd = agent.session.header.cwd;
  return cwd === undefined || cwd === "" ? undefined : cwd;
}

/**
 * The session's id.
 *
 * @param agent - the calling agent.
 * @returns the durable session id.
 */
export function sessionId(agent: AgentLike): string {
  return agent.session.id;
}

/**
 * The text blocks of one message, joined.
 *
 * @param message - a derived message.
 * @returns the message's text.
 */
function textOf(message: MessageLike): string {
  const content = message.content ?? [];
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

/**
 * Reduce one prompt to the line that states what the work is.
 *
 * The first line is the right target: a human writing "add the login redirect"
 * and then pasting a stack trace has stated the intent in the first line, while a
 * later line would name the branch after a fragment of the paste.
 *
 * @param text - the prompt's text.
 * @returns the candidate intent, or `undefined` when nothing suitable is there.
 */
function intentLine(text: string): string | undefined {
  for (const rawLine of text.split("\n")) {
    const line = rawLine
      .trim()
      // A prompt may open with a slash command; that names an action, not the work.
      .replace(/^\/[a-z][a-z0-9-]*\s*/i, "")
      // Leading list, quote, and heading punctuation is not part of the name.
      .replace(/^[>#*\-\d.)\s]+/, "")
      .trim();
    if (line === "") continue;
    return line.slice(0, INTENT_LINE_MAX_CHARS);
  }
  return undefined;
}

/**
 * Candidate intent strings for this session, oldest first.
 *
 * Oldest first on purpose: a session's *opening* prompt states its purpose, while
 * the most recent one is often a follow-up — "yes", "go ahead", "and then run the
 * tests" — that would make a poor branch name.
 *
 * @param agent - the calling agent.
 * @returns the candidate intents, in the order they were written.
 */
export function sessionIntents(agent: AgentLike): readonly string[] {
  const messages = agent.session.deriveMessages() as readonly MessageLike[];
  const intents: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    if (message.source?.kind !== "user") continue;
    const line = intentLine(textOf(message));
    if (line !== undefined) intents.push(line);
    if (intents.length >= INTENT_MESSAGES_SCANNED) break;
  }
  return intents;
}

/**
 * The best available statement of what this session is working on.
 *
 * @param agent - the calling agent.
 * @returns the intent text, or `undefined` when the session has no usable prompt.
 */
export function sessionIntent(agent: AgentLike): string | undefined {
  return sessionIntents(agent)[0];
}
