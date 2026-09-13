/**
 * The committed check for the tool boundary: the `ssh_run` descriptor, the text
 * it returns, and the whole path from a call through the real process seam.
 * Run: pnpm test
 *
 * The descriptor is not just an object this package owns: `index.ts` hands it to
 * the harness's own `defineTool`, whose schema compiler runs at definition time
 * and refuses an author schema it cannot enforce. A descriptor that type-checks
 * here but throws there would take the whole row down at boot, so the compile is
 * driven in this file with the harness's real `dsh-tools`, exactly as the plugin
 * wires it — and a schema the registry refuses is driven too, to prove this check
 * would have caught it.
 *
 * The rendered text is pinned because the module header pins it: the model reads
 * this string, and a field that silently changed shape (the connection, the
 * duration, a stream section appearing empty) is a change the model would have to
 * guess at.
 *
 * The last checks run a real `sh` script standing in for `ssh` through the real
 * `nodeRunner`, so a command's exit status and both streams are shown to survive
 * the pool and the renderer together — and `apply` is driven end to end with a
 * stand-in Context, showing the tool it registers is the same compiled
 * definition and that its disposer releases what the row held.
 *
 * What a green run does NOT prove: that a real cordis fiber accepts the mount
 * (the Context here is a two-method stand-in for `effect` and `tools.register`,
 * not a running harness), that a live ToolRuntime admits the definition or
 * enforces the schema against a model's arguments (the compile-time refusal is
 * checked, not the runtime validation), that the model is shown the description
 * as written, or that any page or transcript renders the returned block. Nor does
 * it prove the remote shell's semantics: the fake ssh is this package's own argv
 * seen from outside, not a real server.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";

import { sshTools } from "../lib/boundary/tools.js";
import { Config, apply, inject, name } from "../lib/index.js";
import {
  assert,
  check,
  readEvents,
  realSeam,
  report,
  seamPool,
} from "./support.mjs";

/**
 * The `ssh_run` tool as `index.ts` wires it: the descriptor's parameters, the
 * harness's `defineTool`, and the one-text-block output declaration.
 *
 * Kept identical to the plugin's own wiring on purpose — a check that compiled
 * some other shape would prove nothing about the plugin.
 *
 * @param pool - the pool the tool's execute calls.
 * @returns the registry-ready tool definition.
 */
function compiledSshRun(pool) {
  const [tool] = sshTools(pool);
  return defineTool({
    ...tool.descriptor,
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    execute: (args, execution) => tool.execute(args, execution),
  });
}

/** A pool-shaped object that records the requests it was handed. */
function recordingPool(result) {
  const calls = [];
  return {
    calls,
    run(request) {
      calls.push(request);
      return Promise.resolve(result);
    },
  };
}

/** One finished call, with every field at a quiet default. */
function sshResult(overrides = {}) {
  return {
    destination: "deploy@build-01",
    command: "uptime",
    exitCode: 0,
    stdout: "",
    stderr: "",
    connection: "fresh",
    durationMs: 12,
    timedOut: false,
    truncated: false,
    ...overrides,
  };
}

await check("the plugin declares the name and the one service the row mounts under", () => {
  // `name` is what the harness reports for the row, following the package name
  // minus scope and prefix; `inject` is what holds the row until the tool
  // registry it registers into exists, instead of mounting without it.
  assert.equal(name, "lazy-ssh");
  assert.deepEqual(inject, ["tools"]);
});

await check("sshTools returns the one ssh_run descriptor, with the documented argument schema", () => {
  const tools = sshTools(recordingPool(sshResult()));

  // One tool was asked for; a second is a second schema for the model to choose
  // between.
  assert.equal(tools.length, 1);
  const [tool] = tools;
  assert.equal(tool.descriptor.name, "ssh_run");
  assert.equal(typeof tool.descriptor.description, "string");
  assert.ok(tool.descriptor.description.length > 0);

  const parameters = tool.descriptor.parameters;
  assert.deepEqual(Object.keys(parameters).sort(), ["command", "server", "timeoutMs"]);
  assert.equal(parameters.server.type, "string");
  assert.equal(parameters.server.required, true);
  assert.equal(parameters.command.type, "string");
  assert.equal(parameters.command.required, true);
  assert.equal(parameters.timeoutMs.type, "number");
  // Optional means the key is absent, not `false`: the schema compiler refuses
  // `required: false` outright.
  assert.ok(!Object.hasOwn(parameters.timeoutMs, "required"), "an optional parameter must not carry `required`");
  assert.equal(typeof tool.execute, "function");
});

await check("the descriptor compiles through the harness's own defineTool, exactly as index.ts wires it", () => {
  const compiled = compiledSshRun(recordingPool(sshResult()));

  // `defineTool` compiles the author schema at definition time and exposes the
  // enforced raw JSON Schema; both required arguments must be there and the
  // optional one must not.
  assert.equal(compiled.name, "ssh_run");
  assert.equal(compiled.parameters.type, "object");
  assert.deepEqual(compiled.parameters.required, ["server", "command"]);
  assert.deepEqual(Object.keys(compiled.parameters.properties).sort(), ["command", "server", "timeoutMs"]);
  assert.ok(
    !compiled.parameters.required.includes("timeoutMs"),
    "timeoutMs is optional: a call that sets none must be valid",
  );
});

await check("a schema the registry refuses (required: false) fails in this check, not at boot", () => {
  // The exact hazard the descriptor's own comment names. If `defineTool` ever
  // stopped compiling the author schema at definition time, this would slip
  // through to the running harness instead.
  assert.throws(
    () =>
      defineTool({
        name: "ssh_run",
        description: "a descriptor whose optional parameter is declared the wrong way",
        parameters: {
          server: { type: "string", required: true },
          timeoutMs: { type: "number", required: false },
        },
        output: {
          schema: { type: "string" },
          render: (_args, value) => [{ type: "text", text: value }],
        },
        execute: () => Promise.resolve(""),
      }),
    /required must be true when present/,
  );
});

await check("execute forwards destination, command, deadline and cancellation to the pool", async () => {
  const result = sshResult();
  const pool = recordingPool(result);
  const tool = compiledSshRun(pool);
  const controller = new AbortController();

  const text = await tool.execute(
    { server: "deploy@build-01", command: "uptime", timeoutMs: 1234 },
    { signal: controller.signal },
  );
  assert.equal(typeof text, "string");
  assert.equal(pool.calls.length, 1);
  assert.equal(pool.calls[0].destination, "deploy@build-01");
  assert.equal(pool.calls[0].command, "uptime");
  assert.equal(pool.calls[0].timeoutMs, 1234);
  assert.equal(pool.calls[0].signal, controller.signal, "the caller's cancellation must reach the pool");

  // A call that names no deadline must not invent one: the pool's configured
  // default is what applies.
  await tool.execute({ server: "deploy@build-01", command: "uptime" }, { signal: undefined });
  assert.equal(pool.calls.length, 2);
  assert.ok(!Object.hasOwn(pool.calls[1], "timeoutMs"), "an unset timeoutMs must not be sent as a value");
});

await check("the rendered result is the documented block, and a stream section appears only when it said something", async () => {
  const render = async (overrides) => compiledSshRun(recordingPool(sshResult(overrides))).execute(
    { server: "deploy@build-01", command: "uptime" },
    {},
  );

  // Both streams: header, then each section, with the final newline of each
  // stream removed so the block does not end in blank lines.
  assert.equal(
    await render({ exitCode: 0, stdout: "out\n", stderr: "err\n", connection: "reused", durationMs: 142 }),
    [
      "ssh deploy@build-01: exit 0 (reused connection, 142 ms)",
      "--- stdout ---",
      "out",
      "--- stderr ---",
      "err",
    ].join("\n"),
  );

  // One stream only: the other section is absent rather than printed empty.
  const stdoutOnly = await render({ stdout: "out\n" });
  assert.equal(stdoutOnly, "ssh deploy@build-01: exit 0 (fresh connection, 12 ms)\n--- stdout ---\nout");
  const stderrOnly = await render({ stderr: "err\n" });
  assert.equal(stderrOnly, "ssh deploy@build-01: exit 0 (fresh connection, 12 ms)\n--- stderr ---\nerr");

  // No output at all: said once, and only once.
  const silent = await render({ exitCode: 3 });
  assert.equal(silent, "ssh deploy@build-01: exit 3 (fresh connection, 12 ms)\n(no output)");
  assert.equal(silent.split("(no output)").length - 1, 1, "(no output) must appear exactly once");

  // A non-zero status is part of the answer, not an error, and the notes are
  // appended to the header after the duration.
  assert.equal(
    await render({ exitCode: -1, stdout: "partial", timedOut: true, truncated: true }),
    [
      "ssh deploy@build-01: exit -1 (fresh connection, 12 ms), timed out, output truncated",
      "--- stdout ---",
      "partial",
    ].join("\n"),
  );
  assert.equal(
    await render({ timedOut: true }),
    "ssh deploy@build-01: exit 0 (fresh connection, 12 ms), timed out\n(no output)",
  );
  assert.equal(
    await render({ truncated: true }),
    "ssh deploy@build-01: exit 0 (fresh connection, 12 ms), output truncated\n(no output)",
  );
});

await check("a real command's status and both streams reach the model as one text block", async () => {
  const seam = await realSeam();
  const pool = seamPool(seam);
  try {
    const tool = compiledSshRun(pool);
    const text = await tool.execute(
      {
        server: "deploy@build-01",
        command: "printf 'out\\n'; printf 'err\\n' 1>&2; exit 4",
      },
      {},
    );

    assert.match(
      text,
      /^ssh deploy@build-01: exit 4 \(fresh connection, \d+ ms\)\n--- stdout ---\nout\n--- stderr ---\nerr$/,
      text,
    );

    // A second call over the same connection says so, which is the whole point of
    // the plugin stated in the string the model reads.
    const second = await tool.execute({ server: "deploy@build-01", command: "printf 'again\\n'" }, {});
    assert.match(second, /^ssh deploy@build-01: exit 0 \(reused connection, \d+ ms\)\n--- stdout ---\nagain$/, second);

    // One ssh process per call: the reuse is OpenSSH's, and this package must not
    // have added a probe or a second connection for it.
    assert.equal(readEvents(seam.logPath).filter((event) => event.kind === "CMD").length, 2);
  } finally {
    await pool.dispose();
    await seam.cleanup();
  }
});

await check("a command that outlives its timeout is reported timed out, not left hanging", async () => {
  const seam = await realSeam();
  const pool = seamPool(seam);
  try {
    const tool = compiledSshRun(pool);
    const started = Date.now();
    const text = await tool.execute({ server: "deploy@build-01", command: "block 5", timeoutMs: 300 }, {});
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 5000, `the call must end at its deadline, not at the remote command's: ${elapsed} ms`);
    assert.match(
      text,
      /^ssh deploy@build-01: exit -1 \(fresh connection, \d+ ms\), timed out\n--- stdout ---\npartial-output$/,
      text,
    );
  } finally {
    await pool.dispose();
    await seam.cleanup();
  }
});

await check("output past maxOutputBytes is reported as truncated in the rendered header", async () => {
  const seam = await realSeam();
  const pool = seamPool(seam, { maxOutputBytes: 256 });
  try {
    const tool = compiledSshRun(pool);
    const command = "i=0; while [ $i -lt 100 ]; do printf '0123456789'; i=$((i+1)); done";
    const text = await tool.execute({ server: "deploy@build-01", command }, {});

    const [header, ...rest] = text.split("\n");
    assert.match(header, /^ssh deploy@build-01: exit 0 \(fresh connection, \d+ ms\), output truncated$/, header);
    assert.equal(rest[0], "--- stdout ---");
    assert.equal(rest.slice(1).join("\n").length, 256, "the block carries the capped stream, not the whole of it");
  } finally {
    await pool.dispose();
    await seam.cleanup();
  }
});

await check("apply mounts the row, registers ssh_run, and its disposer releases the pool", async () => {
  const seam = await realSeam();
  try {
    // A stand-in for the harness's Context, following the two contracts `apply`
    // narrows it to: `effect` runs its callback and keeps the disposer, and
    // `tools.register` accepts a definition and returns its own disposer. This is
    // the mount path, not a real cordis fiber — see the header.
    const registered = [];
    const disposers = [];
    const context = {
      effect(callback) {
        const disposer = callback();
        if (typeof disposer === "function") disposers.push(disposer);
        return disposer;
      },
      tools: {
        register(tool) {
          registered.push(tool);
          return () => {
            registered.splice(registered.indexOf(tool), 1);
          };
        },
      },
    };

    const exitListenersBefore = process.listenerCount("exit");
    apply(
      context,
      Config({
        sshBinary: seam.binary,
        controlDir: join(seam.dir, "apply-control"),
        idleTimeoutMs: 60_000,
      }),
    );

    try {
      // The row fails while mounting, not at the first call: the directory the
      // sockets need exists and is private before anything dials.
      assert.equal(statSync(join(seam.dir, "apply-control")).mode & 0o777, 0o700);
      assert.equal(registered.length, 1, "the row contributes exactly one tool");
      assert.equal(registered[0].name, "ssh_run");
      // Registered through the harness's `defineTool`, so what the registry holds
      // is the compiled JSON Schema, not the author's parameter map.
      assert.equal(registered[0].parameters.type, "object");
      assert.deepEqual(registered[0].parameters.required, ["server", "command"]);
      // The shutdown hook that backs the pool for a bare `process.exit`.
      assert.equal(process.listenerCount("exit"), exitListenersBefore + 1);

      const text = await registered[0].execute({ server: "deploy@build-01", command: "printf 'mounted\\n'" }, {});
      assert.match(text, /^ssh deploy@build-01: exit 0 \(fresh connection, \d+ ms\)\n--- stdout ---\nmounted$/);
    } finally {
      // Unmounting is the graceful half of teardown. It runs on failure too, so a
      // broken assertion cannot leave an exit hook behind on this process.
      for (const disposer of [...disposers].reverse()) await disposer();
    }

    assert.deepEqual(registered, [], "unmounting must take the tool back out of the registry");
    assert.equal(process.listenerCount("exit"), exitListenersBefore, "unmounting must remove the exit hook");
    const releases = readEvents(seam.logPath).filter((event) => event.kind === "REL");
    assert.equal(releases.length, 1, "the disposer must release the connection the row was holding");
  } finally {
    await seam.cleanup();
  }
});

report();
