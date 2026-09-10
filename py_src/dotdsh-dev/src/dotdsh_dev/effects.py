"""Executable effects, gated on Context.dry_run.

`run_cmd`, `copy_file` and `write_file` are the only places in the package
that read `Context.dry_run`: under --dry-run they only log the effect,
otherwise they check their precondition, log, perform the effect, and on
failure log the error and re-raise. Nothing else may branch on dry_run.

Each wrapper is told which `module` it acts for ("build", "manifest",
"install", "patch"); that becomes the module part of every log line it
emits.
"""

from __future__ import annotations

import shlex
import shutil
import subprocess
from pathlib import Path

from .context import Context, UserError


def run_cmd(
    cmd: list[str],
    ctx: Context,
    *,
    module: str,
    cwd_dir: str | None = None,
) -> None:
    """Run `cmd` in `cwd_dir` (when given) under `ctx`'s policy: under
    --dry-run only log it; otherwise check that the command is executable,
    log it, run it, and on failure log the exit code and re-raise."""
    if ctx.dry_run:
        ctx.log(module, "plan", f"would run: {shlex.join(cmd)}")
        return
    if shutil.which(cmd[0]) is None:
        raise UserError(f"cannot run {cmd[0]!r}: not on PATH and not an executable file")
    ctx.log(module, "info", f"run: {shlex.join(cmd)}")
    try:
        subprocess.run(cmd, check=True, cwd=cwd_dir)
    except subprocess.CalledProcessError as err:
        # The child's own output already reached the terminal; log the exit
        # code here so the failure is still identifiable in captured output.
        ctx.log(module, "error", f"exit {err.returncode}: {shlex.join(cmd)}")
        raise


def copy_file(src_file: Path, dst_file: Path, ctx: Context, *, module: str) -> None:
    """Copy `src_file` over `dst_file` under `ctx`'s policy: under --dry-run
    only log it; otherwise log, copy and, on failure, log the error and
    re-raise. The copy is an in-place overwrite, not a rename: the profile's
    HMR watcher holds an exact-path watch on the target, and an atomic
    rename would lose it."""
    if ctx.dry_run:
        ctx.log(module, "plan", f"would copy: {src_file} -> {dst_file}")
        return
    try:
        shutil.copy2(src_file, dst_file)
    except OSError as err:
        ctx.log(module, "error", f"copy failed: {err}")
        raise
    ctx.log(module, "info", f"copied: {src_file} -> {dst_file} (hot-reloaded by a running profile)")


def write_file(target_file: Path, text: str, ctx: Context, *, module: str) -> None:
    """Write `text` to `target_file` under `ctx`'s policy: under --dry-run
    only log it; otherwise log, write and, on failure, log the error and
    re-raise."""
    if ctx.dry_run:
        ctx.log(module, "plan", f"would write: {target_file}")
        return
    try:
        target_file.write_text(text, encoding="utf-8")
    except OSError as err:
        ctx.log(module, "error", f"write failed: {err}")
        raise
    ctx.log(module, "info", f"wrote: {target_file}")
