"""Shared fixtures: a store built from the legacy JSON tables and reference
fixtures generated from the v0.2.0-alpha.1 client.

Set ``BMC_TEST_DB=data/broad_modelcard.sqlite`` to reuse (or build once) a
persistent store instead of importing into a temporary directory each session.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from tiny_tables import tiny_tables, write_tables

from app import db
from app.importers.legacy_json import DEFAULT_SEED_DIR, ImportReport, import_legacy_tables
from app.main import create_app
from app.services.dataset import Dataset

# Tests choose their own upload folders; an inherited BMC_UPLOADS_DIR (for
# example from `npm run demo`'s shell) must not redirect them.
os.environ.pop("BMC_UPLOADS_DIR", None)

# The API answers loopback clients only (app/api/guard.py); TestClient's
# default client address is "testclient".
LOCAL_CLIENT = {"base_url": "http://127.0.0.1", "client": ("127.0.0.1", 50000)}


def local_client(app) -> TestClient:
    return TestClient(app, **LOCAL_CLIENT)

SEED_DIR = DEFAULT_SEED_DIR
REFERENCE_TAG = "v0.2.0-alpha.1"
REFERENCE_DIR = db.BACKEND_DIR / ".reference"
GENERATOR = Path(__file__).parent / "reference" / "generate_reference.mjs"

# Filled by the tests and printed at the end of the run (gate evidence).
IMPORT_REPORTS: list[ImportReport] = []
PARITY_COUNTS: dict[str, int] = {}
BUDGET_LINES: list[str] = []


def record(name: str, count: int) -> None:
    PARITY_COUNTS[name] = PARITY_COUNTS.get(name, 0) + count


def record_budget(line: str) -> None:
    BUDGET_LINES.append(line)


def _git(*args: str) -> str:
    return subprocess.run(["git", "-C", str(db.REPO_ROOT), *args], check=True, capture_output=True, text=True).stdout


def _reference_stamp(commit: str) -> str:
    digest = hashlib.sha256()
    digest.update(commit.encode())
    digest.update(GENERATOR.read_bytes())
    for path in sorted(SEED_DIR.rglob("*.json")):
        stat = path.stat()
        digest.update(f"{path.relative_to(SEED_DIR)}:{stat.st_size}:{stat.st_mtime_ns}".encode())
    return digest.hexdigest()


@pytest.fixture(scope="session")
def reference_dir() -> Path:
    """Extract the tagged client and run the fixture generator (cached)."""
    if shutil.which("node") is None:
        pytest.skip("Node.js is required to generate parity fixtures from the reference client.")
    source = REFERENCE_DIR / REFERENCE_TAG
    source_stamp = source / ".commit"
    try:
        commit = _git("rev-parse", f"{REFERENCE_TAG}^{{commit}}").strip()
    except subprocess.CalledProcessError:
        # The tag is not part of the published history. A checkout that once
        # extracted the reference client keeps it in the ignored cache; any
        # other checkout cannot run the parity tests.
        if not source_stamp.exists():
            pytest.skip(f"Parity needs the reference client: tag {REFERENCE_TAG} or a cached {source}.")
        commit = source_stamp.read_text()
    if not source_stamp.exists() or source_stamp.read_text() != commit:
        shutil.rmtree(source, ignore_errors=True)
        source.mkdir(parents=True)
        archive = subprocess.run(
            ["git", "-C", str(db.REPO_ROOT), "archive", "--format=tar", REFERENCE_TAG, "src", "package.json"],
            check=True,
            capture_output=True,
        ).stdout
        subprocess.run(["tar", "-x", "-C", str(source)], input=archive, check=True)
        source_stamp.write_text(commit)

    out = REFERENCE_DIR / "fixtures"
    stamp_file = out / ".stamp"
    stamp = _reference_stamp(commit)
    if not (stamp_file.exists() and stamp_file.read_text() == stamp and (out / "reference.json").exists()):
        subprocess.run(
            ["node", str(GENERATOR), "--src", str(source), "--seed", str(SEED_DIR), "--out", str(out)],
            check=True,
            capture_output=True,
        )
        stamp_file.write_text(stamp)
    return out


@pytest.fixture(scope="session")
def reference(reference_dir: Path) -> dict:
    return json.loads((reference_dir / "reference.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def legacy_db(tmp_path_factory) -> Path:
    override = os.environ.get("BMC_TEST_DB")
    path = Path(override).resolve() if override else tmp_path_factory.mktemp("store") / "broad_modelcard.sqlite"
    IMPORT_REPORTS.append(import_legacy_tables(SEED_DIR, path))
    return path


@pytest.fixture(scope="session")
def live_dataset(legacy_db: Path) -> Dataset:
    return Dataset(db.connect(legacy_db, read_only=True))


@pytest.fixture(scope="session")
def fallback_dataset(reference_dir: Path, tmp_path_factory) -> Dataset:
    path = tmp_path_factory.mktemp("fallback") / "fallback.sqlite"
    import_legacy_tables(reference_dir / "fallback_tables", path)
    return Dataset(db.connect(path, read_only=True))


@pytest.fixture(scope="session")
def client(legacy_db: Path):
    """The API on the full store, validating every JSON body against the response models."""
    with local_client(create_app(legacy_db, validate_responses=True)) as test_client:
        yield test_client


@pytest.fixture(scope="session")
def production_client(legacy_db: Path):
    """The API as served (no response validation), for timing."""
    with local_client(create_app(legacy_db)) as test_client:
        yield test_client


@pytest.fixture(scope="session")
def tiny_db(tmp_path_factory) -> Path:
    root = tmp_path_factory.mktemp("tiny")
    path = root / "tiny.sqlite"
    import_legacy_tables(write_tables(root / "tables", tiny_tables()), path)
    return path


@pytest.fixture(scope="session")
def tiny_client(tiny_db: Path):
    """The API on the tiny synthetic table set (one model, two conditions)."""
    with local_client(create_app(tiny_db, validate_responses=True)) as test_client:
        yield test_client


def copy_store(source: Path, target: Path) -> Path:
    """A consistent copy of a store (SQLite backup), for tests that publish."""
    with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as src, sqlite3.connect(target) as dst:
        src.backup(dst)
    src.close()
    dst.close()
    return target


@pytest.fixture(scope="session")
def demo_db(legacy_db: Path, tmp_path_factory):
    """The demo pack built into a copy of the session's seed import: (store path, build report).

    Read-only for tests (copy it to publish); about a second, since the pack
    builds on the existing import (``import_seed=False``)."""
    from app.demo.builder import build

    store = copy_store(legacy_db, tmp_path_factory.mktemp("demo") / "dashboard-demo.sqlite")
    return store, build(store, import_seed=False)


# The cards whose rows the full-store gate tests upload whole (tests/test_admin_gate.py).
EVIDENCE_CARDS = (("SynGPT-2.0", "Clinician Facing CDSS"), ("MediCore-2.5", "Discharge letter generation"))


@pytest.fixture(scope="session")
def evidence_db(legacy_db: Path, tmp_path_factory) -> Path:
    """A copy of the seed import in which EVIDENCE_CARDS have synthetic evidence for every row
    with performance (contract v1.11: an upload rejects performance without evidence, so a
    filled template of a seed card no longer round-trips). Published through the workflow as
    versions 2 and 3, as the demo revision does. Read-only for tests (copy it to publish)."""
    from app.demo.builder import publish_evidence
    from app.publishing.uploads import AdminService
    from app.repository import RowSource

    root = tmp_path_factory.mktemp("evidence")
    store = copy_store(legacy_db, root / "evidence.sqlite")
    admin = AdminService(store, uploads_dir=root / "uploads")
    admin.open()
    try:
        source = RowSource("Test evidence (synthetic)", "TEST-EV-1", "2026-10-13")
        published = publish_evidence(admin, store, source, note=lambda card: f"Synthetic evidence for {card}.", cards=EVIDENCE_CARDS)
    finally:
        admin.close()
    assert [entry["version_id"] for entry in published] == [2, 3]
    return store


@pytest.fixture(scope="session")
def demo_client(demo_db):
    """The API on the demo store (pack v4: a local population, contract v1.10, and the demo revision, v1.11), validating every
    JSON body. Read-only: tests that publish copy the store."""
    with local_client(create_app(demo_db[0], validate_responses=True, uploads_dir=demo_db[1].uploads_dir)) as test_client:
        yield test_client


@pytest.fixture(scope="session")
def ontology_db(legacy_db: Path, tmp_path_factory) -> Path:
    """A copy of the seed import with the fixture ontologies imported (contract v1.13,
    tests/ontology_fixtures.py: ICD-10-CM and MONDO stand-ins). Read-only for tests."""
    from ontology_fixtures import import_fixture_ontologies

    root = tmp_path_factory.mktemp("ontology")
    store = copy_store(legacy_db, root / "ontology.sqlite")
    import_fixture_ontologies(store, root / "sources")
    return store


@pytest.fixture(scope="session")
def ontology_client(ontology_db: Path):
    """The API on the seed import with the fixture ontologies, validating every JSON body."""
    with local_client(create_app(ontology_db, validate_responses=True)) as test_client:
        yield test_client


@pytest.fixture(scope="session")
def ontology_demo_client(demo_db, tmp_path_factory):
    """The API on a copy of the demo store (a local population, safety incidents) with the fixture ontologies."""
    from ontology_fixtures import import_fixture_ontologies

    root = tmp_path_factory.mktemp("ontology-demo")
    store = copy_store(demo_db[0], root / "demo.sqlite")
    import_fixture_ontologies(store, root / "sources")
    with local_client(create_app(store, validate_responses=True, uploads_dir=root / "uploads")) as test_client:
        yield test_client


@pytest.fixture
def tiny_store(tiny_db: Path, tmp_path: Path) -> Path:
    """A private copy of the tiny store; uploads go to ``tmp_path/uploads``."""
    return copy_store(tiny_db, tmp_path / "tiny.sqlite")


@pytest.fixture
def admin_client(tiny_store: Path):
    """The API on a private tiny store, validating every JSON body."""
    with local_client(create_app(tiny_store, validate_responses=True)) as test_client:
        yield test_client


def pytest_terminal_summary(terminalreporter):
    for report in IMPORT_REPORTS:
        terminalreporter.write_sep("-", "legacy JSON import")
        terminalreporter.write_line(report.describe())
    if PARITY_COUNTS:
        terminalreporter.write_sep("-", "parity checks (rows compared)")
        for name, count in PARITY_COUNTS.items():
            terminalreporter.write_line(f"{name}: {count:,}")
    if BUDGET_LINES:
        terminalreporter.write_sep("-", "API budgets")
        for line in BUDGET_LINES:
            terminalreporter.write_line(line)
