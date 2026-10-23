"""The update workflow: upload → check → review changes → publish, and rollback.

``AdminService`` owns every write to the store. Uploads are stored under
``<store directory>/uploads/<upload_id>/`` and checked in a background thread,
which reports progress. A valid upload is written as a staged content set; a
staged read (``version=staged:<upload_id>``) swaps it into the live version for
that request, and publishing adds a version that lists it.

* One upload per data set can be staged (checking, invalid, or valid): per
  kind, and per model and use case for metrics and multimorbidity. A new one
  needs ``replace_staged``, which marks the old one superseded.
* Publishing and rollback are serialized: a second attempt while one runs gets
  409 ``publish_in_progress``. Each runs in one transaction.
* After a metrics publish or a rollback, staged registry uploads are checked
  again, because their check depends on which functions have metrics. After a
  registry publish or a rollback, staged safety uploads are checked again
  (their cards must exist).
* Merge uploads (contract v1.7) are applied to the live set at check time. When
  a publish or rollback replaces that set, a staged merge upload is checked
  again on the new live set; until then it cannot be published or reviewed
  (409 ``upload_outdated``).
* The records upload (contract v1.7) turns JSON records into a template-form
  CSV and stages it like a file, so one checker serves both.
* Publish and rollback take an optional change note, stored on the version.

All data is synthetic demonstration data. Never upload patient data.
"""

from __future__ import annotations

import csv
import json
import logging
import re
import secrets
import shutil
import sqlite3
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .. import db, repository
from ..importers.spreadsheets import UnreadableFile, detect_format, open_table
from ..repository import DatasetState, MissingData, RowSource
from ..schema.contract import (
    DATASET_KINDS,
    EVALUATION_RESULTS_KIND,
    MAX_EVALUATION_BYTES,
    MAX_MODEL_CARD_BYTES,
    MAX_NOTE,
    MAX_POPULATION_NAME,
    MAX_PUBLISHER_NAME,
    MERGE_KINDS,
    MODEL_CARD_FORMATS,
    POPULATION_ID_PATTERN,
    PUBLISHER_ROLES,
    UPLOAD_KINDS,
    UPLOAD_MODES,
)
from ..schema.templates import DATASET_TITLES, PROBLEMS_COLUMN, TARGETED_KINDS, TEMPLATES, YES, NO, column_lookup, normalize_header
from ..services import safety
from ..services.dataset import Dataset
from ..services.errors import UnknownModel, UnknownUseCase
from ..validation.issues import Issues, Mark
from ..validation.uploads import Cancelled, MergeBase, UploadContext, check_upload
from . import changes as change_summaries
from . import content as contents
from . import evaluations, files, model_cards, versions
from .release_service import ReleaseMixin
from .workspaces import WorkspaceMixin

log = logging.getLogger("broad_modelcard.admin")

DEFAULT_MAX_UPLOAD_BYTES = 128 * 1024 * 1024
STAGED_STATUSES = ("checking", "invalid", "valid")
_STAGED_SQL = "('checking', 'invalid', 'valid')"
_RECORD_COLUMNS = (
    "upload_id, kind, model_version, use_case, filename, file_format, status, progress, created_at, report_json, "
    "set_id, previewed, published_version, mode, origin, population_id, population_name, submission_id"
)
# The order in which accepting a submission publishes its uploads (contract
# v1.13, §26): a new card's metrics before its registry row (§11), then the
# registry, then the studies and the narrow model card, then the rest.
SUBMISSION_ORDER = ("metrics", "multimorbidity", "models", "studies", "model_cards", "safety", "prevalence", "population", "local_metrics")
MAX_RECORDS = 5_000
# Contract v1.10 (CONTRACT.md §21): problems that mean the file looks like
# patient-level data. Such a file is deleted as soon as its check ends.
PATIENT_LEVEL_CODES = frozenset({"patient_level_data"})
PATIENT_LEVEL_DELETED = (
    "This file looked like patient-level data, so it was deleted right after the check and no marked copy is kept. "
    "Remove the patient-level columns or rows in your own copy, then upload it again."
)
# Upload modes and origins (contract v1.7).
RECORDS_FILENAME = "{kind}-records.csv"


@dataclass(frozen=True)
class StagedRead:
    """What a staged read layers over the live version (CONTRACT.md §2): the
    state with the upload's set swapped in, and that set. A check run again
    (after a publish, or when a submission's part joins) writes a new set
    under the same upload id, so caches of staged reads are keyed by both."""

    state: DatasetState
    set_id: int


class AdminError(Exception):
    """An admin request that cannot be served (becomes a problem response)."""

    def __init__(self, status: int, code: str, detail: str):
        super().__init__(detail)
        self.status = status
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class UploadRecord:
    upload_id: str
    kind: str
    model_version: str | None
    use_case: str | None
    filename: str
    file_format: str
    status: str
    progress: float
    created_at: str
    report: dict | None
    set_id: int | None
    previewed: bool
    published_version: int | None
    mode: str = "replace"
    origin: str = "file"
    # The target of a population upload (contract v1.10).
    population_id: str | None = None
    population_name: str | None = None
    # The developer submission the upload belongs to (contract v1.13, §26), or None.
    submission_id: str | None = None

    @classmethod
    def from_row(cls, row: tuple) -> "UploadRecord":
        return cls(
            *row[:9], json.loads(row[9]) if row[9] else None, row[10], bool(row[11]), row[12], row[13], row[14], row[15], row[16],
            row[17],
        )

    @property
    def target(self) -> tuple[str, str] | None:
        """The card of a metrics or multimorbidity upload."""
        return (self.model_version, self.use_case) if self.kind in TARGETED_KINDS else None

    @property
    def key(self) -> tuple | str | None:
        """Which set of its kind the upload replaces: the card, the population id,
        for local results the card and population (v1.13), or None."""
        if self.kind == "local_metrics":
            return (self.model_version, self.use_case, self.population_id)
        return self.population_id if self.kind == "population" else self.target

    @property
    def title(self) -> str:
        if self.kind == EVALUATION_RESULTS_KIND:
            # Not a data set (contract v1.14, §32.2): named by the card the file names.
            card = f" for {self.model_version} / {self.use_case}" if self.model_version and self.use_case else ""
            return f"Evaluation results{card}"
        title = DATASET_TITLES[self.kind]
        if self.kind == "population":
            return f"Local population {self.population_name} ({self.population_id})"
        if self.kind == "local_metrics":
            return f"{title} for {self.model_version} / {self.use_case}, local population {self.population_id}"
        if self.kind == "model_cards":
            return f"{title}: {self.model_version}"
        return f"{title} for {self.model_version} / {self.use_case}" if self.target else title


def is_patient_level(report: dict | None) -> bool:
    """Whether a check report found patient-level data (CONTRACT.md §21)."""
    return any(group.get("code") in PATIENT_LEVEL_CODES for group in (report or {}).get("errors", ()))


def without_cells(report: dict) -> dict:
    """A patient-level upload's report as it is kept: every group keeps its
    count, message, and fix, but only the patient-level groups keep their
    examples (a header or an ICD-11 code); other examples quote cells of the
    file, which is not kept."""

    def strip(groups: list[dict]) -> list[dict]:
        return [group if group.get("code") in PATIENT_LEVEL_CODES else {**group, "examples": []} for group in groups]

    return {**report, "errors": strip(report.get("errors", [])), "notes": strip(report.get("notes", []))}


def clean_note(note: str | None) -> str | None:
    """A change note with its whitespace collapsed; None when empty (contract v1.7)."""
    text = " ".join((note or "").split())
    if len(text) > MAX_NOTE:
        raise AdminError(422, "invalid_parameter", f"The change note has {len(text)} characters; at most {MAX_NOTE} are allowed.")
    return text or None


def title_in_sentence(kind: str) -> str:
    """A data set's title inside a sentence ("performance metrics", "AI systems & functions")."""
    title = DATASET_TITLES[kind]
    return title if title.startswith("AI ") else title[:1].lower() + title[1:]


def new_upload_id() -> str:
    return f"up-{secrets.token_hex(6)}"


def clean_filename(filename: str) -> str:
    """The file's own name, without folders or characters unsafe in a download header."""
    name = re.sub(r'[\x00-\x1f\x7f"\\/]+', "_", Path(filename or "").name).strip()
    return name[:200] or "upload"


class AdminService(WorkspaceMixin, ReleaseMixin):
    def __init__(
        self,
        db_path: Path | str,
        *,
        uploads_dir: Path | str | None = None,
        max_upload_bytes: int = DEFAULT_MAX_UPLOAD_BYTES,
    ):
        self.db_path = Path(db_path)
        self.uploads_dir = Path(uploads_dir) if uploads_dir else self.db_path.parent / "uploads"
        self.max_upload_bytes = max_upload_bytes
        self._lock = threading.RLock()
        self._publish_lock = threading.Lock()
        # Accepting a submission publishes several versions: one accept or return at a time (contract v1.13, §26).
        self._decision_lock = threading.Lock()
        self._conn: sqlite3.Connection | None = None
        self._executor: ThreadPoolExecutor | None = None
        self._progress: dict[str, float] = {}
        self._cancelled: set[str] = set()
        # Change summaries by (upload, live version, staged set): a check run again writes a new set.
        self._changes: dict[tuple[str, int, int], dict] = {}
        self._set_counts = versions.SetCounts()
        # Digests of live metrics sets, for release import summaries (contract v1.13).
        self._release_digests: dict[int, str] = {}
        # Called after a publish, rollback, or discard, outside the admin lock.
        self.listeners: list[Callable[[], None]] = []

    # --------------------------------------------------------- lifecycle

    def _connection(self) -> sqlite3.Connection:
        """The writer connection, migrating the store on first use."""
        if self._conn is None:
            if not self.db_path.is_file():
                raise MissingData("The data store does not exist yet. Build it with: python -m app.importers.legacy_json")
            conn = self._connect()
            db.migrate(conn)
            self._conn = conn
            self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="upload-check")
            for (upload_id,) in conn.execute("SELECT upload_id FROM uploads WHERE status = 'checking' ORDER BY rowid"):
                self._executor.submit(self._run_check, upload_id)
        return self._conn

    def _connect(self) -> sqlite3.Connection:
        conn = db.connect(self.db_path, check_same_thread=False)
        conn.isolation_level = None  # explicit transactions only
        conn.execute("PRAGMA busy_timeout = 30000")
        return conn

    def open(self) -> None:
        with self._lock:
            self._connection()

    def close(self) -> None:
        with self._lock:
            self._cancelled.update(self._progress)
            if self._executor is not None:
                self._executor.shutdown(wait=True, cancel_futures=True)
                self._executor = None
            if self._conn is not None:
                self._conn.close()
                self._conn = None

    def wait_for_checks(self, timeout: float = 120.0) -> None:
        """Block until queued checks have finished (tests and scripts)."""
        with self._lock:
            executor = self._executor
        if executor is not None:
            executor.submit(lambda: None).result(timeout=timeout)

    def _notify(self) -> None:
        """After a publish, rollback, discard, or replacement: drop derived state."""
        with self._lock:
            self._changes.clear()
        for listener in self.listeners:
            listener()

    # ------------------------------------------------------------ records

    def _record(self, conn: sqlite3.Connection, upload_id: str) -> UploadRecord | None:
        row = conn.execute(f"SELECT {_RECORD_COLUMNS} FROM uploads WHERE upload_id = ?", (upload_id,)).fetchone()
        return UploadRecord.from_row(row) if row else None

    def _require(self, upload_id: str) -> UploadRecord:
        record = self._record(self._connection(), upload_id)
        if record is None:
            raise AdminError(404, "unknown_upload", f"There is no upload {upload_id!r}.")
        return record

    def upload_dir(self, upload_id: str) -> Path:
        return self.uploads_dir / upload_id

    def source_path(self, record: UploadRecord) -> Path:
        return self.upload_dir(record.upload_id) / f"upload.{record.file_format}"

    def as_api(self, record: UploadRecord) -> dict:
        """openapi.json ``Upload``."""
        progress = self._progress.get(record.upload_id, record.progress) if record.status == "checking" else record.progress
        return {
            "upload_id": record.upload_id,
            "kind": record.kind,
            "filename": record.filename,
            "status": record.status,
            "progress": round(min(1.0, max(0.0, progress)), 4),
            "created_at": record.created_at,
            "target": _target(record),
            "report": record.report,
            "previewed": record.previewed,
            "mode": record.mode,
            "origin": record.origin,
            # Contract v1.13 (§26): the developer submission it belongs to, or null.
            "submission_id": record.submission_id,
        }

    def get_upload(self, upload_id: str) -> dict:
        with self._lock:
            return self.as_api(self._require(upload_id))

    def _staged_ids(self, conn: sqlite3.Connection) -> dict[str, list[str]]:
        staged: dict[str, list[str]] = {}
        for kind, upload_id in conn.execute(
            f"SELECT kind, upload_id FROM uploads WHERE status IN {_STAGED_SQL} AND submission_id IS NULL ORDER BY rowid DESC"
        ):
            staged.setdefault(kind, []).append(upload_id)
        return staged

    # ------------------------------------------------------------ uploads

    def create_upload(
        self,
        *,
        kind: str,
        filename: str,
        source: Path,
        model_version: str | None = None,
        use_case: str | None = None,
        replace_staged: bool = False,
        mode: str = "replace",
        origin: str = "file",
        population_id: str | None = None,
        population_name: str | None = None,
        submission_id: str | None = None,
        file_format: str | None = None,
    ) -> dict:
        """Stage the file at ``source`` (moved into the uploads directory) and queue its check.

        A population upload (contract v1.10) names its population: an id, and
        a display name (required for a new population; a replacement keeps
        the live name when none is given). A local results upload (v1.13)
        names its card and local population. An upload with
        ``submission_id`` (v1.13, §26) joins that developer submission and
        never publishes on its own."""
        if kind not in UPLOAD_KINDS:
            raise AdminError(422, "invalid_parameter", f"kind must be one of {', '.join(DATASET_KINDS)}.")
        if kind == EVALUATION_RESULTS_KIND and file_format != "json":
            raise AdminError(422, "invalid_parameter", "Evaluation results are sent as JSON text to /admin/uploads/evaluation-results.")
        if kind == "model_cards" and file_format is None:
            raise AdminError(422, "invalid_parameter", "Narrow model cards are sent as JSON or Markdown text to /admin/uploads/model-card.")
        if mode not in UPLOAD_MODES:
            raise AdminError(422, "invalid_parameter", f"mode must be one of {', '.join(UPLOAD_MODES)}.")
        if mode == "merge" and kind not in MERGE_KINDS and kind != "model_cards" and not (submission_id and kind == "models"):
            raise AdminError(
                422, "invalid_parameter", f"Merge uploads work for {', '.join(MERGE_KINDS)}; upload {kind} with mode=replace."
            )
        if kind in TARGETED_KINDS:
            model_version, use_case = (model_version or "").strip(), (use_case or "").strip()
            if not model_version or not use_case:
                raise AdminError(422, "invalid_parameter", f"Uploads of {kind} need model_version and use_case.")
        elif kind == "model_cards":
            model_version, use_case = (model_version or "").strip(), None
            if not model_version:
                raise AdminError(422, "invalid_parameter", "A narrow model card needs model_version: the AI system it belongs to.")
        elif kind == EVALUATION_RESULTS_KIND:
            # The card the file names, read before its check; none when it names none (contract v1.14, §32.2).
            if not (model_version and use_case):
                model_version = use_case = None
        else:
            model_version = use_case = None
        if kind == "population":
            population_id, population_name = self._population_target(population_id, population_name)
        elif kind == "local_metrics":
            population_id = (population_id or "").strip()
            if not re.match(POPULATION_ID_PATTERN, population_id):
                raise AdminError(422, "invalid_parameter", "Local results need population_id: the id of a published local population.")
            population_name = None
        else:
            population_id = population_name = None
        if submission_id is not None:
            self._require_open_submission(submission_id)
        size = source.stat().st_size
        if size > self.max_upload_bytes:
            raise AdminError(413, "upload_too_large", self.too_large_detail())
        if file_format is None:
            with open(source, "rb") as handle:
                head = handle.read(8192)
            file_format = detect_format(filename, head)
        if file_format is None:
            raise AdminError(
                415,
                "unsupported_file_type",
                "Upload an Excel workbook (.xlsx) or a CSV file (.csv). Older .xls files must be saved as .xlsx first.",
            )
        upload_id = new_upload_id()
        directory = self.upload_dir(upload_id)
        directory.mkdir(parents=True, exist_ok=False)
        shutil.move(str(source), directory / f"upload.{file_format}")
        superseded: UploadRecord | None = None
        try:
            with self._lock:
                conn = self._connection()
                conn.execute("BEGIN IMMEDIATE")
                try:
                    current = conn.execute(
                        f"SELECT {_RECORD_COLUMNS} FROM uploads WHERE kind = ? AND COALESCE(model_version, '') = ? "
                        f"AND COALESCE(use_case, '') = ? AND COALESCE(population_id, '') = ? AND status IN {_STAGED_SQL} "
                        "AND submission_id IS ?",
                        (kind, model_version or "", use_case or "", population_id or "", submission_id),
                    ).fetchone()
                    if current is not None:
                        superseded = UploadRecord.from_row(current)
                        if not replace_staged:
                            raise AdminError(
                                409,
                                "staged_upload_exists",
                                f"Upload {superseded.upload_id} is already staged for {superseded.title}. "
                                "Discard it first, or upload again with replace_staged=true to replace it.",
                            )
                        conn.execute(
                            "UPDATE uploads SET status = 'superseded', superseded_by = ?, set_id = NULL WHERE upload_id = ?",
                            (upload_id, superseded.upload_id),
                        )
                        if superseded.set_id is not None:
                            contents.delete_content_set(conn, superseded.set_id)
                    conn.execute(
                        "INSERT INTO uploads (upload_id, kind, model_version, use_case, filename, file_format, status, "
                        "progress, created_at, mode, origin, population_id, population_name, submission_id) "
                        "VALUES (?, ?, ?, ?, ?, ?, 'checking', 0, ?, ?, ?, ?, ?, ?)",
                        (
                            upload_id, kind, model_version, use_case, clean_filename(filename), file_format, db.utc_now(),
                            mode, origin, population_id, population_name, submission_id,
                        ),
                    )
                    conn.execute("COMMIT")
                except BaseException:
                    conn.execute("ROLLBACK")
                    raise
                self._progress[upload_id] = 0.0
                if superseded is not None:
                    self._cancelled.add(superseded.upload_id)
                record = self._require(upload_id)
                self._executor.submit(self._run_check, upload_id)
        except BaseException:
            shutil.rmtree(directory, ignore_errors=True)
            raise
        if superseded is not None:
            shutil.rmtree(self.upload_dir(superseded.upload_id), ignore_errors=True)
            self._notify()
        if submission_id is not None:
            # A submission's parts check each other (a new card's metrics and its registry row, §26).
            self._recheck_submission(submission_id, upload_id)
        return self.as_api(record)

    def _recheck_submission(self, submission_id: str, except_upload: str) -> None:
        with self._lock:
            rows = self._connection().execute(
                "SELECT upload_id, set_id FROM uploads WHERE submission_id = ? AND status = 'invalid' AND upload_id != ?",
                (submission_id, except_upload),
            ).fetchall()
        self._recheck(rows)

    def _population_target(self, population_id: str | None, population_name: str | None) -> tuple[str, str]:
        """A population upload's id and name, checked (422 ``invalid_parameter``)."""
        population_id = (population_id or "").strip()
        if not re.match(POPULATION_ID_PATTERN, population_id):
            raise AdminError(
                422,
                "invalid_parameter",
                "Uploads of a local population need population_id: 1 to 40 lower-case letters, digits, or \"-\", "
                "starting with a letter or digit (e.g. northbridge-region).",
            )
        name = " ".join((population_name or "").split())
        if not name:
            with self._lock:
                conn = self._connection()
                live = repository.load_state(conn)
                set_id = live.population_sets.get(population_id)
                name = repository.population_names(conn, [set_id]).get(set_id, "") if set_id is not None else ""
            if not name:
                raise AdminError(422, "invalid_parameter", "A new local population needs population_name, the name shown on every view.")
        if len(name) > MAX_POPULATION_NAME:
            raise AdminError(422, "invalid_parameter", f"population_name has {len(name)} characters; at most {MAX_POPULATION_NAME} are allowed.")
        return population_id, name

    def too_large_detail(self) -> str:
        return f"The file is larger than {self.max_upload_bytes // (1024 * 1024)} MB, the most this tool accepts."

    def create_records_upload(
        self,
        *,
        kind: str,
        records: list,
        model_version: str | None = None,
        use_case: str | None = None,
        mode: str = "merge",
        replace_staged: bool = False,
        population_id: str | None = None,
        submission_id: str | None = None,
    ) -> dict:
        """Stage JSON records as a merge upload (contract v1.7, CONTRACT.md §11.4).

        The records become a template-form CSV (header in row 1, record ``i``
        in row ``i + 2``), which is checked like any uploaded file; problems
        name the row and, in ``record``, the record index. Local results
        (v1.13) name their population; a developer submission (v1.13) may
        send its AI system's registry rows as records too."""
        if kind not in MERGE_KINDS and not (kind == "models" and submission_id):
            raise AdminError(422, "invalid_parameter", f"Records can be uploaded for {', '.join(MERGE_KINDS)}.")
        if mode != "merge":
            raise AdminError(422, "invalid_parameter", "A records upload is always a merge (mode=merge).")
        if not isinstance(records, list) or not 1 <= len(records) <= MAX_RECORDS:
            raise AdminError(422, "invalid_parameter", f"Send between 1 and {MAX_RECORDS:,} records.")
        columns = [column for column in TEMPLATES[kind] if not column.info]
        lookup = column_lookup(kind)
        rows = []
        for index, record in enumerate(records):
            if not isinstance(record, dict):
                raise AdminError(422, "invalid_parameter", f"Record {index} is not an object of field names and values.")
            row: dict[str, object] = {}
            for name, value in record.items():
                column = lookup.get(normalize_header(name))
                if column is None or column.info or column is PROBLEMS_COLUMN:
                    known = ", ".join(column.key for column in columns)
                    raise AdminError(422, "invalid_parameter", f"Record {index} has the unknown field {name!r}. Fields: {known}.")
                if column.key in row:
                    raise AdminError(422, "invalid_parameter", f"Record {index} gives {column.header} twice.")
                if value is not None and not isinstance(value, (str, int, float, bool)):
                    raise AdminError(422, "invalid_parameter", f"Record {index}: {name} must be text, a number, true or false, or null.")
                row[column.key] = value
            rows.append(row)
        incoming = self.uploads_dir / ".incoming"
        incoming.mkdir(parents=True, exist_ok=True)
        handle = tempfile.NamedTemporaryFile("w", dir=incoming, delete=False, suffix=".csv", newline="", encoding="utf-8")  # noqa: SIM115
        path = Path(handle.name)
        try:
            with handle:
                writer = csv.writer(handle)
                writer.writerow([column.header for column in columns])
                for row in rows:
                    writer.writerow([_record_cell(row.get(column.key)) for column in columns])
            return self.create_upload(
                kind=kind,
                filename=RECORDS_FILENAME.format(kind=kind),
                source=path,
                model_version=model_version,
                use_case=use_case,
                replace_staged=replace_staged,
                mode=mode,
                origin="records",
                population_id=population_id,
                submission_id=submission_id,
            )
        finally:
            path.unlink(missing_ok=True)

    def create_model_card_upload(
        self,
        *,
        model_version: str,
        source_format: str,
        content: str,
        filename: str | None = None,
        submission_id: str | None = None,
        replace_staged: bool = False,
    ) -> dict:
        """Stage a narrow model card (contract v1.13, CONTRACT.md §26): JSON or
        Markdown text for one AI system, merged into the narrow model cards and
        checked in the background like a file."""
        if source_format not in MODEL_CARD_FORMATS:
            raise AdminError(422, "invalid_parameter", "format must be json or markdown.")
        data = content.encode("utf-8")
        if len(data) > MAX_MODEL_CARD_BYTES:
            raise AdminError(413, "upload_too_large", f"The card is larger than {MAX_MODEL_CARD_BYTES // 1024} KB, the most a narrow model card may be.")
        file_format = "json" if source_format == "json" else "md"
        incoming = self.uploads_dir / ".incoming"
        incoming.mkdir(parents=True, exist_ok=True)
        handle = tempfile.NamedTemporaryFile("wb", dir=incoming, delete=False, suffix=f".{file_format}")  # noqa: SIM115
        path = Path(handle.name)
        try:
            with handle:
                handle.write(data)
            return self.create_upload(
                kind="model_cards",
                filename=filename or f"model-card.{file_format}",
                source=path,
                model_version=model_version,
                replace_staged=replace_staged,
                mode="merge",
                submission_id=submission_id,
                file_format=file_format,
            )
        finally:
            path.unlink(missing_ok=True)

    def create_evaluation_upload(
        self,
        *,
        content: str,
        filename: str | None = None,
        submission_id: str | None = None,
        replace_staged: bool = False,
    ) -> dict:
        """Stage an evaluation results file (contract v1.14, CONTRACT.md §32.2):
        JSON text in the format ``bmc-evaluation-results/1`` for one card,
        checked in the background like a narrow model card. It is not a data
        set: a valid one offers proposed records (``evaluation_proposals``) and
        never publishes. One staged per card (and per card in a submission)."""
        data = content.encode("utf-8")
        if len(data) > MAX_EVALUATION_BYTES:
            raise AdminError(
                413, "upload_too_large", f"The file is larger than {MAX_EVALUATION_BYTES // 1024} KB, the most an evaluation results file may be."
            )
        model_version, use_case = evaluations.target_of(content)
        incoming = self.uploads_dir / ".incoming"
        incoming.mkdir(parents=True, exist_ok=True)
        handle = tempfile.NamedTemporaryFile("wb", dir=incoming, delete=False, suffix=".json")  # noqa: SIM115
        path = Path(handle.name)
        try:
            with handle:
                handle.write(data)
            return self.create_upload(
                kind=EVALUATION_RESULTS_KIND,
                filename=filename or "evaluation-results.json",
                source=path,
                model_version=model_version,
                use_case=use_case,
                replace_staged=replace_staged,
                submission_id=submission_id,
                file_format="json",
            )
        finally:
            path.unlink(missing_ok=True)

    def _evaluation_card(self, conn: sqlite3.Connection, live: Dataset) -> "Callable[[str, str], evaluations.CardFacts]":
        """Where a card is registered, with its live measure and configuration (contract v1.14, §32.2)."""
        staged = self._staged_registry_variants(conn)

        def facts(model_version: str, use_case: str) -> evaluations.CardFacts:
            model = next((entry for entry in live.registry.models if entry.model_version == model_version), None)
            variant = next((item for item in model.use_cases if item.use_case == use_case), None) if model else None
            if variant is not None:
                return evaluations.CardFacts("live", variant.performance_measure, variant.configuration_id)
            return evaluations.CardFacts("staged" if (model_version, use_case) in staged else None)

        return facts

    def _check_evaluation(self, conn: sqlite3.Connection, live: Dataset, record: UploadRecord) -> None:
        """Check an evaluation results file (contract v1.14, §32.2). A valid one
        stays valid without a content set: it publishes nothing."""
        try:
            text = self.source_path(record).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            issues = Issues()
            issues.add("invalid_evaluation_file", 0, "The file is not UTF-8 text.", mark=False)
            self._finish(record.upload_id, issues.report(0), None, None, [])
            return
        run, issues = evaluations.read_evaluation(text, live.atlas, self._evaluation_card(conn, live))
        rows = len(run.results) if run is not None else 0
        self._finish(record.upload_id, issues.report(rows), None, conn, [], valid=run is not None)

    def evaluation_proposals(self, upload_id: str) -> dict:
        """Records proposed from a valid evaluation results upload (contract v1.14,
        §32.2): one benchmark study record and one metrics merge record per
        result, for the records upload (§11.4), study first. Nothing is staged."""
        with self._lock:
            record = self._require(upload_id)
            conn = self._connection()
            if record.kind != EVALUATION_RESULTS_KIND:
                raise AdminError(409, "upload_not_valid", "Only an evaluation results upload has these proposed records.")
            if record.status not in ("valid", "published"):
                raise AdminError(409, "upload_not_valid", f"Upload {upload_id} is {record.status}; proposals need a valid file.")
            source = self.source_path(record)
            if not source.is_file():
                raise AdminError(409, "upload_not_staged", f"Upload {upload_id} is {record.status}; its file is no longer kept.")
            text = source.read_text(encoding="utf-8")
        reader = db.connect(self.db_path, read_only=True)
        try:
            live = Dataset(reader)
            run, issues = evaluations.read_evaluation(text, live.atlas, self._evaluation_card(reader, live))
            if run is None:
                raise AdminError(409, "upload_outdated", "The file no longer passes its check against the live data. Upload it again.")
            set_id = live.state.metric_sets.get((run.model_version, run.use_case))
            set_reader = (
                repository.MetricSetReader(reader, set_id, repository.WarningSets(reader), cache_size=4) if set_id is not None else None
            )
            axes = live.atlas.axes

            def stored_row(concept_id: str, lens) -> tuple | None:
                return set_reader.row(concept_id, axes.combo_index(lens)) if set_reader is not None else None

            model = next((entry for entry in live.registry.models if entry.model_version == run.model_version), None)
            proposed = evaluations.proposals(run, stored_row=stored_row, display_name=model.display_name if model else None)
        finally:
            reader.close()
        notes = [group for group in issues.report(0)["notes"]]
        return {"upload_id": upload_id, **proposed, "notes": notes}

    def discard(self, upload_id: str) -> None:
        with self._lock:
            record = self._require(upload_id)
            if record.status not in STAGED_STATUSES:
                raise AdminError(409, "upload_not_staged", f"Upload {upload_id} is {record.status}, not staged.")
            conn = self._connection()
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.execute("UPDATE uploads SET status = 'discarded', set_id = NULL WHERE upload_id = ?", (upload_id,))
                if record.set_id is not None:
                    contents.delete_content_set(conn, record.set_id)
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            self._cancelled.add(upload_id)
        shutil.rmtree(self.upload_dir(upload_id), ignore_errors=True)
        self._notify()

    # -------------------------------------------------------------- checks

    def _upload_context(self, conn: sqlite3.Connection, live: Dataset, record: UploadRecord | None = None) -> UploadContext:
        registry = contents.load_registry(conn, live.state.registry_set_id)
        warning_codes = {
            code
            for (codes_json,) in conn.execute("SELECT codes_json FROM warning_sets")
            for code in json.loads(codes_json)
        }
        prevalence = repository.load_prevalence(conn, live.state.prevalence_set_id)
        metric_targets = set(live.state.metric_sets)
        if record is not None and record.submission_id is not None:
            # A submission's new card has its metrics in the same submission (§26).
            metric_targets |= self._submission_metric_targets(conn, record.submission_id)
        return UploadContext(
            atlas=live.atlas,
            registry_variants=frozenset(registry.variants()),
            staged_registry_variants=frozenset(self._staged_registry_variants(conn)),
            metric_targets=frozenset(metric_targets),
            known_warning_codes=frozenset(warning_codes | set(safety.WARNING_RELEVANCE)),
            live_registry=registry,
            prevalence_bounds=(prevalence.min_score, prevalence.max_score),
            mode=record.mode if record else "replace",
            merge_base=_merge_base(conn, live.state, record) if record and record.mode == "merge" else None,
            upload_source=RowSource(f"Upload {record.filename}", None, record.created_at[:10]) if record else None,
            population=(record.population_id, record.population_name) if record and record.kind == "population" else None,
            live_prevalence_codes=frozenset(prevalence.tiers),
            study_ids=frozenset(live.studies.records),
            study_scopes={study.study_id: (study.scope, study.population_id) for study in live.studies.records.values()},
            local_population=record.population_id if record and record.kind == "local_metrics" else None,
            live_population_ids=frozenset(live.state.population_sets),
            study_designs={study_id: study.design for study_id, study in live.studies.records.items()},
            model_configurations=self._model_configurations(conn, live.state.registry_set_id),
        )

    def _model_configurations(self, conn: sqlite3.Connection, live_set_id: int | None) -> dict[str, frozenset[str]]:
        """AI system → the configuration ids of its cards in the live registry and in any staged
        registry upload that has a content set (contract v1.14, §22 note configuration_not_in_registry)."""
        set_ids = [live_set_id] if live_set_id is not None else []
        set_ids += [
            set_id
            for (set_id,) in conn.execute(f"SELECT set_id FROM uploads WHERE kind = 'models' AND status IN {_STAGED_SQL} AND set_id IS NOT NULL")
        ]
        found: dict[str, set[str]] = {}
        for set_id in set_ids:
            for model_version, configuration_id in conn.execute(
                "SELECT model_version, configuration_id FROM use_case_variants WHERE set_id = ? AND configuration_id IS NOT NULL", (set_id,)
            ):
                found.setdefault(model_version, set()).add(configuration_id)
        return {model_version: frozenset(ids) for model_version, ids in found.items()}

    def _run_check(self, upload_id: str) -> None:
        try:
            self._check(upload_id)
        except Exception:  # noqa: BLE001 (a background thread must not die silently)
            log.exception("Checking upload %s failed", upload_id)
            issues = Issues()
            issues.add("unreadable_file", 0, "The check stopped because of an internal error; try uploading the file again.")
            self._finish(upload_id, issues.report(0), None, None, [])
        finally:
            self._progress.pop(upload_id, None)
            self._cancelled.discard(upload_id)

    def _set_progress(self, upload_id: str, share: float) -> None:
        self._progress[upload_id] = share

    def _check(self, upload_id: str) -> None:
        conn = self._connect()
        try:
            record = self._record(conn, upload_id)
            if record is None or record.status != "checking":
                return
            live = Dataset(conn)
            if record.kind == "model_cards":
                self._check_model_card(conn, live, record)
                return
            if record.kind == EVALUATION_RESULTS_KIND:
                self._check_evaluation(conn, live, record)
                return
            context = self._upload_context(conn, live, record)
            self._set_progress(upload_id, 0.02)
            try:
                with open_table(self.source_path(record), record.file_format) as table:
                    result = check_upload(
                        table,
                        record.kind,
                        context,
                        target=record.target,
                        progress=lambda share: self._set_progress(upload_id, 0.02 + 0.83 * share),
                        cancelled=lambda: upload_id in self._cancelled,
                    )
            except UnreadableFile as error:
                issues = Issues()
                issues.add("unreadable_file", 0, str(error))
                self._finish(upload_id, issues.report(0), None, None, [])
                return
            except Cancelled:
                return
            directory = self.upload_dir(upload_id)
            if record.kind == "models" and directory.is_dir():
                variants = result.content.variants() if result.content else result.extra.get("variants", [])
                (directory / "variants.json").write_text(json.dumps(variants), encoding="utf-8")
            self._set_progress(upload_id, 0.88)
            report = result.report()
            if record.origin == "records":
                report = _with_record_indexes(report)
            self._finish(upload_id, report, result.content, conn, result.issues.marks, result.issues.marks_truncated)
        finally:
            conn.close()

    def _finish(
        self,
        upload_id: str,
        report: dict,
        content: contents.Content | None,
        conn: sqlite3.Connection | None,
        marks: list[Mark],
        truncated: bool = False,
        *,
        valid: bool = False,
    ) -> None:
        """Store the check's result, and the staged set of a valid upload, in one transaction.

        ``valid`` marks an upload valid without a content set: an evaluation
        results file (contract v1.14, §32.2), which publishes nothing.

        A file that looks like patient-level data (CONTRACT.md §21) is deleted
        here, with everything kept beside it; the upload stays as invalid with
        its problems, and its report keeps no cell of the file."""
        directory = self.upload_dir(upload_id)
        patient_level = content is None and is_patient_level(report)
        if patient_level:
            report = without_cells(report)
            marks = []
        elif directory.is_dir():
            (directory / "marks.json").write_text(
                json.dumps({"truncated": truncated, "marks": [[m.row, m.column, m.problem, m.blocking] for m in marks]}),
                encoding="utf-8",
            )
        own = conn is None
        conn = conn or self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            try:
                status = conn.execute("SELECT status FROM uploads WHERE upload_id = ?", (upload_id,)).fetchone()
                if status is None or status[0] != "checking":
                    conn.execute("ROLLBACK")  # discarded or replaced meanwhile
                    return
                if self._base_moved(conn, upload_id, content):
                    # A publish or rollback replaced the live set while this merge was
                    # checked; _recheck_after skipped it (still checking). Check again.
                    conn.execute("ROLLBACK")
                    self._progress[upload_id] = 0.0
                    self._executor.submit(self._run_check, upload_id)
                    return
                set_id = None
                if content is not None:
                    set_id = contents.insert_content_set(
                        conn, content, source=f"upload:{upload_id}", created_at=db.utc_now(), meta={"upload_id": upload_id}
                    )
                conn.execute(
                    "UPDATE uploads SET status = ?, progress = 1, report_json = ?, set_id = ?, checked_at = ? "
                    "WHERE upload_id = ?",
                    ("valid" if content is not None or valid else "invalid", json.dumps(report), set_id, db.utc_now(), upload_id),
                )
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
        finally:
            if own:
                conn.close()
            if patient_level:
                shutil.rmtree(directory, ignore_errors=True)

    @staticmethod
    def _base_moved(conn: sqlite3.Connection, upload_id: str, content: contents.Content | None) -> bool:
        """Whether a merge upload's base set is no longer the live set it applies to."""
        merge = getattr(content, "merge", None)
        if merge is None:
            return False
        record = UploadRecord.from_row(conn.execute(f"SELECT {_RECORD_COLUMNS} FROM uploads WHERE upload_id = ?", (upload_id,)).fetchone())
        return merge.base_set_id != contents.set_id_of(repository.load_state(conn), record.kind, record.key)

    def _check_model_card(self, conn: sqlite3.Connection, live: Dataset, record: UploadRecord) -> None:
        """Check a narrow model card (contract v1.13, §26): parse it, and on
        success merge it into the live narrow model cards."""
        source_format = "json" if record.file_format == "json" else "markdown"
        issues = Issues()
        try:
            text = self.source_path(record).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            issues.add("unreadable_file", 0, "The card is not UTF-8 text.", mark=False)
            self._finish(record.upload_id, issues.report(0), None, None, [])
            return
        card, problems = model_cards.parse_card(text, source_format, record.model_version)
        for code, problem, line in problems.errors + problems.notes:
            issues.add(code, line, problem, mark=False)
        model_versions = {model.model_version for model in live.registry.models}
        staged = {model for model, _ in self._staged_registry_variants(conn)}
        if record.model_version not in model_versions | staged:
            issues.add("unknown_target", 0, f"The registry has no AI system {record.model_version!r}.", column="model_version", value=record.model_version, mark=False)
        elif record.model_version not in model_versions:
            issues.add("target_not_published", 0, f"{record.model_version} is only in a staged update of AI systems & functions.", mark=False)
        for result in (card or {}).get("results", []):
            for code in result.get("icd11_codes") or []:
                concept = live.atlas.by_id.get(code)
                if concept is None or concept.level != 2:
                    issues.add("unknown_result_code", 0, f"{code} is not an ICD-11 condition in the atlas.", value=code, mark=False)
        content = None
        if card is not None and not issues.has_errors:
            base_set = live.state.model_cards_set_id
            cards = {stored.model_version: stored for stored in repository.load_model_cards(conn, base_set)}
            cards[record.model_version] = repository.ModelCardRecord(
                record.model_version, source_format, card, text if source_format == "markdown" else None, record.created_at
            )
            content = contents.ModelCardsContent(list(cards.values()), merge=contents.MergeInfo(base_set, 1))
        rows = len((card or {}).get("results", [])) or 1
        self._finish(record.upload_id, issues.report(rows), content, conn, [])

    def _recheck_staged_registries(self) -> None:
        """Check staged registry uploads again (they depend on which functions have metrics)."""
        with self._lock:
            conn = self._connection()
            rows = conn.execute(
                "SELECT upload_id, set_id FROM uploads WHERE kind = 'models' AND status IN ('invalid', 'valid') AND mode = 'replace'"
            ).fetchall()
        self._recheck(rows)

    def _recheck_after(self, kinds: tuple[str, ...]) -> None:
        """After a publish or rollback that changed ``kinds``: check staged
        uploads again whose check depends on them. Registry uploads depend on
        metrics; safety and studies uploads on the registry (their cards and
        model versions must exist), studies also on the local populations (a
        hospital study names one, §26.1); effects uploads (contract v1.13,
        §27) on the registry and the studies (their cards and studies must
        exist, and a study's design decides the appraisal tool); local results
        on the studies, populations, and registry; narrow model cards on the
        registry; merge uploads on the live set they were applied to."""
        if "metrics" in kinds:
            self._recheck_staged_registries()
        with self._lock:
            conn = self._connection()
            live = repository.load_state(conn)
            rows = []
            for row in conn.execute(
                f"SELECT {_RECORD_COLUMNS} FROM uploads "
                "WHERE status IN ('invalid', 'valid') AND (mode = 'merge' OR kind IN "
                "('safety', 'studies', 'effects', 'local_metrics', 'model_cards', 'evaluation_results'))"
            ).fetchall():
                record = UploadRecord.from_row(row)
                kind = record.kind
                # Evaluation results (v1.14, §32.2) name a card and compare with its measure and configuration.
                if kind in ("safety", "studies", "effects", "model_cards", EVALUATION_RESULTS_KIND) and "models" in kinds:
                    rows.append((record.upload_id, record.set_id))
                elif kind == "effects" and "studies" in kinds:
                    rows.append((record.upload_id, record.set_id))
                elif kind == "studies" and "population" in kinds:
                    # A hospital study names a published local population (§26.1).
                    rows.append((record.upload_id, record.set_id))
                elif kind == "local_metrics" and {"studies", "population", "models"} & set(kinds):
                    # Local results name a hospital study of a published population (§26).
                    rows.append((record.upload_id, record.set_id))
                elif record.mode == "merge" and kind in kinds and _base_of(conn, record.set_id) != contents.set_id_of(live, kind, record.key):
                    rows.append((record.upload_id, record.set_id))
        self._recheck(rows)

    def _recheck(self, rows: list[tuple[str, int | None]]) -> None:
        """Queue staged uploads for another check (status ``checking``)."""
        if not rows:
            return
        with self._lock:
            conn = self._connection()
            for upload_id, set_id in rows:
                conn.execute("BEGIN IMMEDIATE")
                try:
                    conn.execute(
                        "UPDATE uploads SET status = 'checking', progress = 0, report_json = NULL, set_id = NULL "
                        "WHERE upload_id = ?",
                        (upload_id,),
                    )
                    if set_id is not None:
                        contents.delete_content_set(conn, set_id)
                    conn.execute("COMMIT")
                except BaseException:
                    conn.execute("ROLLBACK")
                    raise
                self._progress[upload_id] = 0.0
                self._executor.submit(self._run_check, upload_id)

    # -------------------------------------------------------------- reads

    def staged_state(self, upload_id: str) -> "StagedRead":
        """The live version with this valid upload's set swapped in; marks it previewed."""
        with self._lock:
            record = self._require(upload_id)
            _require_data_set(record)
            if record.status != "valid":
                raise AdminError(
                    409,
                    "upload_not_valid",
                    f"Upload {upload_id} is {record.status}; only a valid staged upload can be previewed.",
                )
            conn = self._connection()
            live = repository.load_state(conn)
            self._require_current_base(conn, record, live)
            if not record.previewed:
                conn.execute("UPDATE uploads SET previewed = 1 WHERE upload_id = ?", (upload_id,))
            return StagedRead(versions.swap(live, record.kind, record.key, record.set_id), record.set_id)

    def changes(self, upload_id: str) -> dict:
        with self._lock:
            record = self._require(upload_id)
            _require_data_set(record)
            if record.status != "valid":
                raise AdminError(409, "upload_not_valid", f"Upload {upload_id} is {record.status}; only a valid upload has changes to review.")
            live = repository.load_state(self._connection())
            self._require_current_base(self._connection(), record, live)
            cached = self._changes.get((upload_id, live.version_id, record.set_id))
        if cached is not None:
            return cached
        conn = db.connect(self.db_path, read_only=True)
        try:
            summary = change_summaries.change_summary(
                conn,
                upload_id=upload_id,
                kind=record.kind,
                target=record.key,
                staged_set=record.set_id,
                live_state=live,
                staged_state=versions.swap(live, record.kind, record.key, record.set_id),
            )
        finally:
            conn.close()
        with self._lock:
            self._changes[(upload_id, live.version_id, record.set_id)] = summary
        return summary

    def annotated(self, upload_id: str, file_format: str, out_dir: Path) -> tuple[Path, str]:
        """Write the annotated copy into ``out_dir``; returns the path and a download name."""
        with self._lock:
            record = self._require(upload_id)
        if record.status == "checking":
            raise AdminError(409, "upload_not_valid", f"Upload {upload_id} is still being checked.")
        if is_patient_level(record.report):
            raise AdminError(409, "upload_not_staged", PATIENT_LEVEL_DELETED)
        if record.file_format not in ("csv", "xlsx"):
            # Narrow model cards and evaluation results are documents, not tables: no checked copy.
            raise AdminError(409, "upload_not_valid", "This upload has no checked copy; its problems are listed in its report.")
        source = self.source_path(record)
        marks_file = self.upload_dir(upload_id) / "marks.json"
        if not source.is_file() or not marks_file.is_file():
            raise AdminError(409, "upload_not_staged", f"Upload {upload_id} is {record.status}; its file is no longer kept.")
        stored = json.loads(marks_file.read_text(encoding="utf-8"))
        marks = [Mark(*mark) for mark in stored["marks"]]
        path = out_dir / f"annotated.{file_format}"
        report = record.report or {"errors": [], "notes": []}
        try:
            files.write_annotated(
                path,
                file_format,
                source=source,
                source_format=record.file_format,
                kind=record.kind,
                report=report,
                marks=marks,
                truncated=stored["truncated"],
            )
        except UnreadableFile as error:
            raise AdminError(409, "upload_not_valid", f"The uploaded file cannot be read: {error}") from error
        stem = Path(record.filename).stem or "upload"
        return path, f"{stem}-checked.{file_format}"

    # ---------------------------------------------------- publish/rollback

    def _begin_publish(self) -> None:
        if not self._publish_lock.acquire(blocking=False):
            raise AdminError(409, "publish_in_progress", "Another publish or rollback is running. Try again in a moment.")

    def _require_current_base(self, conn: sqlite3.Connection, record: UploadRecord, live: DatasetState) -> None:
        """A merge upload applies to the live set it was checked against (409 otherwise)."""
        if record.mode != "merge" or record.set_id is None:
            return
        if _base_of(conn, record.set_id) != contents.set_id_of(live, record.kind, record.key):
            raise AdminError(
                409,
                "upload_outdated",
                f"The live {title_in_sentence(record.kind)} changed after upload {record.upload_id} was checked. "
                "It is being checked again on the new data; review it once the check has finished.",
            )

    def publish(
        self,
        upload_id: str,
        previewed: bool,
        *,
        note: str | None = None,
        role: str | None = None,
        publisher_name: str | None = None,
        _submission: str | None = None,
    ) -> dict:
        """Publish a valid upload as the next version, with an optional change
        note (contract v1.7) stored on the version, and (v1.13, §26) the
        workspace role and name it was published in. An upload of a developer
        submission is published only by accepting the submission."""
        note = clean_note(note)
        role, publisher_name = clean_publisher(role, publisher_name)
        self._begin_publish()
        try:
            if _submission is None:
                # Checked inside the publish slot, so publishes sent at once meet publish_in_progress first.
                with self._lock:
                    existing = self._require(upload_id)
                if existing.submission_id is not None:
                    raise AdminError(
                        409,
                        "submission_upload",
                        f"Upload {upload_id} belongs to developer submission {existing.submission_id}; "
                        "it is published when a custodian accepts the submission in Custodian review.",
                    )
            summary = self.changes(upload_id)
            with self._lock:
                record = self._require(upload_id)
                if record.status != "valid":
                    raise AdminError(409, "upload_not_valid", f"Upload {upload_id} is {record.status}; only a valid upload can be published.")
                conn = self._connection()
                conn.execute("BEGIN IMMEDIATE")
                try:
                    live = repository.load_state(conn)
                    self._require_current_base(conn, record, live)
                    state = versions.swap(live, record.kind, record.key, record.set_id)
                    self._check_publishable(conn, record, state)
                    version_id = versions.insert_version(
                        conn,
                        state=state,
                        kind=record.kind,
                        summary=change_summaries.describe(summary, record.title),
                        created_at=db.utc_now(),
                        upload_id=upload_id,
                        previewed=previewed or record.previewed,
                        note=note,
                        publisher_role=role,
                        publisher_name=publisher_name,
                    )
                    updated = conn.execute(
                        "UPDATE uploads SET status = 'published', published_version = ? WHERE upload_id = ? AND status = 'valid'",
                        (version_id, upload_id),
                    ).rowcount
                    if updated != 1:
                        raise AdminError(409, "upload_not_valid", f"Upload {upload_id} changed while publishing.")
                    conn.execute("COMMIT")
                except BaseException:
                    conn.execute("ROLLBACK")
                    raise
                entry = versions.version_entry(conn, version_id)
        finally:
            self._publish_lock.release()
        log.info("Published version %s from upload %s", version_id, upload_id)
        self._notify()
        self._recheck_after((record.kind,))
        return entry

    def _check_publishable(self, conn: sqlite3.Connection, record: UploadRecord, state: DatasetState) -> None:
        if record.kind == "models":
            try:
                versions.check_consistent(conn, state)
            except versions.PublishConflict as error:
                raise AdminError(409, "upload_outdated", f"{error} Upload AI systems & functions again after publishing their metrics.") from error
        elif record.kind == "local_metrics" and record.population_id not in state.population_sets:
            raise AdminError(
                409, "upload_outdated", f"The local population {record.population_id} is no longer published. Publish it again, then these results."
            )
        elif record.target is not None:
            registry = contents.load_registry(conn, state.registry_set_id)
            if record.target not in registry.variants():
                if record.target not in self._staged_registry_variants(conn):
                    raise AdminError(
                        409,
                        "upload_outdated",
                        f"The registry no longer lists the card {record.target[0]} / {record.target[1]}. Upload the file again.",
                    )

    def _staged_registry_variants(self, conn: sqlite3.Connection) -> set[tuple[str, str]]:
        """Model × use case pairs of a staged registry upload (valid or not)."""
        variants: set[tuple[str, str]] = set()
        for (upload_id,) in conn.execute(f"SELECT upload_id FROM uploads WHERE kind = 'models' AND status IN {_STAGED_SQL}"):
            path = self.upload_dir(upload_id) / "variants.json"
            if path.is_file():
                variants.update(tuple(variant) for variant in json.loads(path.read_text(encoding="utf-8")))
        return variants

    def rollback(
        self,
        version_id: int,
        kind: str | None = None,
        *,
        note: str | None = None,
        every_kind: bool = False,
        role: str | None = None,
        publisher_name: str | None = None,
    ) -> dict:
        note = clean_note(note)
        role, publisher_name = clean_publisher(role, publisher_name)
        if every_kind and kind:
            raise AdminError(422, "invalid_rollback", "Choose one data set (kind) or every data set (every_kind), not both.")
        self._begin_publish()
        try:
            with self._lock:
                conn = self._connection()
                conn.execute("BEGIN IMMEDIATE")
                try:
                    target = versions.version_entry(conn, version_id)
                    if target is None:
                        raise AdminError(404, "unknown_version", f"There is no version {version_id}.")
                    if every_kind:
                        kinds = DATASET_KINDS
                    else:
                        kinds = (kind,) if kind else ((target["kind"],) if target["kind"] else DATASET_KINDS)
                    live = repository.load_state(conn)
                    state = versions.restore(live, repository.load_state(conn, version_id), kinds)
                    names = ", ".join(title_in_sentence(name) for name in kinds) if len(kinds) < len(DATASET_KINDS) else "all data sets"
                    if state == live:
                        # Contract v1.11: a restore that changes nothing adds no version.
                        raise AdminError(
                            409,
                            "rollback_no_change",
                            f"Restoring {names} to version {version_id} would change nothing: the live data already matches it. "
                            "Choose another version, or restore another data set (or all of them).",
                        )
                    try:
                        versions.check_consistent(conn, state)
                    except versions.PublishConflict as error:
                        raise AdminError(
                            409,
                            "rollback_conflict",
                            f"{error} Roll back AI systems & functions first, or roll back to a later version.",
                        ) from error
                    new_id = versions.insert_version(
                        conn,
                        state=state,
                        kind=kinds[0] if len(kinds) == 1 else None,
                        summary=f"Rolled back {names} to version {version_id}.",
                        created_at=db.utc_now(),
                        rollback_of=version_id,
                        note=note,
                        publisher_role=role,
                        publisher_name=publisher_name,
                    )
                    conn.execute("COMMIT")
                except BaseException:
                    conn.execute("ROLLBACK")
                    raise
                entry = versions.version_entry(conn, new_id)
        finally:
            self._publish_lock.release()
        log.info("Rolled back to version %s as version %s", version_id, new_id)
        self._notify()
        # Staged registry uploads are always checked again after a rollback, as before v1.7.
        self._recheck_after((*kinds, "metrics"))
        return entry

    def remove_population(
        self, population_id: str, *, note: str | None = None, role: str | None = None, publisher_name: str | None = None
    ) -> dict:
        """Publish a version without the local population ``population_id``
        (contract v1.10), and without its local results (v1.13). Its earlier
        versions stay in history, so a rollback can bring it back."""
        note = clean_note(note)
        role, publisher_name = clean_publisher(role, publisher_name)
        self._begin_publish()
        try:
            with self._lock:
                conn = self._connection()
                conn.execute("BEGIN IMMEDIATE")
                try:
                    live = repository.load_state(conn)
                    set_id = live.population_sets.get(population_id)
                    if set_id is None:
                        raise AdminError(404, "unknown_population", "There is no published local population with this population_id.")
                    name = repository.population_names(conn, [set_id]).get(set_id, population_id)
                    new_id = versions.insert_version(
                        conn,
                        state=versions.without_population(live, population_id),
                        kind="population",
                        summary=f"Removed the local population {name} ({population_id}).",
                        created_at=db.utc_now(),
                        note=note,
                        publisher_role=role,
                        publisher_name=publisher_name,
                    )
                    conn.execute("COMMIT")
                except BaseException:
                    conn.execute("ROLLBACK")
                    raise
                entry = versions.version_entry(conn, new_id)
        finally:
            self._publish_lock.release()
        log.info("Removed population %s as version %s", population_id, new_id)
        self._notify()
        self._recheck_after(("population",))
        return entry

    def list_versions(self, kind: str | None = None) -> list[dict]:
        with self._lock:
            return versions.list_versions(self._connection(), kind)

    def datasets(self) -> list[dict]:
        with self._lock:
            conn = self._connection()
            return versions.dataset_infos(conn, self._set_counts, self._staged_ids(conn))

    # ------------------------------------------------------------ templates

    def template(
        self,
        kind: str,
        file_format: str,
        out_dir: Path,
        *,
        filled: bool = False,
        model_version: str | None = None,
        use_case: str | None = None,
        population_id: str | None = None,
    ) -> tuple[Path, str]:
        """Write a template (blank, or with the live data) into ``out_dir``.

        A filled population template (contract v1.10) holds that population's
        tiers with ``population_id``, else the default prevalence as a starting
        point for a new local set."""
        if kind == "model_cards":
            raise AdminError(422, "invalid_parameter", "Narrow model cards are JSON or Markdown files; the Data Library shows a JSON example.")
        with self._lock:
            self._connection()
        conn = db.connect(self.db_path, read_only=True)
        try:
            live = Dataset(conn)
            target = None
            content = None
            sources = None
            if filled:
                if kind in TARGETED_KINDS:
                    if not model_version or not use_case:
                        raise AdminError(422, "invalid_parameter", f"A filled {kind} template needs model_version and use_case.")
                    try:
                        live.metrics(model_version, use_case)
                    except (UnknownModel, UnknownUseCase) as error:
                        raise AdminError(404, error.code, str(error)) from error
                    target = (model_version, use_case)
                if kind == "local_metrics":
                    if not population_id:
                        raise AdminError(422, "invalid_parameter", "A filled local results template needs population_id.")
                    target = (model_version, use_case)
                    set_id = live.state.local_metric_sets.get((model_version, use_case, population_id))
                    content = contents.load_content(conn, kind, set_id, (*target, population_id)) if set_id is not None else None
                elif kind == "population" and population_id:
                    set_id = live.state.population_sets.get(population_id)
                    if set_id is None:
                        raise AdminError(404, "unknown_population", "There is no published local population with this population_id.")
                    content = contents.load_content(conn, kind, set_id, population_id)
                elif kind == "population":
                    set_id = live.state.prevalence_set_id  # the default tiers, to edit into a local set
                    content = contents.load_content(conn, "prevalence", set_id)
                else:
                    set_id = contents.set_id_of(live.state, kind, target)
                    content = contents.load_content(conn, kind, set_id, target) if set_id is not None else None
                sources = (
                    contents.load_sources(conn, kind, set_id)
                    if set_id is not None and kind in ("metrics", "prevalence", "population", "local_metrics")
                    else None
                )
            warning_codes = {
                code for (codes_json,) in conn.execute("SELECT codes_json FROM warning_sets") for code in json.loads(codes_json)
            } | set(safety.WARNING_RELEVANCE)
            path = out_dir / f"template.{file_format}"
            rows = files.data_rows(content, live.atlas, sources if filled else None)
            if file_format == "xlsx":
                files.write_template_xlsx(path, kind, rows, live.atlas, warning_codes)
            else:
                files.write_template_csv(path, kind, rows)
            name = files.template_filename(
                kind,
                file_format,
                target=(
                    (*target, population_id) if kind == "local_metrics" and target
                    else target or ((population_id,) if kind == "population" and filled and population_id else None)
                ),
                version=live.version_id if filled else None,
            )
            return path, name
        finally:
            conn.close()


# ------------------------------------------------------------------ helpers

def _require_data_set(record: UploadRecord) -> None:
    """An evaluation results upload (contract v1.14, §32.2) has no staged set: no staged read,
    change summary, or publish (409 ``upload_not_valid``)."""
    if record.kind == EVALUATION_RESULTS_KIND:
        raise AdminError(
            409,
            "upload_not_valid",
            "Evaluation results publish nothing themselves: stage their proposed study and metrics records, "
            "then review and publish those.",
        )


def _target(record: UploadRecord) -> dict | None:
    """openapi.json ``UploadTarget``: the card, or (contract v1.10) the population;
    (v1.13) local results name both, a narrow model card its AI system."""
    if record.kind == "population":
        return {"population_id": record.population_id, "population_name": record.population_name}
    if record.kind == "local_metrics":
        return {"model_version": record.model_version, "use_case": record.use_case, "population_id": record.population_id}
    if record.kind == "model_cards":
        return {"model_version": record.model_version}
    if record.kind == EVALUATION_RESULTS_KIND:
        # The card the file names (contract v1.14, §32.2), or null when it names none.
        return {"model_version": record.model_version, "use_case": record.use_case} if record.model_version else None
    return {"model_version": record.model_version, "use_case": record.use_case} if record.target else None


def clean_publisher(role: str | None, name: str | None) -> tuple[str | None, str | None]:
    """The workspace role and name a publish records (contract v1.13, §26; no
    login: both are the publisher's own choice). A developer submits and never
    publishes."""
    if role is not None and role not in PUBLISHER_ROLES:
        raise AdminError(422, "invalid_parameter", f"role must be one of {', '.join(PUBLISHER_ROLES)}.")
    if role == "developer":
        raise AdminError(
            422, "invalid_parameter", "A developer submits for review and does not publish; choose Custodian review, Hospital administration, or Maintainer."
        )
    text = " ".join((name or "").split())
    if len(text) > MAX_PUBLISHER_NAME:
        raise AdminError(422, "invalid_parameter", f"The name has {len(text)} characters; at most {MAX_PUBLISHER_NAME} are allowed.")
    return role, text or None


def _record_cell(value: object) -> object:
    """A JSON record value as a CSV cell."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return YES if value else NO
    if isinstance(value, float):
        return repr(value)
    return value


def _with_record_indexes(report: dict) -> dict:
    """A records upload's report, each example with its record index (row − 2)."""
    def mapped(groups: list[dict]) -> list[dict]:
        return [
            {**group, "examples": [{**example, **({"record": example["row"] - 2} if example["row"] >= 2 else {})} for example in group["examples"]]}
            for group in groups
        ]

    return {**report, "errors": mapped(report["errors"]), "notes": mapped(report["notes"])}


def _base_of(conn: sqlite3.Connection, set_id: int | None) -> int | None:
    """The live set a merge upload's content set was applied to."""
    if set_id is None:
        return -1  # an invalid merge upload has no set: always check it again
    row = conn.execute("SELECT meta_json FROM content_sets WHERE set_id = ?", (set_id,)).fetchone()
    return json.loads(row[0]).get("base_set_id") if row else -1


def _merge_base(conn: sqlite3.Connection, live: DatasetState, record: UploadRecord) -> MergeBase:
    """The live set a merge upload applies to, with lookups of its stored rows."""
    set_id = contents.set_id_of(live, record.kind, record.key)
    if record.kind == "models":
        return MergeBase(set_id)
    if record.kind == "safety":
        return MergeBase(set_id, incidents=tuple(repository.load_incidents(conn, set_id)))
    if record.kind == "studies":
        return MergeBase(set_id, studies=tuple(repository.load_studies(conn, set_id)))
    if record.kind == "effects":
        return MergeBase(set_id, effects=tuple(repository.load_effects(conn, set_id)))
    if set_id is None:
        return MergeBase(None)
    sources = repository.provenance_sources(conn)
    default_date = sources[repository.default_provenance_id(conn, set_id)].date
    if record.kind in ("metrics", "local_metrics"):
        table, provenance, columns = "metric_rows", "metric_row_provenance", ("combo_idx", "concept_id")
        combos = tuple(combo for (combo,) in conn.execute("SELECT combo_idx FROM set_combos WHERE set_id = ? ORDER BY position", (set_id,)))
    else:
        table, provenance, columns = "prevalence_tiers", "prevalence_provenance", ("code",)
        combos = ()
    keys_sql = ", ".join(f"r.{column}" for column in columns)
    join = " AND ".join(f"p.{column} = r.{column}" for column in columns)
    select = f"SELECT {keys_sql}, p.provenance_id FROM {table} r LEFT JOIN {provenance} p ON p.set_id = r.set_id AND {join} WHERE r.set_id = ?"

    def as_key(row: tuple):
        return tuple(row[:-1]) if len(columns) > 1 else row[0]

    def date_of(provenance_id: int | None) -> str | None:
        return sources[provenance_id].date if provenance_id is not None else default_date

    def stored_dates(keys: list) -> dict:
        if not keys:
            return {}
        if len(keys) > 500:  # one scan instead of many lookups
            wanted = set(keys)
            return {as_key(row): date_of(row[-1]) for row in conn.execute(select, (set_id,)) if as_key(row) in wanted}
        match = " AND ".join(f"r.{column} = ?" for column in columns)
        found = {}
        for key in keys:
            row = conn.execute(f"{select} AND {match}", (set_id, *(key if len(columns) > 1 else (key,)))).fetchone()
            if row is not None:
                found[key] = date_of(row[-1])
        return found

    return MergeBase(set_id, stored_dates, combos)
