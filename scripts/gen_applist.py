# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "pyyaml>=6.0",
# ]
# ///
"""Generate node_src/dotdsh/cordis.patch.yml (the plugin store's patch layer) from applist.yaml.

Usage:
    uv run scripts/gen_applist.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
APPLIST = ROOT / "applist.yaml"
STORE_DIR = ROOT / "node_src" / "dotdsh"
STORE_PATCH = STORE_DIR / "cordis.patch.yml"
PLUGINS_DIR = ROOT / "node_src"

HEADER = """\
# GENERATED FILE — produced by scripts/gen_applist.py from applist.yaml. Do not edit by hand.
# After changing the app list, regenerate: uv run scripts/gen_applist.py
"""


def load_apps() -> list[dict]:
    """Read and validate applist.yaml, returning enabled app entries (in declaration order)."""
    try:
        data = yaml.safe_load(APPLIST.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise SystemExit(f"{APPLIST}: YAML parse error: {exc}") from exc
    if not isinstance(data, dict):
        raise SystemExit(f"{APPLIST}: top level must be a mapping (version/apps)")
    apps = data.get("apps")
    if not isinstance(apps, list):
        raise SystemExit(f"{APPLIST}: missing apps list")

    seen: dict[str, int] = {}
    entries: list[dict] = []
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
            raise SystemExit(
                f"{APPLIST}: duplicate id {app_id!r} (apps[{seen[app_id]}] and apps[{index}])"
            )
        seen[app_id] = index
        enabled = bool(raw.get("enabled", True))
        if enabled and not (PLUGINS_DIR / app_id).is_dir():
            print(
                f"warning: app {app_id!r} is enabled but {PLUGINS_DIR / app_id} does not exist"
                " (the plugin may come from the registry; skipping the in-repo path check)",
                file=sys.stderr,
            )
        entries.append(
            {
                "id": app_id,
                "package": package,
                "enabled": enabled,
                "config": raw.get("config") if isinstance(raw.get("config"), dict) else {},
            }
        )
    return entries


def main() -> None:
    enabled = [app for app in load_apps() if app["enabled"]]
    doc = [
        {
            "insert": [
                {"id": app["id"], "name": app["package"], "config": app["config"]}
                for app in enabled
            ]
        }
    ]
    body = yaml.safe_dump(doc, sort_keys=False, allow_unicode=True)
    STORE_PATCH.write_text(HEADER + body, encoding="utf-8")
    names = ", ".join(app["id"] for app in enabled) or "(none)"
    print(f"Generated {STORE_PATCH.relative_to(ROOT)}: {len(enabled)} enabled plugin(s) [{names}]")


if __name__ == "__main__":
    main()
