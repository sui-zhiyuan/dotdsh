// The browser <-> host contract for "open this file in my editor", plus the
// host routes that serve it.
//
// Layer: between the launcher (`editor-launch.ts`) and the plugin wiring
// (`index.ts`). `index.ts` is the only caller. This file owns the wire shape and
// the web security fence; it does NOT resolve settings, does NOT spawn, and does
// NOT know how a page finds a file path in its own DOM — the browser half's
// half of this contract is documented next to the constants below and mirrored
// in `client/index.js`.
//
// Security, in one place: both routes ask the composition's `connection` service
// for a rejection first (`requestRejection`), exactly as dsh's own
// `/open-in-app/*` routes do. That fence is the Host/Origin check plus the
// browser-auth login-token cookie, so an unauthenticated or cross-site caller
// never reaches a filesystem resolution, and a launch cannot be triggered by a
// page the user did not load from this dsh.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
// Type-only AND deliberately value-free: these two packages are what declare
// `Context.sessions` and `Context.webServer`, so importing them for their types
// is what makes those properties compile here. Nothing is imported at runtime.
import type {} from "@deepseek-ai/dsh-host-webserver";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { EditorLaunchFailure, EditorLaunchResult } from "./editor-launch.js";
import { launchInEditor, resolveEditorCommand } from "./editor-launch.js";
import type { Config } from "./settings.js";
import { SETTINGS_NAMESPACE } from "./settings.js";

export type { SessionId };

/**
 * Base path both routes live under. dsh's own single-purpose browser routes are
 * unprefixed (`/open-in-app/...`); this one is namespaced because it belongs to
 * this package, not to the composition.
 */
export const OPEN_IN_EDITOR_ROUTE_BASE = "/ui-tweaks/open-in-vscode";

/** `GET` availability probe: "can a Ctrl/Cmd+click be intercepted at all?". */
export const OPEN_IN_EDITOR_STATUS_ROUTE = `${OPEN_IN_EDITOR_ROUTE_BASE}/status`;

/** `POST` launch: one file (and optionally one line), opened in the editor. */
export const OPEN_IN_EDITOR_LAUNCH_ROUTE = `${OPEN_IN_EDITOR_ROUTE_BASE}/launch`;

/**
 * `GET` response of {@link OPEN_IN_EDITOR_STATUS_ROUTE}.
 *
 * `available` is the whole point: the browser probes once per page and only
 * intercepts Ctrl/Cmd+click while it is `true`. That is what lets the click
 * handler decide synchronously — a launch result arrives after the click has
 * already finished dispatching, so a decision made from it could no longer
 * cancel dsh's own preview.
 */
export interface OpenInEditorStatusResp {
  /** Whether `openInVscode` is on AND the editor command resolves on this host. */
  readonly available: boolean;
  /** The resolved absolute executable path, when available (diagnostics). */
  readonly executable?: string;
  /** Why it is unavailable, when it is (diagnostics: `disabled` | `not-installed`). */
  readonly reason?: string;
}

/** `POST` body of {@link OPEN_IN_EDITOR_LAUNCH_ROUTE}. */
export interface OpenInEditorLaunchReq {
  /**
   * The session whose workspace root resolves a relative `path`. Required: the
   * host resolves the root from the session rather than trusting a root the
   * page sent, because a root on the wire is a root any caller could name.
   */
  readonly sessionId: SessionId;
  /** Absolute path the page built from the session's `cwd`, or a workspace-relative one. */
  readonly path: string;
  /** Optional 1-based line, when the surface knows one (the produced-files row does not). */
  readonly line?: number;
}

/** `POST` 200 body: the file was handed to the editor. */
export interface OpenInEditorLaunchedResp {
  readonly ok: true;
  /** Canonical absolute path that was opened. */
  readonly file: string;
}

/** `POST` non-200 body: nothing was opened, and why. */
export interface OpenInEditorFailureResp {
  readonly ok: false;
  /** Machine-readable cause; the browser only needs to know that it was not opened. */
  readonly reason: string;
  /** One line, safe to log in the page console. */
  readonly detail: string;
}

// The composition services these routes touch, and the response plumbing.
//
// The HTTP request/response types are the real ones from `node:http` (this
// package declares `@types/node` as a devDependency), so the handlers cannot
// drift from what `webServer.register` actually calls them with. The session
// store and the web server are real too: `@deepseek-ai/dsh-session` and
// `@deepseek-ai/dsh-host-webserver` are peer dependencies whose `Context`
// augmentations are what put `ctx.sessions` / `ctx.webServer` on the surface this
// compile sees, so a member renamed upstream is a compile error here rather than
// a runtime surprise. The connection service has no such declaration — its
// package is browser-side — and stays a narrow local shape read by name.

/**
 * The composition's connection service, narrowed to its trust fence.
 *
 * `Reflect.get` rather than a typed `ctx.connection`: the connection package is
 * browser-side and contributes no host declaration, and the contract above
 * names this exact read. Its presence is a declared `inject` dependency of this
 * package, so nothing here guards for absence — a composition that cannot fence
 * requests is a boot-time error, not a per-request surprise.
 */
interface ConnectionLike {
  /** `undefined` lets the request through; a status number rejects it. */
  requestRejection(req: IncomingMessage): number | undefined;
}

function connectionOf(ctx: Context): ConnectionLike {
  return Reflect.get(ctx, "connection") as ConnectionLike;
}

/**
 * Every JSON body these two routes write. Naming the union keeps the frozen wire
 * types load-bearing: a renamed payload field is a compile error here rather
 * than a page that silently reads `undefined`.
 */
type OpenInEditorBody = OpenInEditorStatusResp | OpenInEditorLaunchedResp | OpenInEditorFailureResp;

/** JSON response (`no-store`: availability and launch outcomes are live facts). */
function sendJson(res: ServerResponse, status: number, payload: OpenInEditorBody): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

/** 405 with the route's one supported method. */
function sendMethodNotAllowed(res: ServerResponse, allow: string): void {
  res.statusCode = 405;
  res.setHeader("allow", allow);
  res.end();
}

/** Launch bodies are tiny JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Collect a bounded request body as UTF-8 text; `null` past the ceiling, with
 * the stream drained so the socket can be reused. Concatenating before decoding
 * (rather than decoding chunk by chunk) keeps a multi-byte character split
 * across chunks intact.
 * @param req - the request whose body is read.
 * @returns the body text, or `null` when it exceeds {@link MAX_BODY_BYTES}.
 */
async function readBoundedBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

/** A launch request validated at the wire. */
interface LaunchRequestFields {
  readonly sessionId: string;
  readonly path: string;
  readonly line?: number;
}

/**
 * Validate one launch body field by field.
 *
 * A page can send anything, so a malformed body is reported (400) instead of
 * crashing the handler. `line` is stricter here than in the launcher: the
 * launcher ignores a bad line so the file still opens, while the wire refuses
 * one, because a body that names a line it cannot express is a caller bug worth
 * surfacing rather than a convenience worth guessing at.
 * @param text - the request body text.
 * @returns the validated fields, or `null` when the body is not a well-formed request.
 */
function parseLaunchBody(text: string): LaunchRequestFields | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const { sessionId, path, line } = body as Record<string, unknown>;
  if (typeof sessionId !== "string" || sessionId === "") return null;
  if (typeof path !== "string" || path === "") return null;
  if (line === undefined) return { sessionId, path };
  if (typeof line !== "number" || !Number.isInteger(line) || line <= 0) return null;
  return { sessionId, path, line };
}

/**
 * HTTP status for one launcher failure: the mapping the route contract
 * documents. The two "this machine cannot do it now" reasons share `503` so the
 * page falls back to dsh's own preview; the rest say the click was not ours.
 * @param reason - the launcher's failure reason.
 * @returns the status code the failure answers with.
 */
function failureStatusOf(reason: EditorLaunchFailure): number {
  switch (reason) {
    case "disabled":
    case "not-installed":
      return 503;
    case "unresolvable":
      return 404;
    case "outside-workspace":
      return 403;
    case "launch-failed":
      return 502;
  }
}

/**
 * The two fields these routes act on, resolved FRESH from the live settings
 * provider on every request.
 *
 * The namespace is registered once, by `index.ts`, with this row's `config` as
 * the composition `base` layer; registering it again would throw and unregister
 * the namespace the browser half reads, so this layer takes the registered
 * namespace's resolved value (`SettingsProvider.get(ns)`) instead of a scope of
 * its own. That value is schema defaults -> base -> user layer, re-resolved by
 * the provider whenever the settings document changes, which is what makes an
 * edit to `$DSH_HOME/settings.yaml` reach the NEXT request without a dsh
 * restart. The namespace is absent in a composition with no settings provider
 * (and unregistered when a stored document fails the schema), so each field
 * falls back to the row config, which the Loader already resolved through the
 * schema.
 * @param ctx - host context carrying the optional settings service.
 * @param config - this row's config, the settings `base` layer and the fallback.
 * @returns the resolved fields the launcher consumes.
 */
function editorSettingsOf(ctx: Context, config: Config): Pick<Config, "openInVscode" | "editorCommand"> {
  const resolved = ctx.get("settings")?.get(SETTINGS_NAMESPACE) as Partial<Config> | undefined;
  return {
    openInVscode: resolved?.openInVscode ?? config.openInVscode,
    editorCommand: resolved?.editorCommand ?? config.editorCommand,
  };
}

/**
 * Resolve one session's workspace root from the live Session store.
 *
 * Returns `undefined` for a session the store no longer holds — a page can
 * outlive the session it points at — in which case the launch proceeds with
 * existence checking but without the containment check.
 *
 * TODO(deferred): sessions that are NOT live (a page still showing a session
 * after a dsh restart) resolve as `undefined` instead of reading their header
 * through `@deepseek-ai/dsh-session-persistence`. Deferred because it adds a
 * second optional host dependency for a narrowing of an already-narrowed check
 * (the launch still has to name an existing file); the cost of leaving it out is
 * that a non-live session's clicks are checked by existence alone.
 * @param ctx - host context whose `sessions` service owns live sessions.
 * @param sessionId - the session named on the wire.
 * @returns the absolute workspace root, or `undefined` when it cannot be read.
 */
export function workspaceRootOf(ctx: Context, sessionId: SessionId): string | undefined {
  // `ctx.sessions` is a real property of this compile because
  // `@deepseek-ai/dsh-session` is a peer dependency; the store answers
  // `undefined` for a session it no longer holds, which is the "cannot be read"
  // outcome the contract asks for rather than a throw.
  const cwd = ctx.sessions.get(sessionId)?.header.cwd;
  return typeof cwd === "string" && cwd !== "" ? cwd : undefined;
}

/**
 * Register both open-in-editor routes on the composition's web server.
 *
 * Configuration: the two fields these routes act on (`openInVscode`,
 * `editorCommand`) are read FRESH PER REQUEST from the live settings provider —
 * `ctx.get("settings")?.get(SETTINGS_NAMESPACE)` — with the row's `config` as the
 * per-field fallback. That is the host half of the same namespace the browser
 * half binds a scope over; the browser's `settingsScope`/`getSnapshot()` has no
 * host equivalent, and `SettingsProvider.get(ns)` is its documented read
 * ("schema defaults, then `base`, then the user layer", `undefined` while the
 * namespace is unregistered). Reading the composed service per request is what
 * makes `$DSH_HOME/settings.yaml` the LIVE user layer: turning the switch off or
 * pointing `editorCommand` at another editor takes effect on the next request,
 * with no dsh restart. The provider is optional exactly as it is for the browser
 * half — without one (or when a stored section failed to register, which
 * `index.ts` catches and logs) the row config answers.
 *
 * Registering the namespace here would be wrong rather than merely redundant:
 * `index.ts` already registers it, `register` fails loud on a duplicate, and a
 * `SettingsScope` is handed only to the registrant with no public way to recover
 * an existing one — so a second registration would either throw or be thrown at,
 * and the loser would leave the browser half on its defaults.
 *
 * Transport contract, both routes:
 * - `connection.requestRejection(req)` first; a rejection is answered with its
 *   own status and never reaches a filesystem call. The service is reached
 *   through `Reflect.get(ctx, "connection")` and its presence is a declared
 *   `inject` dependency of this package, so a missing member is a composition
 *   error reported at activation, not a per-request surprise.
 * - wrong method -> `405` with `allow`.
 * - the launch route requires `content-type: application/json` and a body of at
 *   most 64 KiB; anything else is `415` / `413`.
 * - the body is validated field by field at the wire (`sessionId`, `path`, and
 *   an optional integer `line`); a malformed body is `400`, not a crash.
 * - every response is `no-store` JSON, because availability and launch outcomes
 *   are live facts about this machine.
 *
 * Status mapping for the launch route (the reason travels in the body as well):
 * - `disabled` / `not-installed` -> `503` (this machine cannot do it now; the
 *   page falls back to dsh's preview).
 * - `unresolvable` / `outside-workspace` -> `404` / `403`.
 * - `launch-failed` -> `502`.
 * - success -> `200` with {@link OpenInEditorLaunchedResp}.
 *
 * The route never throws to the server: a handler rejection would leave the
 * response open, so every failure path answers.
 *
 * @param ctx - host context carrying `webServer` and `connection`.
 * @param config - this row's config, the settings `base` layer.
 * @returns the disposer removing both routes.
 */
export function openInEditorRoutes(ctx: Context, config: Config): () => void {
  // A real `ctx.webServer` property of this compile: the web server's package is
  // a peer dependency. `index.ts` declares `webServer` as a hard `inject`
  // dependency, so by the time this function runs the service is present.
  const webServer = ctx.webServer;

  /** Answer the trust fence's rejection; true when the request was refused. */
  const rejected = (req: IncomingMessage, res: ServerResponse): boolean => {
    const rejection = connectionOf(ctx).requestRejection(req);
    if (rejection === undefined) return false;
    res.statusCode = rejection;
    res.end();
    return true;
  };

  /** `GET` availability probe: reads no session and stats no target file. */
  const statusHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (rejected(req, res)) return;
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return;
    }
    const { openInVscode, editorCommand } = editorSettingsOf(ctx, config);
    // The switch answers first: a machine with the feature off must not pay a
    // PATH probe per page load, and "disabled" is the more useful diagnosis.
    if (!openInVscode) {
      sendJson(res, 200, { available: false, reason: "disabled" });
      return;
    }
    let executable: string | undefined;
    try {
      executable = await resolveEditorCommand(editorCommand);
    } catch {
      // A probe that cannot run is, for this route's purpose, a command that
      // does not resolve; the page never sees a 500 for a diagnostic probe.
      executable = undefined;
    }
    if (executable === undefined) {
      sendJson(res, 200, { available: false, reason: "not-installed" });
      return;
    }
    sendJson(res, 200, { available: true, executable });
  };

  /** `POST` launch: one file, optionally at one line, in the configured editor. */
  const launchHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (rejected(req, res)) return;
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, "POST");
      return;
    }
    if (String(req.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      sendJson(res, 415, {
        ok: false,
        reason: "unsupported-media-type",
        detail: "content-type must be application/json",
      });
      return;
    }
    let text: string | null;
    try {
      text = await readBoundedBody(req);
    } catch {
      sendJson(res, 400, { ok: false, reason: "bad-request", detail: "request body unreadable" });
      return;
    }
    if (text === null) {
      sendJson(res, 413, { ok: false, reason: "payload-too-large", detail: "request body exceeds 64 KiB" });
      return;
    }
    const fields = parseLaunchBody(text);
    if (fields === null) {
      sendJson(res, 400, {
        ok: false,
        reason: "bad-request",
        detail:
          'body must be JSON with a non-empty string "sessionId", a non-empty string "path", and an optional positive integer "line"',
      });
      return;
    }
    // The wire carries a plain string and the store's id is branded, so the
    // validated value is asserted here, at the one place the two meet: an
    // unknown id is answered by `workspaceRootOf` as "cannot be read", which is
    // the outcome the contract asks for, not a lookup on someone else's id.
    const workspaceRoot = workspaceRootOf(ctx, fields.sessionId as SessionId);
    let result: EditorLaunchResult;
    try {
      result = await launchInEditor(workspaceRoot, fields.path, fields.line, editorSettingsOf(ctx, config));
    } catch (error) {
      // The launcher reports its own failures as values; a rejection here is
      // unexpected, so it is folded into the same failure contract rather than
      // left to reject the handler and strand the response.
      result = {
        ok: false,
        reason: "launch-failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (result.ok) {
      sendJson(res, 200, { ok: true, file: result.file });
      return;
    }
    sendJson(res, failureStatusOf(result.reason), {
      ok: false,
      reason: result.reason,
      detail: result.detail,
    });
  };

  // Two labeled effects rather than bare registrations: the labels are what the
  // fiber's effect diagnostics show, and tying each registration to this fiber
  // means an unload removes both routes even if the returned disposer is lost.
  const disposers = [
    ctx.effect(
      () => webServer.register({ kind: "exact", path: OPEN_IN_EDITOR_STATUS_ROUTE, handler: statusHandler }),
      `ui-tweaks: GET ${OPEN_IN_EDITOR_STATUS_ROUTE}`,
    ),
    ctx.effect(
      () => webServer.register({ kind: "exact", path: OPEN_IN_EDITOR_LAUNCH_ROUTE, handler: launchHandler }),
      `ui-tweaks: POST ${OPEN_IN_EDITOR_LAUNCH_ROUTE}`,
    ),
  ];
  // ONE disposer for both routes, as the contract promises; the nested effects
  // above may run it a second time on unload, which route removal tolerates.
  return () => {
    for (const dispose of disposers) dispose();
  };
}
