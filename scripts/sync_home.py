# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "pyyaml>=6.0",
# ]
# ///
"""Sync dsh_home/ into $DSH_HOME and install the plugin store plus every app from applist.yaml.

Usage:
    uv run scripts/sync_home.py                # sync to $DSH_HOME, or ~/.dsh when unset
    uv run scripts/sync_home.py --dry-run      # print the actions without writing anything
    uv run scripts/sync_home.py --force        # overwrite existing target files/dependencies
    uv run scripts/sync_home.py --dsh <path>   # dsh executable (default: PATH lookup, then npx)

Notes:
    Plugins are written into the profile's package.json as pnpm `link:` dependencies
    (the repo is the source of truth — editing repo sources takes effect immediately),
    then `dsh plugin --profile dotdsh install` finishes the job. `dsh plugin add <path>`
    is deliberately not used: pnpm 12 on Node 26 fails to parse directory arguments as
    local packages (it treats them as registry names and errors out).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
DSH_HOME_SRC = ROOT / "dsh_home"
APPLIST = ROOT / "applist.yaml"
STORE_DIR = ROOT / "node_src" / "dotdsh"
PLUGINS_DIR = ROOT / "node_src"
PROFILE_NAME = "dotdsh"
BIN_NAME = "dsh"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="print the actions without writing")
    parser.add_argument("--force", action="store_true", help="overwrite existing target files/dependencies")
    parser.add_argument("--dsh", metavar="PATH", help="dsh executable path (default: PATH lookup, then npx)")
    return parser.parse_args()


def resolve_home() -> Path:
    env = os.environ.get("DSH_HOME")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".dsh"


def store_package() -> str:
    manifest = json.loads((STORE_DIR / "package.json").read_text(encoding="utf-8"))
    name = manifest.get("name")
    if not isinstance(name, str) or not name:
        raise SystemExit(f"{STORE_DIR / 'package.json'}: missing name")
    return name


def load_enabled_apps() -> list[dict]:
    """Read applist.yaml, returning enabled app entries (in declaration order)."""
    try:
        data = yaml.safe_load(APPLIST.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        raise SystemExit(f"{APPLIST}: YAML parse error: {exc}") from exc
    apps = data.get("apps")
    if not isinstance(apps, list):
        raise SystemExit(f"{APPLIST}: missing apps list")
    seen: set[str] = set()
    enabled: list[dict] = []
    for index, raw in enumerate(apps):
        if not isinstance(raw, dict):
            raise SystemExit(f"{APPLIST}: apps[{index}] must be a mapping")
        app_id = raw.get("id")
        package = raw.get("package")
        if not isinstance(app_id, str) or not app_id.strip():
            raise SystemExit(f"{APPLIST}: apps[{index}] missing a valid id")
        if not isinstance(package, str) or not package.strip():
            raise SystemExit(f"{APPLIST}: app {app_id!r} missing a valid package")
        if app_id in seen:
            raise SystemExit(f"{APPLIST}: duplicate id {app_id!r}")
        seen.add(app_id)
        if raw.get("enabled", True):
            plugin_dir = PLUGINS_DIR / app_id
            if not plugin_dir.is_dir():
                raise SystemExit(
                    f"app {app_id!r} is enabled but {plugin_dir} does not exist in the repo;"
                    " if it comes from the registry, install it in the profile manually instead"
                )
            enabled.append({"id": app_id, "package": package})
    return enabled


def plan_copies(home: Path) -> list[tuple[Path, Path, bool]]:
    """Plan the file-level dsh_home/ → home copies, returning (src, dst, dst exists)."""
    plan: list[tuple[Path, Path, bool]] = []
    for src in sorted(DSH_HOME_SRC.rglob("*")):
        if not src.is_file():
            continue
        dst = home / src.relative_to(DSH_HOME_SRC)
        plan.append((src, dst, dst.exists()))
    return plan


def plan_manifest_changes(profile_dir: Path, apps: list[dict], force: bool) -> list[str]:
    """Compute the profile package.json dependency/bundle increments, returning change descriptions."""
    changes: list[str] = []
    manifest_path = profile_dir / "package.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    deps = manifest.setdefault("dependencies", {})
    if not isinstance(deps, dict):
        raise SystemExit(f"{manifest_path}: dependencies must be a mapping")

    def add_dep(package: str, spec: str) -> None:
        if package in deps:
            if force and deps[package] != spec:
                changes.append(f"dependencies.{package}: {deps[package]} -> {spec}")
                deps[package] = spec
            return  # already present — keep it (may be a registry version installed by hand)
        changes.append(f"dependencies.{package} = {spec}")
        deps[package] = spec

    add_dep(store_package(), f"link:{STORE_DIR}")
    for app in apps:
        add_dep(app["package"], f"link:{PLUGINS_DIR / app['id']}")

    bundles = manifest.setdefault("dsh", {}).setdefault("profile", {}).setdefault("bundles", [])
    if not isinstance(bundles, list):
        raise SystemExit(f"{manifest_path}: dsh.profile.bundles must be a list")
    store = store_package()
    if store not in bundles:
        changes.append(f"dsh.profile.bundles += {store}")
        bundles.append(store)

    if changes:
        manifest_path.write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
    return changes


def resolve_dsh(explicit: str | None) -> list[str]:
    if explicit:
        path = Path(explicit).expanduser().resolve()
        if not path.is_file():
            raise SystemExit(f"--dsh path does not exist: {path}")
        return [str(path)]
    found = shutil.which(BIN_NAME)
    if found:
        return [found]
    if shutil.which("npx"):
        print("note: dsh not found on PATH, falling back to npx -y @deepseek-ai/dsh", file=sys.stderr)
        return ["npx", "-y", "@deepseek-ai/dsh"]
    raise SystemExit(
        "could not find dsh: install @deepseek-ai/dsh (npm i -g @deepseek-ai/dsh)"
        " or pass --dsh <path>"
    )


def run(cmd: list[str], *, env: dict[str, str] | None = None) -> None:
    print("+", " ".join(cmd))
    subprocess.run(cmd, check=True, env=env)


def main() -> None:
    args = parse_args()
    if shutil.which("pnpm") is None:
        raise SystemExit("pnpm not found: dsh plugin relies on pnpm to manage profile dependencies, please install pnpm")

    home = resolve_home().resolve()
    profile_dir = home / "profiles" / PROFILE_NAME
    apps = load_enabled_apps()
    copies = plan_copies(home)
    dsh_cmd = resolve_dsh(args.dsh)

    print(f"Sync target DSH_HOME: {home}")
    print(f"Enabled plugins: {', '.join(a['id'] for a in apps) or '(none)'}")

    if args.dry_run:
        print("\n[--dry-run] would:")
        for src, dst, exists in copies:
            print(f" - copy {src.relative_to(ROOT)} -> {dst}" + (" (exists, skip)" if exists else ""))
        print(" - edit profile package.json: write link: dependencies and dsh.profile.bundles")
        print(f" - dsh plugin --profile {PROFILE_NAME} install")
        return

    # 1. Copy the controlled files (only when absent; --force overwrites)
    for src, dst, exists in copies:
        if exists and not args.force:
            print(f"Skip (exists): {dst}")
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        print(f"Copy: {src.relative_to(ROOT)} -> {dst}" + (" (--force overwrite)" if exists else ""))

    # 2. Write link: dependencies (store package + each plugin) and append the store to dsh.profile.bundles
    changes = plan_manifest_changes(profile_dir, apps, args.force)
    if changes:
        for line in changes:
            print(f"manifest: {line}")
    else:
        print("manifest: no changes")

    # 3. Finish the install (pnpm install + the harness's bundle reconciliation)
    env = dict(os.environ)
    env["DSH_HOME"] = str(home)
    run([*dsh_cmd, "plugin", "--profile", PROFILE_NAME, "install"], env=env)

    print("\nDone. Boot the dotdsh profile:")
    print(f"  DSH_HOME={home} {BIN_NAME} --profile {PROFILE_NAME}")


if __name__ == "__main__":
    main()
