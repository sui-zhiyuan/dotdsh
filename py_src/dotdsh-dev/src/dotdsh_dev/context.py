"""Context: the resolved dev-sync state, its validation, and the default logger.

`repo_*`/`dsh_*` state ownership and `_dir`/`_file` state path kind (see
AGENTS.md); `verify()` is the only completeness check.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from .constants import BIN_NAME

# Log levels passed to `Context.log`:
#   info  — a step that happens (or has happened)
#   plan  — the same step under --dry-run: announced, not executed
#   error — a step that failed
LOG_LEVELS = ("info", "plan", "error")


class UserError(Exception):
    """Operational error whose message is meant for the user."""


def log_line(module: str, level: str, message: str) -> None:
    """Default `Context.log`: `<module>: <message>`, with `plan` marked
    `[dry-run]` and `error` prefixed, each line flushed."""
    if level not in LOG_LEVELS:
        raise ValueError(f"unknown log level {level!r}: expected one of {', '.join(LOG_LEVELS)}")
    if level == "plan":
        line = f"[dry-run] {module}: {message}"
    elif level == "error":
        line = f"error: {module}: {message}"
    else:
        line = f"{module}: {message}"
    print(line, flush=True)


@dataclass
class Context:
    """CLI options (filled by parse_args) plus resolved runtime state (filled
    by main before `verify()` and `dev_sync()` run)."""

    dsh_profile: str = "web"
    build: bool = True
    dry_run: bool = False
    traceback: bool = False  # --traceback: re-raise instead of one error line
    dsh_bin_file: Path | None = None  # explicit --dsh path (consumed by resolve_dsh)
    log: Callable[[str, str, str], None] = log_line

    # Resolved runtime state (None/empty until main fills them):
    repo_root_dir: Path | None = None
    dsh_profile_dir: Path | None = None  # $DSH_HOME/profiles/<profile>
    repo_patch_file: Path | None = None  # <repo_root>/cordis.patch.yml
    dsh_cmd: list[str] = field(default_factory=list)

    def verify(self) -> None:
        """Check every field is resolved and every path exists, reporting all
        problems at once. Command availability is checked when a command
        actually runs, which keeps --dry-run free of tool requirements."""
        problems: list[str] = []
        if not self.dsh_profile:
            problems.append("dsh_profile is empty")
        if self.repo_root_dir is None:
            problems.append("repo_root_dir is not resolved")
        elif not self.repo_root_dir.is_dir():
            problems.append(f"repo_root_dir is not a directory: {self.repo_root_dir}")
        if self.dsh_profile_dir is None:
            problems.append("dsh_profile_dir is not resolved")
        elif not self.dsh_profile_dir.is_dir():
            problems.append(
                f"dsh_profile_dir does not exist: {self.dsh_profile_dir}"
                f" (boot it once: {BIN_NAME} --profile {self.dsh_profile})"
            )
        if self.repo_patch_file is None:
            problems.append("repo_patch_file is not resolved")
        elif not self.repo_patch_file.is_file():
            problems.append(f"repo patch file does not exist: {self.repo_patch_file}")
        if not self.dsh_cmd:
            problems.append("dsh_cmd is not resolved")
        if problems:
            raise UserError("context verification failed: " + "; ".join(problems))
