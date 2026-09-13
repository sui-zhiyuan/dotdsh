/**
 * The scaffolding every committed check shares.
 *
 * The checks drive the built package against a real scratch repository and a real
 * `git`, with no harness present: `exec` gets `nodeRunner`, and the boundary
 * modules get a fake agent whose `subprocess` and `sessions` services are small
 * stand-ins satisfying exactly the contracts `shared.ts` narrows them to. That is
 * what lets `pnpm test` exercise the whole workflow — claim file, branch, merge,
 * sweep, refusals — on any machine, with nothing installed.
 *
 * Each `verify-*.mjs` file imports from this module, runs its own checks, and
 * ends with {@link report}.
 *
 * @module @dsh-external/dotdsh-git-flow/test/support
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaimStore, MAIN_WORKTREE } from "../lib/platform/claim.js";
import { GitClient, nodeRunner } from "../lib/platform/exec.js";

let passed = 0;
const failures = [];

/**
 * Run one named check.
 *
 * A thrown assertion is a failed check, not a crashed suite: the remaining checks
 * still run, so one broken path does not hide the state of the others.
 *
 * @param name - what this check proves, in one line.
 * @param body - the check; async and sync both work.
 */
export async function check(name, body) {
  try {
    await body();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    const detail = error instanceof Error ? (error.message ?? String(error)) : String(error);
    failures.push(`${name}: ${detail}`);
    console.log(`FAIL ${name}\n     ${detail}`);
  }
}

/** Print the tally and exit non-zero when anything failed. */
export function report() {
  console.log(`\n${passed} passed, ${failures.length} failed`);
  for (const failure of failures) console.log(`  ${failure}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

/**
 * A scratch repository with one commit on `master`.
 *
 * @returns the repository's root, a client bound to it, and a cleanup that
 *   removes the tree.
 */
export async function scratchRepo() {
  const root = await mkdtemp(join(tmpdir(), "gitflow-check-"));
  const git = new GitClient(nodeRunner, root);
  await git.run(["init", "-q"]);
  await git.run(["config", "user.email", "check@example.com"]);
  await git.run(["config", "user.name", "git-flow check"]);
  await writeFile(join(root, "README.md"), "base\n");
  await git.run(["add", "-A"]);
  await git.run(["commit", "-qm", "base"]);
  await git.run(["branch", "-M", "master"]);
  return { root, git, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/**
 * Put another session in the repository's main tree, on the record.
 *
 * This is the one thing that makes a start leave the main tree alone: a family is
 * isolated in a worktree because a family that can still come back is *in* the
 * main tree, and the claim file is where that is written down. Callers pass the
 * returned id back — in the agent's session records, or in `resumableSessionIds` —
 * so the holder reads as a session that can still come back.
 *
 * @param root - the scratch repository's root.
 * @param holder - the session id to record as holding the main tree.
 * @returns the holder's id, for the caller to list as resumable.
 */
export async function occupyMainTree(root, holder) {
  const store = await ClaimStore.open(root);
  try {
    await store.append({
      sessionId: holder,
      branch: `feat/${holder}`,
      worktreeName: MAIN_WORKTREE,
      createdAt: new Date().toISOString(),
    });
  } finally {
    await store.dispose();
  }
  return holder;
}

/**
 * Commit one named file, leaving everything else — the claim file included — out.
 *
 * A family that works in place commits in the repository's own tree, where the
 * machine-local `.dsh.local/` sits untracked: `add -A` there would sweep the claim
 * file into a commit the check is not about.
 *
 * @param git - a client bound anywhere in the repository.
 * @param cwd - the working tree the commit happens in.
 * @param name - the file to commit, relative to `cwd`.
 * @param message - the commit subject.
 */
export async function commitFile(git, cwd, name, message) {
  await git.run(["-C", cwd, "add", name]);
  await git.run(["-C", cwd, "commit", "-qm", message]);
}

/**
 * The `subprocess` service, as `shared.ts` uses it.
 *
 * `argv` is executed directly — never through a shell — and the collected output
 * stays readable after exit, which is how the adapter reads it.
 *
 * @returns a service whose `spawn` returns a handle shaped like the harness's.
 */
function subprocessService() {
  return {
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...(spec.env ?? {}) },
        ...(spec.signal === undefined ? {} : { signal: spec.signal }),
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const done = new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve({ exitCode: code }));
      });
      return {
        pid: child.pid ?? -1,
        collected: {
          stdout: { readFrom: () => ({ text: stdout }) },
          stderr: { readFrom: () => ({ text: stderr }) },
        },
        done,
        terminate: () => child.kill("SIGTERM"),
        waitForExit: () => done.then(() => true),
      };
    },
  };
}

/**
 * The session store, as `shared.ts` uses it.
 *
 * @param records - the resident sessions, in the order `list` should report them.
 * @returns a store with `get` and `list`.
 */
function sessionsService(records) {
  const byId = new Map(records.map((record) => [record.id, record]));
  return { get: (id) => byId.get(id), list: () => [...byId.values()] };
}

/**
 * A calling agent with the two services mounted, plus the messages it was told.
 *
 * @param sessionId - the session the agent is running.
 * @param cwd - the session's working directory.
 * @param records - the resident sessions; defaults to this session alone.
 * @returns the agent, the session store, and the list `followup` fills.
 */
export function makeAgent(sessionId, cwd, records = [{ id: sessionId, header: { cwd } }]) {
  const sessions = sessionsService(records);
  const injected = [];
  const subprocess = subprocessService();
  const agent = {
    session: sessions.get(sessionId),
    ctx: { get: (name) => (name === "subprocess" ? subprocess : name === "sessions" ? sessions : undefined) },
    followup: (message) => injected.push(message),
  };
  return { agent, sessions, injected };
}

/** A caller-owned cancellation that never fires. */
export const signal = new AbortController().signal;
