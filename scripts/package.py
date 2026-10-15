#!/usr/bin/env python3
"""Build a source-only Recall ZIP with Python's standard library."""
import os
from pathlib import Path
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = ROOT / "dist"
OUTPUT_PATH = OUTPUT_DIR / "recall-mvp.zip"
EXCLUDED_DIRS = {
    ".git", ".venv", "venv", "env", "node_modules", "data", "dist",
    "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
    ".secrets", "secrets", ".aws", ".ssh", ".gnupg", ".idea", ".vscode",
}
SECRET_NAMES = {"credentials", "credentials.json", "tokens.json", "token.json", ".npmrc", ".netrc", ".pypirc"}
SECRET_SUFFIXES = {".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"}
DATABASE_SUFFIXES = {".sqlite", ".sqlite3", ".db", ".db3"}


def excluded_file(name):
    lower = name.lower()
    if lower == ".env.example":
        return False
    if lower.startswith(".env") or lower.endswith(".env"):
        return True
    if lower in SECRET_NAMES or any(word in lower for word in ("secret", "credential", "token")):
        return True
    if lower.endswith((".pyc", ".pyo", ".log", ".bak", ".tmp", ".zip", ".tar", ".gz", ".tgz", ".7z", "~")) or lower == ".ds_store":
        return True
    if Path(lower).suffix in SECRET_SUFFIXES | DATABASE_SUFFIXES:
        return True
    return any(lower.endswith(suffix + ending) for suffix in DATABASE_SUFFIXES for ending in ("-shm", "-wal", "-journal"))


def main():
    if OUTPUT_DIR.is_symlink():
        raise SystemExit("Refusing a symlinked dist directory.")
    OUTPUT_DIR.mkdir(exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=".recall-", suffix=".zip", dir=OUTPUT_DIR)
    os.close(fd)
    temporary_path = Path(temporary_name)
    count = 0
    try:
        with zipfile.ZipFile(temporary_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for directory, directories, files in os.walk(ROOT, followlinks=False):
                current = Path(directory)
                directories[:] = sorted(
                    name for name in directories
                    if name.lower() not in EXCLUDED_DIRS
                    and not excluded_file(name)
                    and not (current / name).is_symlink()
                    and not any(word in name.lower() for word in ("secret", "credential"))
                )
                for name in sorted(files):
                    source = current / name
                    if excluded_file(name) or source.is_symlink() or not source.is_file():
                        continue
                    archive.write(source, arcname=str(Path("recall") / source.relative_to(ROOT)))
                    count += 1
        os.replace(temporary_path, OUTPUT_PATH)
    finally:
        temporary_path.unlink(missing_ok=True)
    print("Created dist/recall-mvp.zip ({} source files; environments, data and secrets excluded).".format(count))


if __name__ == "__main__":
    main()
