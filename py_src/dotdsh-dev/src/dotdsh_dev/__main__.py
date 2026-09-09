"""Dev-loop sync: link-install this repo's plugins into a profile and copy
the repo patch layer to its user layer.

Usage:
    uv run python -m dotdsh_dev                  # target profile: web
    uv run python -m dotdsh_dev --profile <name> # another profile
    uv run python -m dotdsh_dev --no-build       # skip `pnpm -r build`
    uv run python -m dotdsh_dev --dry-run        # print the actions without writing anything
    uv run python -m dotdsh_dev --dsh <path>     # dsh executable (default: PATH lookup, then pnx)

The repo root is the nearest ancestor of this module's source location
containing package.json, book.toml, and pyproject.toml.
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

from dotdsh_dev import (
    BIN_NAME,
    PATCH_FILENAME,
    Context,
    UserError,
    dev_sync,
    find_root,
    list_plugins,
)


def parse_args(ctx: Context) -> None:
    """Fill the CLI-option fields of `ctx` from argv."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--profile", default="web",
        help="target profile under $DSH_HOME/profiles (default: web)",
    )
    parser.add_argument("--no-build", action="store_true", help="skip `pnpm -r build`")
    parser.add_argument("--dry-run", action="store_true", help="print the actions without writing anything")
    parser.add_argument("--dsh", metavar="PATH", help="dsh executable path (default: PATH lookup, then pnx)")
    args = parser.parse_args()
    ctx.profile = args.profile
    ctx.build = not args.no_build
    ctx.dry_run = args.dry_run
    ctx.dsh = args.dsh


def resolve_profile_dir(ctx: Context) -> None:
    """Fill ctx.profile_dir: $DSH_HOME/profiles/<profile> when $DSH_HOME is
    set, else ~/.dsh/profiles/<profile> (dsh's own default)."""
    env = os.environ.get("DSH_HOME")
    base = Path(env).expanduser().resolve() if env else (Path.home() / ".dsh").resolve()
    ctx.profile_dir = base / "profiles" / ctx.profile


def resolve_dsh(ctx: Context) -> None:
    """Fill ctx.dsh_cmd: explicit --dsh path, dsh on PATH, then pnx."""
    if ctx.dsh:
        path = Path(ctx.dsh).expanduser().resolve()
        if not path.is_file():
            raise UserError(f"--dsh path does not exist: {path}")
        ctx.dsh_cmd = [str(path)]
        return
    found = shutil.which(BIN_NAME)
    if found:
        ctx.dsh_cmd = [found]
        return
    if shutil.which("pnx"):
        print("note: dsh not found on PATH, falling back to pnx @deepseek-ai/dsh", file=sys.stderr)
        ctx.dsh_cmd = ["pnx", "@deepseek-ai/dsh"]
        return
    raise UserError(
        "could not find dsh: install @deepseek-ai/dsh (npm i -g @deepseek-ai/dsh)"
        " or pass --dsh <path>"
    )


def main() -> None:
    ctx = Context()
    try:
        # Build the context first (options + resolved paths + command)...
        parse_args(ctx)
        ctx.root = find_root()
        resolve_profile_dir(ctx)
        ctx.patch_src = ctx.root / PATCH_FILENAME
        resolve_dsh(ctx)
        # ...then enumerate plugins and sync. dev_sync verifies the context.
        plugins = list_plugins(ctx.root / "node_src")
        dev_sync(ctx, plugins)
    except UserError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
