"""SQLite connection handling and versioned schema migrations.

Migrations are plain SQL files in ``app/migrations`` named ``NNNN_name.sql``.
They are applied in order, each in its own transaction, and recorded in
``schema_migrations``. Applied migrations are never edited; add a new file.

Migration options. A migration's first line may be ``-- bmc: <option> ...``:

* ``foreign-keys-off``: foreign key enforcement is turned off for this
  migration, as SQLite's documented table rebuild requires (create the new
  table, copy, drop the old one, rename the new one; needed to change a CHECK
  constraint). ``PRAGMA foreign_keys`` cannot change inside a transaction, so
  the runner sets it before ``BEGIN IMMEDIATE``, runs ``PRAGMA
  foreign_key_check`` before ``COMMIT`` (any violation rolls the migration
  back), and restores the connection's setting afterwards.
"""

from __future__ import annotations

import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_DIR.parent
DEFAULT_DB_PATH = BACKEND_DIR / "data" / "broad_modelcard.sqlite"
MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"

_MIGRATION_NAME = re.compile(r"^(\d{4})_([a-z0-9_]+)\.sql$")
_OPTIONS_LINE = re.compile(r"^--\s*bmc:\s*(.*)$")
MIGRATION_OPTIONS = frozenset({"foreign-keys-off"})


class MigrationError(RuntimeError):
    """A migration left the store inconsistent and was rolled back."""


def connect(path: Path | str, *, read_only: bool = False, check_same_thread: bool = True) -> sqlite3.Connection:
    """Open the store with the settings every caller relies on.

    ``check_same_thread=False`` lets a connection move between threads; the
    caller must then serialize access (the API does so with one lock).
    """
    if read_only:
        conn = sqlite3.connect(f"file:{Path(path)}?mode=ro", uri=True, check_same_thread=check_same_thread)
    else:
        conn = sqlite3.connect(Path(path), check_same_thread=check_same_thread)
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def available_migrations() -> list[tuple[int, str, Path]]:
    found = []
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        match = _MIGRATION_NAME.match(path.name)
        if not match:
            raise RuntimeError(f"Unexpected migration file name: {path.name}")
        found.append((int(match.group(1)), match.group(2), path))
    versions = [version for version, _, _ in found]
    if versions != list(range(1, len(found) + 1)):
        raise RuntimeError(f"Migrations must be numbered 0001, 0002, ... without gaps; found {versions}")
    return found


def schema_version(conn: sqlite3.Connection) -> int:
    exists = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
    ).fetchone()
    if not exists:
        return 0
    return conn.execute("SELECT COALESCE(MAX(version), 0) FROM schema_migrations").fetchone()[0]


def migration_options(script: str) -> frozenset[str]:
    """The ``-- bmc: ...`` options on a migration's first line."""
    first = script.split("\n", 1)[0].strip()
    match = _OPTIONS_LINE.match(first)
    if not match:
        return frozenset()
    options = frozenset(match.group(1).split())
    unknown = options - MIGRATION_OPTIONS
    if unknown:
        raise RuntimeError(f"Unknown migration options {sorted(unknown)}")
    return options


def migrate(conn: sqlite3.Connection) -> list[int]:
    """Apply pending migrations; returns the versions applied.

    Several processes may open a new store at once (the end-to-end tests start
    one backend per test file). Each migration runs as one script in a write
    transaction (``BEGIN IMMEDIATE``) that records its ``schema_migrations``
    row first: a process that lost the race fails on that row's primary key,
    rolls back, and skips the migration instead of repeating it.
    """
    conn.commit()
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations ("
        " version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)"
    )
    conn.commit()
    applied = []
    for version, name, path in available_migrations():
        if version <= schema_version(conn):
            continue
        script = path.read_text(encoding="utf-8")
        foreign_keys_off = "foreign-keys-off" in migration_options(script)
        enforced = conn.execute("PRAGMA foreign_keys").fetchone()[0]
        if foreign_keys_off:
            conn.execute("PRAGMA foreign_keys = OFF")  # only effective outside a transaction
        try:
            # executescript() commits first; wrap the script so each migration is atomic.
            conn.executescript(
                "BEGIN IMMEDIATE;\n"
                "INSERT INTO schema_migrations (version, name, applied_at) "
                f"VALUES ({version}, '{name}', '{utc_now()}');\n"
                f"{script}\n"
            )
            if foreign_keys_off:
                violations = conn.execute("PRAGMA foreign_key_check").fetchmany(5)
                if violations:
                    raise MigrationError(f"Migration {path.name} breaks foreign keys: {violations}")
            conn.execute("COMMIT")
        except (sqlite3.Error, MigrationError):
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            if version <= schema_version(conn):
                continue  # another process applied it meanwhile
            raise
        finally:
            if foreign_keys_off:
                conn.execute(f"PRAGMA foreign_keys = {'ON' if enforced else 'OFF'}")  # as the caller had it
        applied.append(version)
    return applied


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
