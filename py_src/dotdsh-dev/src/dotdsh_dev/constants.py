"""Literals shared across the dotdsh_dev modules: the dsh executable name, the
profile patch-layer filename, and the files that identify the repository root
(all ROOT_MARKERS must sit in the same directory).
"""

from __future__ import annotations

BIN_NAME = "dsh"
PATCH_FILENAME = "cordis.patch.yml"
ROOT_MARKERS = ("package.json", "book.toml", "pyproject.toml")
