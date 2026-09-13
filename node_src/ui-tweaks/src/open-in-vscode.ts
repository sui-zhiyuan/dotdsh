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

import type { Context } from "@deepseek-ai/cordis";
import type { Config } from "./settings.js";

/**
 * A session identity on the wire.
 *
 * Spelled locally rather than imported from `@deepseek-ai/dsh-session`: this
 * package is a `link:`-installed external plugin whose peer set is deliberately
 * small, and the session service's own declaration (`Context.sessions`, which
 * `workspaceRootOf` below reads) reaches the compiler through the composition,
 * not through a dependency here. The type is a string either way, so nothing is
 * lost by not naming the package.
 */
export type SessionId = string;

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
  throw new Error("workspaceRootOf is not implemented");
}

/**
 * Register both open-in-editor routes on the composition's web server.
 *
 * Configuration: the two fields this route acts on (`openInVscode`,
 * `editorCommand`) are read from the `ui-tweaks` settings SCOPE, freshly per
 * request — `ctx.inject(["settings"], …)` + `settingsScope.bind({namespace:
 * SETTINGS_NAMESPACE})` + `scope.getSnapshot().value`, the same read the browser
 * half performs — with `config` (the row's config) as the fallback for the
 * fields the resolved section does not carry and the schema defaults behind
 * that. This is deliberate: `$DSH_HOME/settings.yaml` is the live user layer, so
 * turning the switch off or pointing `editorCommand` at another editor must take
 * effect without a dsh restart, and reading the composed service per request is
 * what makes that true. The scope is optional exactly as it is for the browser
 * half: without a settings provider the row config answers.
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
  throw new Error("openInEditorRoutes is not implemented");
}
