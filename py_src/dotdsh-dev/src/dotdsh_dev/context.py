"""Context: the resolved dev-sync state, its validation, and the logger.

This module is (apart from `constants`) free of package-internal imports —
it defines what the rest of the package consumes: `UserError` (raised by
verify and the sync logic), `log_line` (the global default logger behind
`Context.log`), and the `Context` dataclass whose `verify()` is the only
place that checks the context is complete.

Naming convention: the prefix states ownership — `repo_*` for this
repository, `dsh_*` for `$DSH_HOME` configuration — and path names end in
`_dir` (directory) or `_file` (file). See AGENTS.md.
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
    """Global default logger, used as `Context.log`.

    Takes the three parts separately — the module (which step: "sync",
    "build", "manifest", "install", "patch", "dsh"), the level (see
    LOG_LEVELS) and the message — so call sites cannot drift into ad-hoc
    prefixes. Prints with flush, so no line is overtaken by a child process
    writing to the same inherited stream.
    """
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
    """Everything dev_sync needs: CLI options plus resolved runtime state.

    The option fields are filled by parse_args; the resolved fields are
    filled by main (find_repo_root / resolve_dsh_profile_dir / resolve_dsh)
    before `verify()` and `dev_sync()` run. `verify()` checks that the
    context is complete; the effects wrappers check the command they are
    about to execute.
    """

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
        """Validate that every required field is resolved and every path
        field exists, reporting all problems at once as a UserError.

        Command availability is deliberately not checked here: the effects
        wrappers check the command they are about to run, which keeps
        --dry-run free of tool requirements."""
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
