/**
 * The committed check for the claim file. Run: pnpm test
 *
 * The claim file is the durable answer to "which working tree does this family
 * write in", and every decision above it reads it. Its failure modes are therefore
 * quiet ones: a row that lost a field would read back as "no claim" and hand a
 * live tree to the next family; a write that dropped a peer's row would do the
 * same with no error anywhere. So the checks below pin the format (header,
 * version), the identity rule (the table key, never a second copy in the row),
 * replacement and removal, both read paths — the point query a command makes and
 * the full enumeration the sweep makes — and the lock's comings and goings.
 *
 * Every case drives the BUILT `lib/platform/claim.js` against a real scratch
 * repository, with built-ins and the real filesystem only: no harness, no profile,
 * no network.
 *
 * The lock is checked against a real second process as well as in this one: a
 * store that finds the claim file locked is refused rather than made to wait, a
 * holder's lock goes away with the holder, and a lock left behind by a holder that
 * died is taken over once its mtime is old enough.
 *
 * What a green run does NOT mean: that the lock is a proof. Two processes that find
 * the same expired lock and touch it in the same instant can both believe they hold
 * it — the gap the module doc records — and no check can close that window.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ClaimStore, MAIN_WORKTREE } from "../lib/platform/claim.js";
import { check, report, scratchRepo } from "./support.mjs";

/** The claim file's path in one repository, spelled out rather than imported: the checks assert where it lands on disk, not the module's idea of it. */
const claimPath = (repoRoot) => join(repoRoot, ".dsh.local", "git-flow.toml");

/** The lock file's path, spelled out for the same reason as the claim file's. */
const lockPath = (repoRoot) => `${claimPath(repoRoot)}.lock`;

// Three fixed identities, with branches and worktree names that are deliberately
// not derived from them: the file has to mention an identity exactly once, and a
// field built out of the id would make that count say nothing.
const ALPHA = "session-3f2a91c4-0d1e-4b77-9a55-8c2e6f0b1d34";
const BETA = "session-b7c40e18-5a92-4d3f-8e61-2f9a0c7d5b22";
const GAMMA = "session-93d10a76-6c48-4f05-b1e3-7d4a2b8c9e10";

/** One family's record, as a caller above this module hands it in. */
const ALPHA_CLAIM = {
  sessionId: ALPHA,
  branch: "feature/git-flow-rewrite",
  worktreeName: "session-3f2a91c4",
  createdAt: "2026-09-13T00:34:56.840Z",
};
const BETA_CLAIM = {
  sessionId: BETA,
  branch: "feature/other-work",
  worktreeName: "session-b7c40e18",
  createdAt: "2026-09-13T00:35:10.000Z",
};
const GAMMA_CLAIM = {
  sessionId: GAMMA,
  branch: "feature/git-flow-rewrite",
  worktreeName: "session-93d10a76",
  createdAt: "2026-09-13T00:36:00.000Z",
};

await check("open creates the file and its directory, header and version included", async () => {
  const repo = await scratchRepo();
  try {
    const store = await ClaimStore.open(repo.root);
    try {
      assert.equal((await stat(join(repo.root, ".dsh.local"))).isDirectory(), true, "the directory was created");
      const text = await readFile(claimPath(repo.root), "utf8");
      // The header is the file's own account of itself: whoever finds it in a diff
      // learns from it that the paths inside are machine-local and must not ship.
      assert.ok(
        text.startsWith(
          "# Machine-local state for the dsh git-flow plugin. It records which session works in\n" +
            "# which working tree, and its paths are absolute paths on this machine. It is not\n" +
            "# repository content: do not commit it.\n\n",
        ),
        text,
      );
      assert.ok(text.includes('version = "0.1.0"'), text);
    } finally {
      await store.dispose();
    }
  } finally {
    await repo.cleanup();
  }
});

await check("append then query round-trips every field, and the file names the session once", async () => {
  const repo = await scratchRepo();
  try {
    const store = await ClaimStore.open(repo.root);
    try {
      await store.append(ALPHA_CLAIM);
      assert.deepEqual(await store.query(ALPHA), ALPHA_CLAIM);

      const text = await readFile(claimPath(repo.root), "utf8");
      // The table key is the identity. A second copy inside the row would be a
      // second source of truth, and the two could disagree.
      assert.ok(text.includes(`[claims.${ALPHA}]`), text);
      const first = text.indexOf(ALPHA);
      assert.notEqual(first, -1, text);
      assert.equal(text.indexOf(ALPHA, first + 1), -1, `the session id appears more than once:\n${text}`);

      assert.ok(text.includes('branch = "feature/git-flow-rewrite"'), text);
      assert.ok(text.includes('worktreeName = "session-3f2a91c4"'), text);
      assert.ok(text.includes(`createdAt = "${ALPHA_CLAIM.createdAt}"`), text);
    } finally {
      await store.dispose();
    }
  } finally {
    await repo.cleanup();
  }
});

await check("the main-tree sentinel round-trips: a bracketed name is the plain string it looks like", async () => {
  const repo = await scratchRepo();
  try {
    const store = await ClaimStore.open(repo.root);
    try {
      // The one name no worktree can have, because a worktree's directory name is
      // built from a branch subject. It has to survive the file byte for byte: a
      // reader that re-encoded it would send that family to a tree nobody made.
      assert.equal(MAIN_WORKTREE, "[MAIN]");
      const inMainTree = { ...ALPHA_CLAIM, worktreeName: MAIN_WORKTREE };
      await store.append(inMainTree);

      assert.deepEqual(await store.query(ALPHA), inMainTree);
      const text = await readFile(claimPath(repo.root), "utf8");
      assert.ok(text.includes(`worktreeName = "${MAIN_WORKTREE}"`), text);
    } finally {
      await store.dispose();
    }

    // A second store reads it back out of the file rather than out of memory.
    const reopened = await ClaimStore.open(repo.root);
    try {
      assert.deepEqual(await reopened.query(ALPHA), { ...ALPHA_CLAIM, worktreeName: MAIN_WORKTREE });
    } finally {
      await reopened.dispose();
    }
  } finally {
    await repo.cleanup();
  }
});

await check("a second append for one session replaces the row instead of adding one", async () => {
  const repo = await scratchRepo();
  try {
    const store = await ClaimStore.open(repo.root);
    try {
      const replaced = {
        ...ALPHA_CLAIM,
        branch: "feature/replaced",
        worktreeName: "session-replaced",
        createdAt: "2026-09-14T00:00:00.000Z",
      };
      await store.append(ALPHA_CLAIM);
      await store.append(replaced);

      assert.deepEqual(await store.query(ALPHA), replaced);
      assert.deepEqual(await store.find(), [replaced]);
      const text = await readFile(claimPath(repo.root), "utf8");
      assert.equal(text.split(`[claims.${ALPHA}]`).length - 1, 1, text);
      assert.ok(!text.includes("feature/git-flow-rewrite"), "the replaced row must be gone from the file");
    } finally {
      await store.dispose();
    }
  } finally {
    await repo.cleanup();
  }
});

await check("remove drops a row, and removing an absent session rewrites nothing", async () => {
  const repo = await scratchRepo();
  try {
    const store = await ClaimStore.open(repo.root);
    try {
      await store.append(ALPHA_CLAIM);
      await store.append(BETA_CLAIM);
      await store.remove(BETA);
      assert.equal(await store.query(BETA), undefined);
      assert.deepEqual(await store.find(), [ALPHA_CLAIM]);

      // Releasing a family is the one operation that has to be retryable, so an
      // absent id is not merely tolerated: it must not touch the file at all, or a
      // retry would race every other writer for no reason.
      const before = await readFile(claimPath(repo.root));
      await store.remove(BETA);
      await store.remove("session-never-claimed");
      const after = await readFile(claimPath(repo.root));
      assert.ok(before.equals(after), "an absent session changed the file's bytes");
    } finally {
      await store.dispose();
    }
  } finally {
    await repo.cleanup();
  }
});

await check("find with no criteria returns every claim, in the file's order", async () => {
  const repo = await scratchRepo();
  try {
    const store = await ClaimStore.open(repo.root);
    try {
      await store.append(ALPHA_CLAIM);
      await store.append(BETA_CLAIM);
      await store.append(GAMMA_CLAIM);
      // The sweep asks this way, and order is what lets two runs over an unchanged
      // file report the same thing.
      assert.deepEqual(await store.find(), [ALPHA_CLAIM, BETA_CLAIM, GAMMA_CLAIM]);
      assert.deepEqual(await store.find({}), [ALPHA_CLAIM, BETA_CLAIM, GAMMA_CLAIM]);
    } finally {
      await store.dispose();
    }
  } finally {
    await repo.cleanup();
  }
});

await check("find narrows on branch and on worktreeName, both as exact matches", async () => {
  const repo = await scratchRepo();
  try {
    const store = await ClaimStore.open(repo.root);
    try {
      await store.append(ALPHA_CLAIM);
      await store.append(BETA_CLAIM);
      await store.append(GAMMA_CLAIM);

      assert.deepEqual(await store.find({ branch: "feature/git-flow-rewrite" }), [ALPHA_CLAIM, GAMMA_CLAIM]);
      assert.deepEqual(await store.find({ worktreeName: "session-b7c40e18" }), [BETA_CLAIM]);
      assert.deepEqual(
        await store.find({ branch: "feature/git-flow-rewrite", worktreeName: "session-93d10a76" }),
        [GAMMA_CLAIM],
        "both criteria narrow at once",
      );

      // Exact, not a prefix: a worktree name happens to start with the session id,
      // and the full id must not match the shorter field.
      assert.deepEqual(await store.find({ worktreeName: ALPHA }), []);
      assert.deepEqual(await store.find({ worktreeName: BETA }), []);
      assert.deepEqual(await store.find({ branch: "feature/git-flow" }), []);
    } finally {
      await store.dispose();
    }
  } finally {
    await repo.cleanup();
  }
});

await check("a criterion that matches nothing returns no claims", async () => {
  const repo = await scratchRepo();
  try {
    const store = await ClaimStore.open(repo.root);
    try {
      await store.append(ALPHA_CLAIM);
      assert.deepEqual(await store.find({ branch: "feature/no-such-branch" }), []);
      assert.deepEqual(await store.find({ worktreeName: "session-no-such-tree" }), []);
    } finally {
      await store.dispose();
    }
  } finally {
    await repo.cleanup();
  }
});

await check("a claim survives dispose and a reopen", async () => {
  const repo = await scratchRepo();
  try {
    const first = await ClaimStore.open(repo.root);
    await first.append(ALPHA_CLAIM);
    await first.dispose();

    // A store is per operation above it, not per session: what a reopened one reads
    // is also what a second process would read.
    const second = await ClaimStore.open(repo.root);
    try {
      assert.deepEqual(await second.query(ALPHA), ALPHA_CLAIM);
      assert.deepEqual(await second.find(), [ALPHA_CLAIM]);
    } finally {
      await second.dispose();
    }
  } finally {
    await repo.cleanup();
  }
});

await check("two different sessions coexist in one file", async () => {
  const repo = await scratchRepo();
  try {
    const store = await ClaimStore.open(repo.root);
    try {
      await store.append(ALPHA_CLAIM);
      await store.append(BETA_CLAIM);
      // The second append must extend the document, not replace it: a store that
      // wrote only what it was handed would lose ALPHA here and never say so.
      assert.deepEqual(await store.query(ALPHA), ALPHA_CLAIM);
      assert.deepEqual(await store.query(BETA), BETA_CLAIM);
      assert.equal((await store.find()).length, 2);

      const text = await readFile(claimPath(repo.root), "utf8");
      assert.ok(text.includes(`[claims.${ALPHA}]`) && text.includes(`[claims.${BETA}]`), text);
    } finally {
      await store.dispose();
    }
  } finally {
    await repo.cleanup();
  }
});

await check("a malformed document throws instead of reading as no claim", async () => {
  const repo = await scratchRepo();
  try {
    await mkdir(join(repo.root, ".dsh.local"), { recursive: true });
    const path = claimPath(repo.root);
    // Valid TOML, wrong shape: the row exists but cannot say which branch the family
    // owns. Dropping it would read as "no claim" and hand a live tree to the next
    // family, so the whole document has to be refused.
    const broken = [
      'version = "0.1.0"',
      "",
      "[claims.session-broken]",
      'worktreeName = "session-broken"',
      'createdAt = "2026-09-13T00:34:56.840Z"',
      "",
    ].join("\n");
    await writeFile(path, broken, "utf8");

    await assert.rejects(ClaimStore.open(repo.root), (error) => {
      assert.ok(error instanceof Error, "the rejection must be an Error");
      assert.match(error.message, /missing branch/);
      assert.ok(error.message.includes("session-broken"), error.message);
      return true;
    });
    // A refusal is not a repair: the unusable document is left exactly as it was,
    // for a human to fix, rather than overwritten with an empty one.
    assert.equal(await readFile(path, "utf8"), broken);
  } finally {
    await repo.cleanup();
  }
});

await check("a store holds a lock file while it is open, and dispose takes it away", async () => {
  const repo = await scratchRepo();
  try {
    const store = await ClaimStore.open(repo.root);
    try {
      // The lock file's existence *is* the lock, so a store that is open without one
      // is a store no other process can see. What the file says is for whoever finds
      // it — the plugin never reads it back.
      const owner = await readFile(lockPath(repo.root), "utf8");
      assert.match(owner, /^pid=\d+ at=\d{4}-\d{2}-\d{2}T[\d:.]+Z\n$/, owner);
    } finally {
      await store.dispose();
    }
    await assert.rejects(stat(lockPath(repo.root)), { code: "ENOENT" }, "dispose has to remove the lock file");
  } finally {
    await repo.cleanup();
  }
});

await check("a second store over a locked claim file is refused, and names the lock", async () => {
  const repo = await scratchRepo();
  try {
    const held = await ClaimStore.open(repo.root);
    try {
      await assert.rejects(ClaimStore.open(repo.root), (error) => {
        assert.ok(error instanceof Error, "the refusal must be an Error");
        // Refused rather than queued: the message has to name the file in the way, so
        // that whoever reads it can decide to try again — and a human can look.
        assert.match(error.message, /held by another process/);
        assert.ok(error.message.includes(lockPath(repo.root)), error.message);
        return true;
      });
    } finally {
      await held.dispose();
    }

    // The refusal left the holder's lock alone, and letting go is all it takes for
    // the next attempt to go through.
    const next = await ClaimStore.open(repo.root);
    await next.dispose();
  } finally {
    await repo.cleanup();
  }
});

await check("a lock left behind by a holder that died is taken over once it is old enough", async () => {
  const repo = await scratchRepo();
  try {
    await mkdir(join(repo.root, ".dsh.local"), { recursive: true });
    // Exactly what a killed process leaves: the file is there, nobody is behind it,
    // and its mtime is the only thing that says so.
    await writeFile(lockPath(repo.root), "pid=999999 at=1970-01-01T00:00:00.000Z\n", "utf8");
    const longAgo = new Date(Date.now() - 60_000);
    await utimes(lockPath(repo.root), longAgo, longAgo);

    const store = await ClaimStore.open(repo.root);
    try {
      await store.append(ALPHA_CLAIM);
      assert.deepEqual(await store.query(ALPHA), ALPHA_CLAIM);
      // Taking it over touches the file, and the touch rewrites the owner line: it
      // now names this process rather than the one that never came back.
      assert.match(await readFile(lockPath(repo.root), "utf8"), new RegExp(`^pid=${process.pid} `));
    } finally {
      await store.dispose();
    }
  } finally {
    await repo.cleanup();
  }
});

await check("a lock younger than the bound is respected, owner line or none", async () => {
  const repo = await scratchRepo();
  try {
    await mkdir(join(repo.root, ".dsh.local"), { recursive: true });
    // The empty file is the harder of the two: a holder that died between creating
    // the lock and writing its owner. Young is young either way.
    await writeFile(lockPath(repo.root), "", "utf8");
    await assert.rejects(ClaimStore.open(repo.root), /held by another process/);
  } finally {
    await repo.cleanup();
  }
});

await check("an open that fails on the document gives the lock back", async () => {
  const repo = await scratchRepo();
  try {
    await mkdir(join(repo.root, ".dsh.local"), { recursive: true });
    await writeFile(
      claimPath(repo.root),
      [
        'version = "0.1.0"',
        "",
        "[claims.session-broken]",
        'worktreeName = "session-broken"',
        'createdAt = "2026-09-13T00:34:56.840Z"',
        "",
      ].join("\n"),
      "utf8",
    );

    await assert.rejects(ClaimStore.open(repo.root), /missing branch/);
    // The document is still unusable, so the second refusal has to be about the
    // document again. A lock left behind by the failed open would answer "held by
    // another process" instead, and every attempt from then on would be blocked by a
    // store that never existed.
    await assert.rejects(ClaimStore.open(repo.root), (error) => {
      assert.match(error.message, /missing branch/);
      assert.doesNotMatch(error.message, /held by another process/);
      return true;
    });
  } finally {
    await repo.cleanup();
  }
});

await check("a lock held by another process is refused here, and goes away with that process", async () => {
  const repo = await scratchRepo();
  const moduleUrl = new URL("../lib/platform/claim.js", import.meta.url).href;
  // A real second process, because that is the case the lock exists for: every other
  // check here runs in one process, where a lock is only ever taken, never
  // contended. It holds until its input ends, which is the signal to dispose.
  const holder = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        `const { ClaimStore } = await import(${JSON.stringify(moduleUrl)});`,
        `const store = await ClaimStore.open(${JSON.stringify(repo.root)});`,
        'process.stdout.write("held\\n");',
        "process.stdin.resume();",
        'await new Promise((resolve) => process.stdin.on("end", resolve));',
        "await store.dispose();",
      ].join("\n"),
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const holderDone = once(holder, "exit").then(
    () => undefined,
    () => undefined,
  );

  try {
    await waitForLine(holder, "held");
    await assert.rejects(ClaimStore.open(repo.root), /held by another process/);

    holder.stdin.end();
    await holderDone;

    // The holder disposed on its way out, so the lock is gone with it and the file
    // is free again without anyone waiting for an expiry.
    const after = await ClaimStore.open(repo.root);
    await after.dispose();
  } finally {
    holder.kill();
    await repo.cleanup();
  }
});

/**
 * Wait for a child process to print something, or fail the check instead of hanging.
 *
 * @param child - the spawned child.
 * @param line - the text to wait for in its stdout.
 * @returns a promise that settles once the child has printed it.
 */
function waitForLine(child, line) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the child never printed ${line}`)), 10_000);
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes(line)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the child exited with ${code} before printing ${line}: ${output}`));
    });
  });
}

report();
