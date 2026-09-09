"""Dev-loop sync for the dotdsh plugin repo.

Library half (no console output): `Context` carries the CLI options and the
resolved runtime state and validates itself with `verify()`; `list_plugins`
enumerates the repo's plugin packages; `plan_link_deps` computes the profile
package.json link: increments; and `dev_sync(ctx, plugins)` performs the
operation (build, link install, patch-layer copy), reporting through
`ctx.log`. The CLI half (argument parsing, path resolution, all printing)
lives in `__main__` — run with `uv run python -m dotdsh_dev`.

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
import shutil
import subprocess
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

BIN_NAME = "dsh"
PATCH_FILENAME = "cordis.patch.yml"
# Root identity requires ALL markers (see find_root); all three are
# committed at the repository root.
ROOT_MARKERS = ("package.json", "book.toml", "pyproject.toml")


class UserError(Exception):
    """Operational error whose message is meant for the user."""


@dataclass
class Plugin:
    """One plugin package under node_src/."""

    id: str  # node_src directory name
    package: str  # npm package name from its package.json
    dir: Path  # absolute package directory


@dataclass
class Context:
    """Everything dev_sync needs: CLI options plus resolved runtime state.

    The option fields are filled by parse_args; the resolved fields are
    filled by main (find_root / resolve_profile_dir / resolve_dsh) before
    dev_sync(ctx, plugins) is called. `verify()` is the single place that
    checks the context is complete and executable.
    """

    profile: str = "web"
    build: bool = True
    dry_run: bool = False
    dsh: str | None = None  # explicit --dsh path (consumed by resolve_dsh)
    log: Callable[[str], None] = print

    # Resolved runtime state (None/empty until main fills them):
    root: Path | None = None
    profile_dir: Path | None = None
    patch_src: Path | None = None
    dsh_cmd: list[str] = field(default_factory=list)

    def verify(self) -> None:
        """Validate this context: every required field resolved, every path
        field existing, and the required commands executable. Raises
        UserError on the first problem."""
        problems: list[str] = []
        if not self.profile:
            problems.append("profile is empty")
        if self.root is None:
            problems.append("root is not resolved")
        elif not self.root.is_dir():
            problems.append(f"root is not a directory: {self.root}")
        if self.profile_dir is None:
            problems.append("profile_dir is not resolved")
        elif not self.profile_dir.is_dir():
            problems.append(
                f"profile_dir does not exist: {self.profile_dir}"
                f" (boot it once: {BIN_NAME} --profile {self.profile})"
            )
        if self.patch_src is None:
            problems.append("patch_src is not resolved")
        elif not self.patch_src.is_file():
            problems.append(f"patch source does not exist: {self.patch_src}")
        if not self.dsh_cmd:
            problems.append("dsh_cmd is not resolved")
        if problems:
            raise UserError("context verification failed: " + "; ".join(problems))

        if shutil.which("pnpm") is None:
            raise UserError(
                "pnpm not found: dsh plugin relies on pnpm to manage profile dependencies,"
                " please install pnpm"
            )
        head = self.dsh_cmd[0]
        if "/" in head or "\\" in head:
            if not Path(head).is_file():
                raise UserError(f"dsh executable does not exist: {head}")
        elif shutil.which(head) is None:
            raise UserError(f"dsh executable not found on PATH: {head}")


def find_root(start: Path | None = None) -> Path:
    """Return the nearest directory at or above `start` containing every
    ROOT_MARKERS file, or raise UserError with a clear message.

    `start` defaults to this module's own location, which resolves into the
    repo source tree under uv's editable install of the workspace members.
    """
    anchor = Path(start).resolve() if start else Path(__file__).resolve().parent
    for directory in (anchor, *anchor.parents):
        if all((directory / marker).is_file() for marker in ROOT_MARKERS):
            return directory
    raise UserError(
        "cannot find repo root: no directory at or above "
        f"{anchor} contains every marker ({', '.join(ROOT_MARKERS)})"
    )


def list_plugins(plugins_dir: Path) -> list[Plugin]:
    """Enumerate plugin packages: every node_src/<id>/ with a package.json."""
    found: list[Plugin] = []
    for entry in sorted(plugins_dir.iterdir()):
        if entry.name == "node_modules" or not (entry / "package.json").is_file():
            continue
        manifest = json.loads((entry / "package.json").read_text(encoding="utf-8"))
        name = manifest.get("name")
        if not isinstance(name, str) or not name:
            raise UserError(f"{entry / 'package.json'}: missing name")
        found.append(Plugin(id=entry.name, package=name, dir=entry.resolve()))
    return found


def plan_link_deps(manifest: dict, plugins: list[Plugin], plugins_dir: Path) -> list[str]:
    """Rebuild the profile manifest's link: dependencies in memory: one entry
    per plugin, dropping stale entries that point into this repo. Returns
    change descriptions (the caller decides when to write the manifest)."""
    changes: list[str] = []
    deps = manifest.setdefault("dependencies", {})
    if not isinstance(deps, dict):
        raise UserError("dependencies must be a mapping")
    wanted = {plugin.package for plugin in plugins}
    for name, spec in list(deps.items()):
        if (
            isinstance(spec, str)
            and spec.startswith("link:")
            and Path(spec.removeprefix("link:")).is_relative_to(plugins_dir)
            and name not in wanted
        ):
            changes.append(f"dependencies.{name}: remove stale {spec}")
            del deps[name]
    for plugin in plugins:
        spec = f"link:{plugin.dir}"
        if deps.get(plugin.package) != spec:
            changes.append(
                f"dependencies.{plugin.package}: {deps.get(plugin.package, '(absent)')!r} -> {spec!r}"
            )
            deps[plugin.package] = spec
    return changes


def run(cmd: list[str], *, env: dict[str, str] | None = None, cwd: str | None = None) -> None:
    subprocess.run(cmd, check=True, env=env, cwd=cwd)


def dev_sync(ctx: Context, plugins: list[Plugin]) -> None:
    """Perform the dev sync described by `ctx` for the given plugins: build
    them, link-install them into the profile, then overwrite the profile's
    user patch layer. Reports every action through `ctx.log` and raises
    UserError on operational failures."""
    ctx.verify()

    root: Path = ctx.root
    profile_dir: Path = ctx.profile_dir
    patch_src: Path = ctx.patch_src

    plugins_dir = root / "node_src"
    manifest_path = profile_dir / "package.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest_changes = plan_link_deps(manifest, plugins, plugins_dir)
    patch_dst = profile_dir / PATCH_FILENAME

    ctx.log(f"Profile: {ctx.profile} ({profile_dir})")
    ctx.log(f"Plugins: {', '.join(p.id for p in plugins) or '(none)'}")

    if ctx.dry_run:
        ctx.log("\n[--dry-run] would:")
        if ctx.build:
            ctx.log(f" - run pnpm -r build in {root}")
        for line in manifest_changes:
            ctx.log(f" - {line}")
        if not manifest_changes:
            ctx.log(" - (no package.json changes)")
        ctx.log(f" - dsh plugin --profile {ctx.profile} install")
        ctx.log(f" - copy {patch_src.relative_to(root)} -> {patch_dst}")
        return

    if ctx.build:
        if not (root / "node_modules" / ".pnpm").is_dir():
            raise UserError(
                "workspace dependencies are not installed: run `pnpm install` at the repo root first"
            )
        cmd = ["pnpm", "-r", "build"]
        ctx.log(f"+ {' '.join(cmd)}")
        run(cmd, cwd=str(root))

    if manifest_changes:
        manifest_path.write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        for line in manifest_changes:
            ctx.log(f"manifest: {line}")
    else:
        ctx.log("manifest: no changes")

    cmd = [*ctx.dsh_cmd, "plugin", "--profile", ctx.profile, "install"]
    ctx.log(f"+ {' '.join(cmd)}")
    # No DSH_HOME override needed: the profile dir was derived from $DSH_HOME,
    # and an unset variable falls back to the same default (~/.dsh) in dsh.
    run(cmd)

    # In-place overwrite (not rename): the profile's HMR watcher holds an
    # exact-path watch on this file, and an atomic rename would lose it.
    shutil.copy2(patch_src, patch_dst)
    ctx.log(f"Copied {patch_src.relative_to(root)} -> {patch_dst} (hot-reloaded by a running profile)")
