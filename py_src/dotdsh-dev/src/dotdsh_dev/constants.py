"""Literals shared across the dotdsh_dev modules.

Kept in one place so no module has to import another just for a constant.

- `BIN_NAME`: the dsh executable, used both to look it up on PATH and to
  word user-facing hints.
- `PATCH_FILENAME`: the patch layer copied verbatim into the profile.
- `ROOT_MARKERS`: the files that identify the repository root — all three
  must be present in the same directory (see `find_repo_root`).
"""

from __future__ import annotations

BIN_NAME = "dsh"
PATCH_FILENAME = "cordis.patch.yml"
ROOT_MARKERS = ("package.json", "book.toml", "pyproject.toml")
