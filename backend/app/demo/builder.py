"""Build the demo store: the seed import, then every demo pack file published
through the same code paths as the Data Library.

The pack (``backend/demo/manifest.json``) lists its files in order, each with
its data set kind, target (metrics and multimorbidity: the card; since
contract v1.10, population: ``population_id`` and ``population_name``), mode (``replace`` or,
since contract v1.7, ``merge``), and change note. Each file is uploaded with
``AdminService.create_upload``, checked in the background like any upload, and
published with ``AdminService.publish``; the version's change note names the
pack version, the file, and its note (the version summary describes the
change, as for any publish). Any invalid upload stops the build with its
problems.

Since pack v6 (contract v1.13, CONTRACT.md §26) a file may be **local
results** (kind ``local_metrics``, target card and ``population_id``), and an
entry may be a **developer submission** (``{"submission": {developer_name,
model_version, note}, "parts": [...]}``): the builder opens the submission and
stages its parts in it (files, and a narrow model card as JSON or Markdown),
waits until every part is valid, and publishes nothing: they wait in the
custodian's queue. Publishes record the role (``hospital`` for local results
and hospital records, otherwise ``maintainer``) and the name "Demo pack".

A manifest entry may also be **generated** instead of naming a file (pack v4,
contract v1.11): ``{"generate": "evidence", "note", "source", "study",
"source_date"}`` gives every row with a performance value and no evidence
synthetic evidence and publishes it per card through the same workflow
(``revision.py``): a merge upload of the changed metrics rows with that
source, and, should a multimorbidity set have such rows, a replace upload of
the set. The rows are made from the store at build time, never committed.

Since pack v12 (contract v1.14, CONTRACT.md §32.2) an entry may be an
**evaluation results import** (``{"evaluation": "<file>.json", "note"}``): the
builder checks the file like any upload, takes its proposed records, stages
and publishes the benchmark study and then the metrics merge that names it
(one version each, the note naming the part), and discards the checked file,
which publishes nothing itself.

Order rules come from the workflow itself (CONTRACT.md §11): a registry upload
is invalid while one of its use cases has no metrics, and a metrics target
must be in the live registry or a staged registry upload. So a registry file
that names new configurations stays staged (its only problem is
``use_case_without_metrics``) while the files after it publish their metrics;
the workflow checks it again after each metrics publish, and the builder
publishes it once it is valid.

The builder refuses a store that a running backend has open (``npm run demo``
or ``npm run dev`` on it): rebuilding would replace the file under the server.
It reads the dev markers that ``scripts/backendServer.mjs`` writes
(``backend/data/dev-api-<port>.json``, the store and the backend's pid) and
also tries an exclusive SQLite lock, which an open connection to a WAL store
blocks.

The demo store is never the live store (``backend/data/broad_modelcard.sqlite``)
and keeps its uploads in its own folder (``<store name>-uploads/``), never in
the live store's ``backend/data/uploads/``. All data is synthetic and every
name in the pack is fictional.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Collection

from .. import db
from ..importers.legacy_json import DEFAULT_SEED_DIR, import_legacy_tables
from ..publishing.uploads import AdminService
from ..repository import RowSource
from .revision import evidence_uploads
from ..schema.contract import DATASET_KINDS, MAX_NOTE, MERGE_KINDS, POPULATION_ID_PATTERN, UPLOAD_MODES
from ..schema.templates import TARGETED_KINDS

PACK_DIR = db.BACKEND_DIR / "demo"
DEFAULT_DEMO_DB = db.BACKEND_DIR / "data" / "dashboard-demo.sqlite"
LIVE_UPLOADS_DIR = db.DEFAULT_DB_PATH.parent / "uploads"
# Where scripts/backendServer.mjs records the backends it starts (MARKER_DIR there).
MARKER_DIR = db.BACKEND_DIR / "data"
STOP_FIRST = "Stop `npm run demo` (or the `npm run dev` that serves this store) first, then build again."
MODES = UPLOAD_MODES  # replace, and merge since contract v1.7


class DemoBuildError(RuntimeError):
    """The pack or the build failed; the message says what to fix."""


@dataclass(frozen=True)
class PackFile:
    path: str  # relative to the pack directory
    kind: str
    # A card, (population id, population name) for a population, (model, use case,
    # population id) for local results, or (model version,) for a narrow model card.
    target: tuple[str, ...] | None
    mode: str
    note: str
    role: str = "maintainer"  # the workspace a publish records (contract v1.13)


@dataclass(frozen=True)
class SubmissionStep:
    """A developer submission (pack v6, contract v1.13): parts staged, never published."""

    developer_name: str
    model_version: str
    note: str
    parts: tuple[PackFile, ...]

    @property
    def path(self) -> str:
        return f"submission of {self.model_version}"


PUBLISHER_NAME = "Demo pack"


@dataclass(frozen=True)
class GeneratedStep:
    """A manifest entry that the builder generates from the store (pack v4)."""

    generate: str  # "evidence"
    note: str
    source: RowSource  # the source of every generated metrics row

    @property
    def path(self) -> str:
        return f"generated {self.generate}"


@dataclass(frozen=True)
class EvaluationStep:
    """An evaluation results import (pack v12, contract v1.14, CONTRACT.md §32.2): the file is
    checked like any upload, then its proposed benchmark study and metrics merge records are
    staged and published one version each, as a maintainer does in the Data Library."""

    file: str  # relative to the pack directory
    note: str

    @property
    def path(self) -> str:
        return self.file


GENERATORS = ("evidence",)
# Room for "<model_version> / <use_case>" in a generated step's change note.
CARD_NAME_ROOM = 120


@dataclass(frozen=True)
class Manifest:
    name: str
    version: int
    files: tuple[PackFile | GeneratedStep | SubmissionStep | EvaluationStep, ...]


@dataclass
class BuildReport:
    db_path: Path
    uploads_dir: Path
    pack_version: int
    published: list[dict] = field(default_factory=list)  # VersionEntry per pack file, in publish order
    import_s: float = 0.0
    publish_s: float = 0.0
    # Contract v1.13: what the ontology import did (one line per ontology), or why it did not run.
    ontologies: list[str] = field(default_factory=list)
    # Contract v1.13 (§26): the developer submissions left waiting for a custodian.
    submissions: list[dict] = field(default_factory=list)

    def describe(self) -> str:
        lines = [
            f"demo store: {self.db_path}",
            f"  uploads: {self.uploads_dir}",
            f"  pack v{self.pack_version}: {len(self.published)} files published",
            f"  seed import: {self.import_s:.1f} s, pack: {self.publish_s:.1f} s",
        ]
        lines += [f"  version {entry['version_id']}: {entry['summary']} Note: {entry['note']}" for entry in self.published]
        lines += [
            f"  submission {entry['submission_id']} by {entry['developer_name']}: {len(entry['uploads'])} parts waiting for a custodian"
            for entry in self.submissions
        ]
        lines += [f"  ontologies: {line}" for line in self.ontologies]
        return "\n".join(lines)


def import_demo_ontologies(db_path: Path, sources: Path, log: Callable[[str], None]) -> list[str]:
    """ICD-10-CM and MONDO for the demo store (contract v1.13), when their pinned
    releases are downloaded; otherwise a notice, not a failure: the store then
    serves ICD-11 only. A changed or partial download still fails the build."""
    from ..ontologies.importer import import_ontologies
    from ..ontologies.sources import SourcesMissing

    try:
        report = import_ontologies(db_path, sources=sources, log=log)
    except SourcesMissing:
        return [
            "not imported: the ontology releases are not downloaded, so the demo serves ICD-11 only. "
            "Run `npm run ontologies:fetch`, then `npm run demo:build` again."
        ]
    return [entry.describe() for entry in report.ontologies]


# ---------------------------------------------------------------- manifest

def load_manifest(pack_dir: Path = PACK_DIR) -> Manifest:
    path = Path(pack_dir) / "manifest.json"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise DemoBuildError(f"Cannot read the demo pack manifest {path}: {error}") from error
    if not isinstance(raw.get("version"), int) or not isinstance(raw.get("files"), list) or not raw["files"]:
        raise DemoBuildError(f"{path} needs an integer 'version' and a non-empty 'files' list.")
    files = []
    for index, item in enumerate(raw["files"], start=1):
        where = f"{path}, file {index}"
        if "generate" in item:
            files.append(_generated_step(raw["version"], item, where))
            continue
        if "submission" in item:
            files.append(_submission_step(raw["version"], item, where, pack_dir))
            continue
        if "evaluation" in item:
            files.append(_evaluation_step(raw["version"], item, where, pack_dir))
            continue
        files.append(_pack_file(raw["version"], item, where, pack_dir))
    return Manifest(str(raw.get("pack", "demo pack")), raw["version"], tuple(files))


def _pack_file(version: int, item: dict, where: str, pack_dir: Path, *, in_submission: bool = False) -> PackFile:
    kind = item.get("kind")
    if kind not in DATASET_KINDS:
        raise DemoBuildError(f"{where}: kind must be one of {', '.join(DATASET_KINDS)}.")
    target = item.get("target")
    if kind in TARGETED_KINDS:
        if not isinstance(target, dict) or not target.get("model_version") or not target.get("use_case"):
            raise DemoBuildError(f"{where}: a {kind} file needs a target with model_version and use_case.")
        target = (target["model_version"], target["use_case"])
    elif kind == "population":
        if not isinstance(target, dict) or not target.get("population_id") or not target.get("population_name"):
            raise DemoBuildError(f"{where}: a population file needs a target with population_id and population_name.")
        target = (target["population_id"], target["population_name"])
    elif kind == "model_cards":
        if not isinstance(target, dict) or not target.get("model_version") or item.get("format") not in ("json", "markdown"):
            raise DemoBuildError(f"{where}: a narrow model card needs a target with model_version and a format (json or markdown).")
        target = (target["model_version"], item["format"])
    elif target is not None:
        raise DemoBuildError(f"{where}: a {kind} file has no target.")
    if kind == "local_metrics":
        population = (item.get("target") or {}).get("population_id")
        if not isinstance(population, str) or not re.match(POPULATION_ID_PATTERN, population):
            raise DemoBuildError(f"{where}: local results need a target with population_id.")
        target = (*target, population)
    mode = item.get("mode", "merge" if kind == "model_cards" else "replace")
    if mode not in MODES:
        raise DemoBuildError(f"{where}: mode must be one of {', '.join(MODES)}.")
    if mode == "merge" and kind not in MERGE_KINDS and not (in_submission and kind == "models") and kind != "model_cards":
        raise DemoBuildError(f"{where}: merge works for {', '.join(MERGE_KINDS)} only.")
    name = item.get("file")
    if not isinstance(name, str) or not name or Path(name).is_absolute() or ".." in Path(name).parts:
        raise DemoBuildError(f"{where}: 'file' must be a path inside the pack directory.")
    if not (Path(pack_dir) / name).is_file():
        raise DemoBuildError(f"{where}: {name} does not exist.")
    note = item.get("note") if not in_submission else item.get("note", "Part of a developer submission.")
    if not isinstance(note, str) or not note.strip():
        raise DemoBuildError(f"{where}: every pack file needs a change note.")
    if len(_note(version, name, note.strip())) > MAX_NOTE:
        raise DemoBuildError(f"{where}: the change note is too long (at most {MAX_NOTE} characters with the pack and file name).")
    role = "hospital" if kind == "local_metrics" or item.get("role") == "hospital" else "maintainer"
    return PackFile(name, kind, target, mode, note.strip(), role)


def _submission_step(version: int, item: dict, where: str, pack_dir: Path) -> SubmissionStep:
    head = item.get("submission")
    if not isinstance(head, dict) or not head.get("developer_name") or not head.get("model_version"):
        raise DemoBuildError(f"{where}: a submission needs developer_name and model_version.")
    note = head.get("note")
    if not isinstance(note, str) or not note.strip() or len(note) > MAX_NOTE:
        raise DemoBuildError(f"{where}: a submission needs a note of at most {MAX_NOTE} characters.")
    parts = item.get("parts")
    if not isinstance(parts, list) or not parts:
        raise DemoBuildError(f"{where}: a submission needs parts.")
    return SubmissionStep(
        head["developer_name"],
        head["model_version"],
        note.strip(),
        tuple(_pack_file(version, part, f"{where}, part {index}", pack_dir, in_submission=True) for index, part in enumerate(parts, start=1)),
    )


EVALUATION_PARTS = ("study", "metrics")


def _evaluation_step(version: int, item: dict, where: str, pack_dir: Path) -> EvaluationStep:
    name = item.get("evaluation")
    if not isinstance(name, str) or not name or Path(name).is_absolute() or ".." in Path(name).parts:
        raise DemoBuildError(f"{where}: 'evaluation' must be a path inside the pack directory.")
    if not (Path(pack_dir) / name).is_file():
        raise DemoBuildError(f"{where}: {name} does not exist.")
    note = item.get("note")
    if not isinstance(note, str) or not note.strip():
        raise DemoBuildError(f"{where}: every pack entry needs a change note.")
    if any(len(_note(version, f"{name} ({part})", note.strip())) > MAX_NOTE for part in EVALUATION_PARTS):
        raise DemoBuildError(f"{where}: the change note is too long (at most {MAX_NOTE} characters with the pack and file name).")
    return EvaluationStep(name, note.strip())


def _generated_step(version: int, item: dict, where: str) -> GeneratedStep:
    if item["generate"] not in GENERATORS:
        raise DemoBuildError(f"{where}: generate must be one of {', '.join(GENERATORS)}.")
    note = item.get("note")
    if not isinstance(note, str) or not note.strip():
        raise DemoBuildError(f"{where}: every pack entry needs a change note.")
    fields = {name: item.get(name) for name in ("source", "study", "source_date")}
    if not all(isinstance(value, str) and value.strip() for value in fields.values()):
        raise DemoBuildError(f"{where}: a generated step needs source, study, and source_date (YYYY-MM-DD).")
    step = GeneratedStep(item["generate"], note.strip(), RowSource(fields["source"], fields["study"], fields["source_date"]))
    if len(_note(version, f"{step.path} for " + "x" * CARD_NAME_ROOM, step.note)) > MAX_NOTE:
        raise DemoBuildError(f"{where}: the change note is too long (at most {MAX_NOTE} characters with the pack, step, and card).")
    return step


# ------------------------------------------------------------------ build

def default_uploads_dir(db_path: Path) -> Path:
    return db_path.with_name(f"{db_path.stem}-uploads")


UPLOADS_MARKER = ".bmc-demo-uploads"


def _guard(db_path: Path, uploads_dir: Path) -> None:
    """Refuse the live store, and an uploads folder that is, or holds, a store or the live uploads."""
    live_db = db.DEFAULT_DB_PATH.resolve()
    if db_path.resolve() == live_db:
        raise DemoBuildError(f"{db_path} is the live store; the demo pack is built into a separate store.")
    uploads = uploads_dir.resolve()
    protected = {live_db, live_db.parent, LIVE_UPLOADS_DIR.resolve(), db_path.resolve(), db_path.resolve().parent}
    for path in protected:
        if uploads == path or uploads in path.parents:
            raise DemoBuildError(
                f"{uploads_dir} is, or contains, {path}; choose a separate folder for the demo store's uploads."
            )


def _pid_alive(pid: object) -> bool:
    """``pidAlive`` in scripts/backendServer.mjs: a process with this pid exists."""
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except PermissionError:
        return True  # it exists but belongs to another user
    except OSError:
        return False
    return True


def running_backends(db_path: Path, marker_dir: Path | None = None) -> list[dict]:
    """The dev markers (``dev-api-<port>.json``) of live backends that serve ``db_path``."""
    target = Path(db_path).resolve()
    found = []
    for path in sorted(Path(marker_dir or MARKER_DIR).glob("dev-api-*.json")):
        try:
            marker = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(marker, dict) or not isinstance(marker.get("store"), str):
            continue
        if Path(marker["store"]).resolve() == target and _pid_alive(marker.get("pid")):
            found.append({**marker, "marker": str(path)})
    return found


def _store_locked(db_path: Path) -> bool:
    """Whether another connection holds the store: an exclusive lock fails at once if so.

    In WAL mode (every imported store) an open connection keeps a shared lock,
    so this catches a running backend that left no marker.
    """
    if not db_path.is_file():
        return False
    conn = sqlite3.connect(db_path, timeout=0, isolation_level=None)
    try:
        conn.execute("PRAGMA locking_mode = EXCLUSIVE")
        conn.execute("BEGIN EXCLUSIVE")
        conn.execute("SELECT COUNT(*) FROM sqlite_master").fetchone()
        conn.execute("ROLLBACK")
    except sqlite3.OperationalError as error:
        return "locked" in str(error)
    except sqlite3.DatabaseError:
        return False  # not a store; the import replaces it
    finally:
        conn.close()
    return False


def _refuse_open_store(db_path: Path, marker_dir: Path | None = None) -> None:
    """Refuse a store that a running backend has open; rebuilding would replace it under the server."""
    markers = running_backends(db_path, marker_dir)
    if markers:
        marker = markers[0]
        raise DemoBuildError(
            f"{db_path} is open in a running backend (pid {marker.get('pid')}, port {marker.get('port')}). "
            f"{STOP_FIRST} If no backend runs, remove the stale marker {marker['marker']}."
        )
    if _store_locked(db_path):
        raise DemoBuildError(f"{db_path} is open in another process (the store is locked). {STOP_FIRST}")


def _clear_uploads(uploads_dir: Path) -> None:
    """Empty the demo uploads folder: only one this builder made (it carries the marker), or an empty one."""
    if uploads_dir.exists():
        if not (uploads_dir / UPLOADS_MARKER).is_file() and any(uploads_dir.iterdir()):
            raise DemoBuildError(
                f"{uploads_dir} is not empty and was not made by the demo builder; choose another --uploads-dir."
            )
        shutil.rmtree(uploads_dir)
    uploads_dir.mkdir(parents=True)
    (uploads_dir / UPLOADS_MARKER).write_text("Staged upload files of a Broad Modelcard demo store.\n", encoding="utf-8")


def _single_version(db_path: Path) -> None:
    """Without an import, the store must be an untouched seed import."""
    if not db_path.is_file():
        raise DemoBuildError(f"No store at {db_path}; build without --no-import.")
    conn = db.connect(db_path, read_only=True)
    try:
        versions = conn.execute("SELECT COUNT(*) FROM dataset_versions").fetchone()[0]
        uploads_table = conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'uploads'").fetchone()
        uploads = conn.execute("SELECT COUNT(*) FROM uploads").fetchone()[0] if uploads_table else 0
    finally:
        conn.close()
    if versions != 1 or uploads:
        raise DemoBuildError(f"{db_path} is not a fresh seed import ({versions} versions, {uploads} uploads); build without --no-import.")


def _problems(upload: dict) -> str:
    report = upload.get("report") or {}
    lines = []
    for group in report.get("errors", []):
        example = group["examples"][0] if group["examples"] else None
        where = f" (row {example['row']}, {example['column']}: {example['problem']})" if example else ""
        lines.append(f"  - {group['code']}: {group['message']}{where} Fix: {group['fix']}")
    return "\n".join(lines) or "  (no report)"


def _error_codes(upload: dict) -> set[str]:
    return {group["code"] for group in (upload.get("report") or {}).get("errors", [])}


def build(
    db_path: Path = DEFAULT_DEMO_DB,
    *,
    pack_dir: Path = PACK_DIR,
    seed_dir: Path = DEFAULT_SEED_DIR,
    uploads_dir: Path | None = None,
    import_seed: bool = True,
    log: Callable[[str], None] = lambda message: None,
    marker_dir: Path | None = None,
    ontology_sources: Path | None = None,
) -> BuildReport:
    """Rebuild ``db_path`` from the seed and publish the pack into it.

    Refuses (``DemoBuildError``) a store that a running backend has open
    (``marker_dir``: where to look for dev markers, default ``MARKER_DIR``).
    With ``ontology_sources`` (the CLI passes the default folder), ICD-10-CM
    and MONDO are imported last when their releases are there (contract v1.13).
    """
    db_path = Path(db_path)
    uploads_dir = Path(uploads_dir) if uploads_dir else default_uploads_dir(db_path)
    _guard(db_path, uploads_dir)
    _refuse_open_store(db_path, marker_dir)
    manifest = load_manifest(pack_dir)
    report = BuildReport(db_path, uploads_dir, manifest.version)

    started = time.perf_counter()
    if import_seed:
        log(f"importing the seed into {db_path} (rebuild)")
        import_legacy_tables(seed_dir, db_path, rebuild=True)
    else:
        _single_version(db_path)
    report.import_s = time.perf_counter() - started
    # A rebuilt store has no uploads, so their files go too.
    _clear_uploads(uploads_dir)

    started = time.perf_counter()
    admin = AdminService(db_path, uploads_dir=uploads_dir)
    admin.open()
    try:
        deferred: list[tuple[PackFile, str]] = []

        def publish_deferred() -> None:
            """Publish the registry uploads that waited for their configurations' metrics."""
            admin.wait_for_checks()  # staged registry uploads are checked again after each metrics publish
            for pack_file, upload_id in deferred:
                upload = admin.get_upload(upload_id)
                if upload["status"] != "valid":
                    raise DemoBuildError(f"{pack_file.path} is still invalid after the metrics were published:\n{_problems(upload)}")
                report.published.append(_publish(admin, upload, pack_file, manifest, log))
            deferred.clear()

        for pack_file in manifest.files:
            # A later registry file, or a step generated from the registry, needs the waiting one published first.
            # An evaluation import compares with the card's configuration, so the registry goes first too.
            if deferred and (isinstance(pack_file, (GeneratedStep, SubmissionStep, EvaluationStep)) or pack_file.kind == "models"):
                publish_deferred()
            if isinstance(pack_file, GeneratedStep):
                report.published += _publish_generated(admin, db_path, pack_file, manifest, log)
                continue
            if isinstance(pack_file, EvaluationStep):
                report.published += _publish_evaluation(admin, Path(pack_dir), pack_file, manifest, log)
                continue
            if isinstance(pack_file, SubmissionStep):
                report.submissions.append(_stage_submission(admin, Path(pack_dir), pack_file, log))
                continue
            upload = _upload(admin, Path(pack_dir), pack_file, log)
            if upload["status"] == "valid":
                report.published.append(_publish(admin, upload, pack_file, manifest, log))
            elif pack_file.kind == "models" and _error_codes(upload) == {"use_case_without_metrics"}:
                log(f"{pack_file.path}: staged until its new configurations have metrics")
                deferred.append((pack_file, upload["upload_id"]))
            else:
                raise DemoBuildError(f"{pack_file.path} is invalid:\n{_problems(upload)}")
        publish_deferred()
    finally:
        admin.close()
    report.publish_s = time.perf_counter() - started
    if ontology_sources is not None:
        report.ontologies = import_demo_ontologies(db_path, Path(ontology_sources), log)
    return report


def _stage_submission(admin: AdminService, pack_dir: Path, step: SubmissionStep, log: Callable[[str], None]) -> dict:
    """Open a developer submission and stage its parts in it; nothing is published (contract v1.13, §26)."""
    submission = admin.create_submission(developer_name=step.developer_name, model_version=step.model_version, note=step.note)
    for part in step.parts:
        _upload(admin, pack_dir, part, log, submission_id=submission["submission_id"])
    admin.wait_for_checks()
    submission = admin.get_submission(submission["submission_id"])
    invalid = [upload for upload in submission["uploads"] if upload["status"] != "valid"]
    if invalid:
        raise DemoBuildError(f"{step.path}: a part is invalid:\n" + "\n".join(_problems(upload) for upload in invalid))
    log(f"{step.path}: {len(submission['uploads'])} parts waiting for a custodian ({submission['submission_id']})")
    return submission


def _upload(admin: AdminService, pack_dir: Path, pack_file: PackFile, log: Callable[[str], None], *, submission_id: str | None = None) -> dict:
    """Stage one pack file (a copy: the workflow moves the uploaded file) and wait for its check."""
    source = pack_dir / pack_file.path
    if pack_file.kind == "model_cards":
        log(f"{pack_file.path}: staging as a narrow model card of {pack_file.target[0]}")
        created = admin.create_model_card_upload(
            model_version=pack_file.target[0], source_format=pack_file.target[1], content=source.read_text(encoding="utf-8"),
            filename=source.name, submission_id=submission_id,
        )
        admin.wait_for_checks()
        return admin.get_upload(created["upload_id"])
    population = pack_file.kind == "population"
    local = pack_file.kind == "local_metrics"
    log(
        f"{pack_file.path}: uploading as {pack_file.kind} ({pack_file.mode})"
        + (f" for {pack_file.target[0]} / {pack_file.target[1]}" if pack_file.target else "")
    )
    with tempfile.TemporaryDirectory(prefix="bmc-demo-") as scratch:
        copy = Path(scratch) / source.name
        shutil.copyfile(source, copy)
        created = admin.create_upload(
            kind=pack_file.kind,
            filename=source.name,
            source=copy,
            model_version=pack_file.target[0] if pack_file.target and not population else None,
            use_case=pack_file.target[1] if pack_file.target and not population else None,
            mode=pack_file.mode,
            population_id=pack_file.target[0] if population else pack_file.target[2] if local else None,
            population_name=pack_file.target[1] if population else None,
            submission_id=submission_id,
        )
    admin.wait_for_checks()
    return admin.get_upload(created["upload_id"])


def _publish_evaluation(
    admin: AdminService, pack_dir: Path, step: EvaluationStep, manifest: Manifest, log: Callable[[str], None]
) -> list[dict]:
    """Import an evaluation results file and publish its proposed records (contract v1.14,
    §32.2): the benchmark study first, then the metrics merge that names it, each staged
    with the records upload, checked, and published with the pack's note. The checked
    file itself publishes nothing; it is discarded once its records are published."""
    source = pack_dir / step.file
    log(f"{step.file}: importing evaluation results")
    created = admin.create_evaluation_upload(content=source.read_text(encoding="utf-8"), filename=source.name)
    admin.wait_for_checks()
    upload = admin.get_upload(created["upload_id"])
    if upload["status"] != "valid":
        raise DemoBuildError(f"{step.file} is invalid:\n{_problems(upload)}")
    proposals = admin.evaluation_proposals(upload["upload_id"])
    published = []
    for part, kind, card, records in (
        ("study", "studies", (None, None), [proposals["study"]]),
        ("metrics", "metrics", (proposals["model_version"], proposals["use_case"]), proposals["metrics"]["records"]),
    ):
        staged = admin.create_records_upload(kind=kind, records=records, model_version=card[0], use_case=card[1])
        admin.wait_for_checks()
        staged = admin.get_upload(staged["upload_id"])
        if staged["status"] != "valid":
            raise DemoBuildError(f"{step.file} ({part}) is invalid:\n{_problems(staged)}")
        entry = admin.publish(
            staged["upload_id"], previewed=False, note=_note(manifest.version, f"{step.file} ({part})", step.note),
            role="maintainer", publisher_name=PUBLISHER_NAME,
        )
        log(f"{step.file} ({part}): published as version {entry['version_id']}")
        published.append(entry)
    admin.discard(upload["upload_id"])
    return published


def _publish_generated(
    admin: AdminService, db_path: Path, step: GeneratedStep, manifest: Manifest, log: Callable[[str], None]
) -> list[dict]:
    """Publish the generated evidence uploads, one per card, through the workflow."""
    return publish_evidence(
        admin, db_path, step.source, note=lambda card: _note(manifest.version, f"{step.path} for {card}", step.note), log=log
    )


def publish_evidence(
    admin: AdminService,
    db_path: Path,
    source: RowSource,
    *,
    note: Callable[[str], str],
    cards: Collection[tuple[str, str]] | None = None,
    log: Callable[[str], None] = lambda message: None,
) -> list[dict]:
    """Give every row with performance and no evidence synthetic evidence
    (``revision.evidence_uploads``; all cards, or ``cards``) and publish it
    per card through the workflow, with the change note ``note(card)``.
    Returns the published versions."""
    published = []
    conn = db.connect(db_path, read_only=True)
    try:
        with tempfile.TemporaryDirectory(prefix="bmc-demo-revision-") as scratch:
            for generated in evidence_uploads(conn, Path(scratch), source, cards):
                card = f"{generated.model_version} / {generated.use_case}"
                log(f"generated evidence: {generated.rows:,} {generated.kind} rows of {card} ({generated.mode})")
                created = admin.create_upload(
                    kind=generated.kind,
                    filename=generated.path.name,
                    source=generated.path,
                    model_version=generated.model_version,
                    use_case=generated.use_case,
                    mode=generated.mode,
                )
                admin.wait_for_checks()
                upload = admin.get_upload(created["upload_id"])
                if upload["status"] != "valid":
                    raise DemoBuildError(f"The generated evidence for {card} is invalid:\n{_problems(upload)}")
                entry = admin.publish(upload["upload_id"], previewed=False, note=note(card))
                log(f"generated evidence for {card}: published as version {entry['version_id']}")
                published.append(entry)
    finally:
        conn.close()
    return published


def _note(version: int, path: str, note: str) -> str:
    return f"Demo pack v{version}, {path}: {note}"


def _publish(admin: AdminService, upload: dict, pack_file: PackFile, manifest: Manifest, log: Callable[[str], None]) -> dict:
    entry = admin.publish(
        upload["upload_id"], previewed=False, note=_note(manifest.version, pack_file.path, pack_file.note),
        role=pack_file.role, publisher_name=PUBLISHER_NAME,
    )
    log(f"{pack_file.path}: published as version {entry['version_id']}")
    return entry
