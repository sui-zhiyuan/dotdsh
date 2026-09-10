"""Dev-loop sync for the dotdsh plugin repo.

Package layout:
    constants.py — BIN_NAME, PATCH_FILENAME, ROOT_MARKERS
    context.py   — UserError, log_line, Context (+ its verify())
    effects.py   — run_cmd/copy_file/write_file, the only readers of dry_run
    __init__.py  — Plugin/list_plugins/plan_link_deps/dev_sync and the
                   public re-exports below
    __main__.py  — CLI (argument parsing, path resolution, error reporting)

The library half writes no console output of its own: every step is
reported through `ctx.log` (defaults to `log_line`). Run with
`uv run python -m dotdsh_dev`.

Failure model: every step is idempotent and nothing is rolled back — when a
step fails, fix its cause and re-run the whole sync; a re-run converges.
The patch layer is copied last, so a failed build or install leaves the
running profile's patch layer as it was.

Naming convention (see AGENTS.md): the prefix states ownership — `repo_*`
for this repository, `dsh_*` for `$DSH_HOME` configuration — and path names
end in `_dir` or `_file`:
    repo_root_dir, repo_node_src_dir, repo_patch_file, repo_plugins
    dsh_profile, dsh_profile_dir, dsh_manifest_file, dsh_manifest,
    dsh_patch_file, dsh_bin_file, dsh_cmd

Notes:
    Plugins are written into the profile's package.json as pnpm `link:`
    dependencies (the repo is the source of truth — editing repo sources
    takes effect after `pnpm -r build`), then
    `dsh plugin --profile <name> install` materializes them and reconciles
    `dsh.profile.bundles`. The repo root's cordis.patch.yml is copied
    verbatim over the profile's user patch layer, which the profile
    hot-reloads (patchReload: live) and re-applies on the next boot.
    `dsh plugin add <path>` is deliberately not used: pnpm 12 on Node 26
    fails to parse directory arguments as local packages.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .constants import BIN_NAME, PATCH_FILENAME, ROOT_MARKERS
from .context import Context, UserError
from .effects import copy_file, run_cmd, write_file

__all__ = [
    "BIN_NAME",
    "PATCH_FILENAME",
    "ROOT_MARKERS",
    "Context",
    "LinkDepChange",
    "LinkDepPlan",
    "Plugin",
    "UserError",
    "copy_file",
    "dev_sync",
    "find_repo_root",
    "list_plugins",
    "plan_link_deps",
    "run_cmd",
    "write_file",
]


@dataclass
class Plugin:
    """One plugin package under node_src/."""

    package_name: str  # npm package name from its package.json
    repo_dir: Path  # absolute package directory in this repository

    @property
    def id(self) -> str:
        """The plugin's id: its directory name under node_src/."""
        return self.repo_dir.name


@dataclass(frozen=True)
class LinkDepChange:
    """One change to the dsh manifest's link: dependencies."""

    package_name: str
    old: Any  # the previous spec; None when the entry was absent
    new: str | None  # the new spec; None when the entry is removed

    def describe(self) -> str:
        """Render this change as a single log line."""
        old = "(absent)" if self.old is None else str(self.old)
        if self.new is None:
            return f"{self.package_name}: remove {old} (points into this repo, no such plugin)"
        return f"{self.package_name}: {old} -> {self.new}"


@dataclass(frozen=True)
class LinkDepPlan:
    """The planned `dependencies` mapping plus the changes producing it."""

    dependencies: dict[str, Any]
    changes: list[LinkDepChange]


def find_repo_root(repo_start_dir: Path | None = None) -> Path:
    """Return the nearest directory at or above `repo_start_dir` containing
    every ROOT_MARKERS file, or raise UserError with a clear message.

    `repo_start_dir` defaults to this module's own location, which resolves
    into the repo source tree under uv's editable install of the workspace
    members.
    """
    anchor_dir = (
        Path(repo_start_dir).resolve() if repo_start_dir else Path(__file__).resolve().parent
    )
    for directory in (anchor_dir, *anchor_dir.parents):
        if all((directory / marker).is_file() for marker in ROOT_MARKERS):
            return directory
    raise UserError(
        "cannot find repo root: no directory at or above "
        f"{anchor_dir} contains every marker ({', '.join(ROOT_MARKERS)})"
    )


def _load_json_file(json_file: Path) -> dict[str, Any]:
    """Read `json_file` as a JSON object, turning read and parse failures
    into UserError (so the CLI reports them as one line, not a traceback)."""
    try:
        data = json.loads(json_file.read_text(encoding="utf-8"))
    except OSError as err:
        raise UserError(f"cannot read {json_file}: {err}") from err
    except json.JSONDecodeError as err:
        raise UserError(f"{json_file} is not valid JSON: {err}") from err
    if not isinstance(data, dict):
        raise UserError(f"{json_file}: expected a JSON object at the top level")
    return data


def list_plugins(repo_node_src_dir: Path) -> list[Plugin]:
    """Enumerate plugin packages: every node_src/<id>/ with a package.json."""
    if not repo_node_src_dir.is_dir():
        raise UserError(f"no node_src directory: {repo_node_src_dir}")
    found: list[Plugin] = []
    for entry_dir in sorted(repo_node_src_dir.iterdir()):
        manifest_file = entry_dir / "package.json"
        if entry_dir.name == "node_modules" or not manifest_file.is_file():
            continue
        package_name = _load_json_file(manifest_file).get("name")
        if not isinstance(package_name, str) or not package_name:
            raise UserError(f"{manifest_file}: missing name")
        found.append(Plugin(package_name=package_name, repo_dir=entry_dir.resolve()))
    return found


def plan_link_deps(
    dsh_manifest: Mapping[str, Any], repo_plugins: list[Plugin], repo_node_src_dir: Path
) -> LinkDepPlan:
    """Plan the dsh manifest's link: dependencies: one entry per plugin, plus
    removal of entries that point into this repo but match no plugin.

    Pure: `dsh_manifest` is not modified. The caller decides whether and
    when to write, which keeps --dry-run side-effect free."""
    current = dsh_manifest.get("dependencies", {})
    if not isinstance(current, dict):
        raise UserError("the dsh manifest's dependencies must be a mapping")
    deps: dict[str, Any] = dict(current)
    changes: list[LinkDepChange] = []
    wanted = {plugin.package_name for plugin in repo_plugins}
    for name, spec in list(deps.items()):
        if (
            isinstance(spec, str)
            and spec.startswith("link:")
            and Path(spec.removeprefix("link:")).is_relative_to(repo_node_src_dir)
            and name not in wanted
        ):
            changes.append(LinkDepChange(package_name=name, old=spec, new=None))
            del deps[name]
    for plugin in repo_plugins:
        spec = f"link:{plugin.repo_dir}"
        if deps.get(plugin.package_name) != spec:
            changes.append(
                LinkDepChange(
                    package_name=plugin.package_name,
                    old=deps.get(plugin.package_name),
                    new=spec,
                )
            )
            deps[plugin.package_name] = spec
    return LinkDepPlan(dependencies=deps, changes=changes)


def _resolved_paths(ctx: Context) -> tuple[Path, Path, Path]:
    """Return (repo_root_dir, dsh_profile_dir, repo_patch_file), raising
    UserError while the context is still unresolved — `verify()` is what
    reports that to the user, this only narrows the types."""
    if ctx.repo_root_dir is None or ctx.dsh_profile_dir is None or ctx.repo_patch_file is None:
        raise UserError("context is not resolved: run verify() first")
    return ctx.repo_root_dir, ctx.dsh_profile_dir, ctx.repo_patch_file


def dev_sync(ctx: Context, repo_plugins: list[Plugin]) -> None:
    """Perform the dev sync described by `ctx` for the given plugins: build
    them, link-install them into the profile, then overwrite the profile's
    user patch layer. Every step is reported through `ctx.log`; the effects
    wrappers are the only places that read `ctx.dry_run`.

    Failure model: each step is idempotent and nothing is rolled back, so a
    failed run is fixed at its cause and re-run as a whole."""
    ctx.verify()

    repo_root_dir, dsh_profile_dir, repo_patch_file = _resolved_paths(ctx)
    repo_node_src_dir = repo_root_dir / "node_src"
    dsh_manifest_file = dsh_profile_dir / "package.json"
    dsh_patch_file = dsh_profile_dir / PATCH_FILENAME

    dsh_manifest = _load_json_file(dsh_manifest_file)
    plan = plan_link_deps(dsh_manifest, repo_plugins, repo_node_src_dir)

    ctx.log("sync", "info", f"profile: {ctx.dsh_profile} ({dsh_profile_dir})")
    ctx.log("sync", "info", f"plugins: {', '.join(p.id for p in repo_plugins) or '(none)'}")

    if ctx.build:
        if (
            not (repo_root_dir / "node_modules").is_dir()
            or not (repo_root_dir / "pnpm-lock.yaml").is_file()
        ):
            raise UserError(
                "workspace dependencies are not installed:"
                " run `pnpm install` at the repo root first"
            )
        run_cmd(["pnpm", "-r", "build"], ctx, module="build", cwd_dir=str(repo_root_dir))

    if plan.changes:
        for change in plan.changes:
            ctx.log("manifest", "info", change.describe())
        dsh_manifest["dependencies"] = plan.dependencies
        write_file(
            dsh_manifest_file,
            json.dumps(dsh_manifest, indent=2, ensure_ascii=False) + "\n",
            ctx,
            module="manifest",
        )
    else:
        ctx.log("manifest", "info", "no changes")

    # No DSH_HOME override needed: the profile dir was derived from $DSH_HOME,
    # and an unset variable falls back to the same default (~/.dsh) in dsh.
    run_cmd(
        [*ctx.dsh_cmd, "plugin", "--profile", ctx.dsh_profile, "install"],
        ctx,
        module="install",
    )

    # Last on purpose: a failed build or install leaves the profile's patch
    # layer as it was, so the running profile keeps its previous layer until a
    # run gets all the way through.
    copy_file(repo_patch_file, dsh_patch_file, ctx, module="patch")
