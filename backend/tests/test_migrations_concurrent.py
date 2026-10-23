"""Migrations applied by several processes at once (the end-to-end tests start
one backend per test file on the same fresh store)."""

from __future__ import annotations

import multiprocessing
from pathlib import Path

from app import db


def _migrate(path: str) -> list[int]:
    conn = db.connect(path)
    try:
        return db.migrate(conn)
    finally:
        conn.close()


def test_concurrent_migrations_apply_each_version_once(tmp_path: Path):
    path = str(tmp_path / "store.sqlite")
    context = multiprocessing.get_context("spawn")
    with context.Pool(4) as pool:
        results = pool.map(_migrate, [path] * 4)
    versions = [version for version, _, _ in db.available_migrations()]
    assert sorted(v for applied in results for v in applied) == versions
    conn = db.connect(path)
    assert db.schema_version(conn) == versions[-1]
    assert conn.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()[0] == len(versions)
