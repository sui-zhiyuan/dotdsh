"""dev_apply: build this repository's plugin packages, link-install them into a dsh
profile, and remind you to restart dsh.

Usage: uv run python -m dev_apply [--profile web] [--no-build] [--dsh PATH]
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


def run(cmd: list[str], cwd_dir: Path | None = None) -> None:
    """Run `cmd`, turning a non-zero exit into a one-line error."""
    try:
        subprocess.run(cmd, check=True, cwd=cwd_dir)
    except subprocess.CalledProcessError as error:
        raise SystemExit(f"error: {cmd[0]} exited {error.returncode}") from None


def repo_root_dir() -> Path:
    """The nearest directory at or above this file holding all three root markers."""
    markers = ("package.json", "book.toml", "pyproject.toml")
    for directory in Path(__file__).resolve().parents:
        if all((directory / marker).is_file() for marker in markers):
            return directory
    raise SystemExit(f"error: no repository root above {Path(__file__).resolve()}")


def main() -> None:
    parser = argparse.ArgumentParser(prog="dev_apply", description=__doc__)
    parser.add_argument("--profile", default="web", help="target profile (default: web)")
    parser.add_argument("--no-build", action="store_true", help="skip `pnpm -r build`")
    parser.add_argument("--dsh", metavar="PATH", help="dsh executable (default: PATH lookup)")
    args = parser.parse_args()

    repo_dir = repo_root_dir()
    dsh = args.dsh or shutil.which("dsh") or sys.exit("error: no dsh on PATH (pass --dsh PATH)")
    if not args.no_build:
        print(f"dev_apply: build: pnpm -r build (in {repo_dir})", flush=True)
        run(["pnpm", "-r", "build"], cwd_dir=repo_dir)

    node_src_dir = repo_dir / "node_src"
    packages = sorted(p for p in node_src_dir.iterdir() if (p / "package.json").is_file())
    specs = [f"link:{package}" for package in packages]
    print(
        f"dev_apply: link {len(specs)} package(s) into profile {args.profile}:"
        f" {', '.join(p.name for p in packages) or '(none)'}",
        flush=True,
    )
    if specs:
        run([dsh, "plugin", "--profile", args.profile, "add", *specs])
    print(f"dev_apply: done - restart dsh to load the plugin code: dsh --profile {args.profile}")


if __name__ == "__main__":
    main()
