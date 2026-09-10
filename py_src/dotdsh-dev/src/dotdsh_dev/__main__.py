"""Dev-loop sync: link-install this repo's plugins into a profile and copy
the repo patch layer to its user layer.

Usage:
    uv run python -m dotdsh_dev                  # target profile: web
    uv run python -m dotdsh_dev --profile <name> # another profile
    uv run python -m dotdsh_dev --no-build       # skip `pnpm -r build`
    uv run python -m dotdsh_dev --dry-run        # print the steps without doing them
    uv run python -m dotdsh_dev --dsh <path>     # dsh executable (default: PATH lookup, then pnx)
    uv run python -m dotdsh_dev --traceback      # full traceback instead of one error line
"""

from __future__ import annotations

import argparse
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

from dotdsh_dev import (
    BIN_NAME,
    PATCH_FILENAME,
    Context,
    UserError,
    dev_sync,
    find_repo_root,
    list_plugins,
)


def parse_args(ctx: Context) -> None:
    """Fill the CLI-option fields of `ctx` from argv."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--profile",
        default="web",
        help="target profile under $DSH_HOME/profiles (default: web)",
    )
    parser.add_argument("--no-build", action="store_true", help="skip `pnpm -r build`")
    parser.add_argument("--dry-run", action="store_true", help="print the steps without doing them")
    parser.add_argument(
        "--dsh", metavar="PATH", help="dsh executable path (default: PATH lookup, then pnx)"
    )
    parser.add_argument(
        "--traceback", action="store_true", help="print the full traceback on failure"
    )
    args = parser.parse_args()
    ctx.dsh_profile = args.profile
    ctx.build = not args.no_build
    ctx.dry_run = args.dry_run
    ctx.traceback = args.traceback
    ctx.dsh_bin_file = Path(args.dsh) if args.dsh else None


def resolve_dsh_profile_dir(ctx: Context) -> None:
    """Fill ctx.dsh_profile_dir: $DSH_HOME/profiles/<profile>, else dsh's own
    default ~/.dsh/profiles/<profile>."""
    dsh_home = os.environ.get("DSH_HOME")
    dsh_home_dir = (
        Path(dsh_home).expanduser().resolve() if dsh_home else (Path.home() / ".dsh").resolve()
    )
    ctx.dsh_profile_dir = dsh_home_dir / "profiles" / ctx.dsh_profile


def resolve_dsh(ctx: Context) -> None:
    """Fill ctx.dsh_cmd: --dsh path, else dsh on PATH, else pnx, else the bare
    name; usability is checked when the command runs, not here."""
    if ctx.dsh_bin_file is not None:
        ctx.dsh_cmd = [str(ctx.dsh_bin_file.expanduser().resolve())]
        return
    found = shutil.which(BIN_NAME)
    if found:
        ctx.dsh_cmd = [found]
        return
    if shutil.which("pnx"):
        ctx.log("dsh", "info", f"no {BIN_NAME} on PATH: falling back to `pnx @deepseek-ai/dsh`")
        ctx.dsh_cmd = ["pnx", "@deepseek-ai/dsh"]
        return
    ctx.log(
        "dsh",
        "info",
        f"no {BIN_NAME} on PATH: install @deepseek-ai/dsh, or pass --dsh <path>",
    )
    ctx.dsh_cmd = [BIN_NAME]


def _describe(error: BaseException) -> str:
    """One-line description of `error`, for the CLI's error message."""
    if isinstance(error, subprocess.CalledProcessError):
        return (
            f"command failed (exit {error.returncode}): "
            f"{shlex.join(str(part) for part in error.cmd)}"
        )
    return str(error)


def _fail(ctx: Context, error: BaseException) -> None:
    """Report `error` as one line and exit 1, or re-raise under --traceback."""
    if ctx.traceback:
        raise error
    print(f"error: {_describe(error)}", file=sys.stderr)
    raise SystemExit(1) from error


def main() -> None:
    ctx = Context()
    try:
        # Build the context first (options + resolved paths + command)...
        parse_args(ctx)
        ctx.repo_root_dir = find_repo_root()
        resolve_dsh_profile_dir(ctx)
        ctx.repo_patch_file = ctx.repo_root_dir / PATCH_FILENAME
        resolve_dsh(ctx)
        # ...verify it before doing any work, then enumerate and sync.
        ctx.verify()
        repo_plugins = list_plugins(ctx.repo_root_dir / "node_src")
        dev_sync(ctx, repo_plugins)
    except (UserError, subprocess.CalledProcessError, OSError) as error:
        _fail(ctx, error)


if __name__ == "__main__":
    main()
