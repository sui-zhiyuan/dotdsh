"""Executable effects, gated on Context.dry_run.

These three functions are the only readers of `Context.dry_run`: under
--dry-run they log the effect and return; otherwise they check, log, perform,
and on failure log the error and re-raise.
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
    """Run `cmd` in `cwd_dir` when given, checking first that it is
    executable — that check lives here so --dry-run needs no tools."""
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
    """Copy `src_file` over `dst_file` in place: a rename would drop the
    profile's exact-path HMR watch on the destination."""
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
    """Write `text` to `target_file` in place: a failed write is fixed by
    re-running, not by rollback."""
    if ctx.dry_run:
        ctx.log(module, "plan", f"would write: {target_file}")
        return
    try:
        target_file.write_text(text, encoding="utf-8")
    except OSError as err:
        ctx.log(module, "error", f"write failed: {err}")
        raise
    ctx.log(module, "info", f"wrote: {target_file}")
