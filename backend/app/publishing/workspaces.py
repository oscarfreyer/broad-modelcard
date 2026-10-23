"""Role workspaces, developer submissions, the instance profile, and narrow
model card proposals (contract v1.13, CONTRACT.md §26).

There is no login: a workspace (Developer submission, Custodian review,
Hospital administration, Maintainer) is the user's choice, and a publish
records that role and an entered name on the version.

* **Submissions.** A developer's staged uploads (an AI system's registry
  entry, a narrow model card, studies, a metrics file) are grouped in one
  submission and never publish on their own (``publishUpload`` answers 409
  ``submission_upload``). A custodian accepts the submission, which
  publishes its uploads one version each in the order the store's rules need
  (``SUBMISSION_ORDER``: a new card's metrics before its registry row), each
  with the custodian's note, role, and name; or returns it with a note, which
  discards its staged uploads (the developer submits again).
* **Instance profile.** One row: a public service or a hospital version, the
  organisation, who maintains it, and an optional contact. ``/meta``
  serves it.
* **Proposals.** A narrow model card's results with ICD-11 codes become
  proposed metric records for the custodian or a maintainer to stage as a merge upload (the
  records upload, §11.4). Nothing is staged or published here.

All data is synthetic demonstration data.
"""

from __future__ import annotations

import json
import secrets
import sqlite3
from contextlib import contextmanager

from .. import db, repository
from ..schema.contract import (
    EVALUATION_RESULTS_KIND,
    INSTANCE_KINDS,
    MAX_INSTANCE_CONTACT,
    MAX_INSTANCE_DATA_PROTECTION_NOTE,
    MAX_INSTANCE_TEXT,
    MAX_NOTE,
    MAX_PUBLISHER_NAME,
    reserved_in_name,
)
from ..services.dataset import Dataset
from ..services.types import ALL_POPULATIONS
from . import model_cards

_SUBMISSION_COLUMNS = (
    "submission_id, developer_name, model_version, created_at, status, note, custodian_note, decided_by, decided_at, versions_json"
)


def _clean_text(value: str | None, field: str, limit: int, *, required: bool = False) -> str | None:
    from .uploads import AdminError

    text = " ".join((value or "").split())
    if required and not text:
        raise AdminError(422, "invalid_parameter", f"{field} is required.")
    if len(text) > limit:
        raise AdminError(422, "invalid_parameter", f"{field} has {len(text)} characters; at most {limit} are allowed.")
    return text or None


class WorkspaceMixin:
    """Mixed into ``AdminService`` (app/publishing/uploads.py)."""

    # ------------------------------------------------------------- instance

    def instance(self) -> dict:
        with self._lock:
            return repository.load_instance(self._connection())

    def update_instance(
        self,
        *,
        kind: str,
        organisation: str,
        maintained_by: str,
        contact: str | None = None,
        data_protection_note: str | None = None,
    ) -> dict:
        """Set the instance profile (contract v1.13, §26; the data-protection
        note since v1.14). Not a dataset version: it describes who runs this
        copy of the tool, not the data. A field left out is cleared."""
        from .uploads import AdminError

        if kind not in INSTANCE_KINDS:
            raise AdminError(422, "invalid_parameter", "kind must be public or hospital.")
        organisation = _clean_text(organisation, "organisation", MAX_INSTANCE_TEXT, required=True)
        maintained_by = _clean_text(maintained_by, "maintained_by", MAX_INSTANCE_TEXT, required=True)
        contact = _clean_text(contact, "contact", MAX_INSTANCE_CONTACT)
        note = _clean_text(data_protection_note, "data_protection_note", MAX_INSTANCE_DATA_PROTECTION_NOTE)
        with self._lock:
            conn = self._connection()
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.execute(
                    "INSERT INTO instance_profile (profile_id, kind, organisation, maintained_by, contact, data_protection_note, "
                    "updated_at) VALUES (1, ?, ?, ?, ?, ?, ?) ON CONFLICT (profile_id) DO UPDATE SET kind = excluded.kind, "
                    "organisation = excluded.organisation, maintained_by = excluded.maintained_by, contact = excluded.contact, "
                    "data_protection_note = excluded.data_protection_note, updated_at = excluded.updated_at",
                    (kind, organisation, maintained_by, contact, note, db.utc_now()),
                )
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            profile = repository.load_instance(conn)
        self._notify()
        return profile

    # ---------------------------------------------------------- submissions

    def _submission_row(self, conn: sqlite3.Connection, submission_id: str) -> tuple | None:
        return conn.execute(f"SELECT {_SUBMISSION_COLUMNS} FROM submissions WHERE submission_id = ?", (submission_id,)).fetchone()

    def _require_open_submission(self, submission_id: str) -> None:
        from .uploads import AdminError

        with self._lock:
            row = self._submission_row(self._connection(), submission_id)
        if row is None:
            raise AdminError(404, "unknown_submission", "There is no submission with this submission_id.")
        if row[4] != "submitted":
            raise AdminError(409, "submission_closed", f"Submission {submission_id} was {row[4]}; start a new submission.")

    def _submission_metric_targets(self, conn: sqlite3.Connection, submission_id: str) -> set[tuple[str, str]]:
        return {
            (model_version, use_case)
            for model_version, use_case in conn.execute(
                "SELECT model_version, use_case FROM uploads WHERE submission_id = ? AND kind = 'metrics' "
                "AND status IN ('checking', 'invalid', 'valid')",
                (submission_id,),
            )
        }

    def _submission_payload(self, conn: sqlite3.Connection, row: tuple) -> dict:
        """openapi.json ``Submission``."""
        from .uploads import UploadRecord, _RECORD_COLUMNS

        uploads = [
            self.as_api(UploadRecord.from_row(upload))
            for upload in conn.execute(
                f"SELECT {_RECORD_COLUMNS} FROM uploads WHERE submission_id = ? ORDER BY rowid", (row[0],)
            )
        ]
        return {
            "submission_id": row[0],
            "developer_name": row[1],
            "model_version": row[2],
            "created_at": row[3],
            "status": row[4],
            "note": row[5],
            "custodian_note": row[6],
            "decided_by": row[7],
            "decided_at": row[8],
            "published_versions": json.loads(row[9]),
            "uploads": uploads,
        }

    def create_submission(self, *, developer_name: str, model_version: str, note: str | None = None) -> dict:
        """Open a developer submission (status ``submitted``). Its uploads join it
        with ``submission_id`` and wait for a custodian."""
        developer_name = _clean_text(developer_name, "developer_name", MAX_PUBLISHER_NAME, required=True)
        model_version = _clean_text(model_version, "model_version", 64, required=True)
        reserved = reserved_in_name(model_version)
        if reserved:
            # Card ids join it with a function by "|"; the comparison lists cards with "," (§11.1).
            from .uploads import AdminError

            raise AdminError(422, "invalid_parameter", f"model_version contains {' and '.join(reserved)}. Use a name without | or ,.")
        note = _clean_text(note, "note", MAX_NOTE)
        submission_id = f"sub-{secrets.token_hex(5)}"
        with self._lock:
            conn = self._connection()
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.execute(
                    "INSERT INTO submissions (submission_id, developer_name, model_version, created_at, status, note) "
                    "VALUES (?, ?, ?, ?, 'submitted', ?)",
                    (submission_id, developer_name, model_version, db.utc_now(), note),
                )
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            return self._submission_payload(conn, self._submission_row(conn, submission_id))

    def list_submissions(self, status: str | None = None) -> list[dict]:
        """Every submission, newest first (optionally of one status)."""
        with self._lock:
            conn = self._connection()
            rows = conn.execute(
                f"SELECT {_SUBMISSION_COLUMNS} FROM submissions "
                + ("WHERE status = ? " if status else "")
                + "ORDER BY created_at DESC, rowid DESC",
                (status,) if status else (),
            ).fetchall()
            return [self._submission_payload(conn, row) for row in rows]

    def get_submission(self, submission_id: str) -> dict:
        from .uploads import AdminError

        with self._lock:
            conn = self._connection()
            row = self._submission_row(conn, submission_id)
            if row is None:
                raise AdminError(404, "unknown_submission", "There is no submission with this submission_id.")
            return self._submission_payload(conn, row)

    def _decide(self, submission_id: str, status: str, note: str | None, name: str | None, versions: list[int]) -> None:
        with self._lock:
            conn = self._connection()
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.execute(
                    "UPDATE submissions SET status = ?, custodian_note = ?, decided_by = ?, decided_at = ?, versions_json = ? "
                    "WHERE submission_id = ?",
                    (status, note, name, db.utc_now(), json.dumps(versions), submission_id),
                )
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise

    def accept_submission(self, submission_id: str, *, note: str | None = None, publisher_name: str | None = None) -> dict:
        """Publish a submission's uploads (contract v1.13, §26), each as a
        version with the custodian's note, role ``custodian``, and name, in
        ``SUBMISSION_ORDER``. Every upload must be valid first (409
        ``submission_not_ready``), and each is valid again just before it is
        published (a publish can queue staged uploads for another check); if
        a later step fails, the versions already published stay, the
        submission stays ``submitted`` with the rest, and the 409 names them.
        One decision runs at a time (409 ``publish_in_progress``), so an
        accept never interleaves with another accept or a return."""
        from .uploads import clean_note, clean_publisher

        note = clean_note(note)
        _, publisher_name = clean_publisher("custodian", publisher_name)
        with self._deciding():
            return self._accept(submission_id, note, publisher_name)

    @contextmanager
    def _deciding(self):
        """The decision slot for submissions (accept or return); 409 ``publish_in_progress`` when taken."""
        from .uploads import AdminError

        if not self._decision_lock.acquire(blocking=False):
            raise AdminError(409, "publish_in_progress", "A submission is being accepted or returned. Try again in a moment.")
        try:
            yield
        finally:
            self._decision_lock.release()

    def _accept(self, submission_id: str, note: str | None, publisher_name: str | None) -> dict:
        from .uploads import SUBMISSION_ORDER, AdminError

        submission = self.get_submission(submission_id)
        if submission["status"] != "submitted":
            raise AdminError(409, "submission_closed", f"Submission {submission_id} was already {submission['status']}.")
        staged = [upload for upload in submission["uploads"] if upload["status"] in ("checking", "invalid", "valid")]
        if not staged:
            raise AdminError(409, "submission_not_ready", "This submission has no staged uploads to publish.")
        waiting = [upload for upload in staged if upload["status"] != "valid"]
        if waiting:
            names = ", ".join(f"{upload['kind']} ({upload['status']})" for upload in waiting)
            raise AdminError(409, "submission_not_ready", f"Every part must pass its check before the submission can be accepted: {names}.")
        # Evaluation results (contract v1.14, §32.2) publish nothing themselves: their proposed records,
        # staged into the submission as parts of their own, are what is published.
        evaluations = [upload for upload in staged if upload["kind"] == EVALUATION_RESULTS_KIND]
        staged = [upload for upload in staged if upload["kind"] != EVALUATION_RESULTS_KIND]
        if not staged:
            raise AdminError(
                409,
                "submission_not_ready",
                "The submission holds evaluation results only, which publish nothing themselves. "
                "Stage their proposed records into the submission first, or return it.",
            )
        staged.sort(key=lambda upload: SUBMISSION_ORDER.index(upload["kind"]) if upload["kind"] in SUBMISSION_ORDER else len(SUBMISSION_ORDER))
        published: list[int] = list(submission["published_versions"])
        for upload in staged:
            self.wait_for_checks()
            current = self.get_upload(upload["upload_id"])
            if current["status"] != "valid":
                self._decide(submission_id, "submitted", None, None, published)
                raise AdminError(
                    409,
                    "submission_not_ready",
                    f"After publishing versions {', '.join(map(str, published)) or 'none'}, the {current['kind']} part is "
                    f"{current['status']}; review it and accept again.",
                )
            try:
                entry = self.publish(
                    upload["upload_id"], bool(current["previewed"]), note=note, role="custodian",
                    publisher_name=publisher_name, _submission=submission_id,
                )
            except AdminError:
                # Keep the versions this call already published on the submission.
                if len(published) > len(submission["published_versions"]):
                    self._decide(submission_id, "submitted", None, None, published)
                raise
            published.append(entry["version_id"])
        self._close_evaluations([upload["upload_id"] for upload in evaluations])
        self._decide(submission_id, "accepted", note, publisher_name, published)
        return self.get_submission(submission_id)

    def _close_evaluations(self, upload_ids: list[str]) -> None:
        """Mark a submission's evaluation results parts done once it is accepted (status
        ``published``, without a version: their records were published as parts of their own)."""
        if not upload_ids:
            return
        with self._lock:
            conn = self._connection()
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.executemany("UPDATE uploads SET status = 'published' WHERE upload_id = ? AND status = 'valid'", [(upload_id,) for upload_id in upload_ids])
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise

    def return_submission(self, submission_id: str, *, note: str | None = None, publisher_name: str | None = None) -> dict:
        """Return a submission to its developer with a note: its staged uploads
        are discarded (nothing was published); the developer submits again."""
        from .uploads import AdminError, clean_note, clean_publisher

        note = clean_note(note)
        if note is None:
            raise AdminError(422, "invalid_parameter", "Say in a note what the developer should change.")
        _, publisher_name = clean_publisher("custodian", publisher_name)
        with self._deciding():
            submission = self.get_submission(submission_id)
            if submission["status"] != "submitted":
                raise AdminError(409, "submission_closed", f"Submission {submission_id} was already {submission['status']}.")
            for upload in submission["uploads"]:
                if upload["status"] in ("checking", "invalid", "valid"):
                    self.discard(upload["upload_id"])
            self._decide(submission_id, "returned", note, publisher_name, submission["published_versions"])
            return self.get_submission(submission_id)

    # ------------------------------------------------------------ proposals

    def model_card_proposals(self, upload_id: str) -> dict:
        """Metric records proposed from a staged narrow model card's results
        with ICD-11 codes (contract v1.13, §26): per card, records in the
        metrics template's keys for ``createRecordsUpload`` (a merge), and
        what was skipped. Nothing is staged or published."""
        from .uploads import AdminError

        with self._lock:
            record = self._require(upload_id)
            conn = self._connection()
            if record.kind != "model_cards":
                raise AdminError(409, "upload_not_valid", "Only a narrow model card upload has proposed records.")
            if record.status != "valid" or record.set_id is None:
                raise AdminError(409, "upload_not_valid", f"Upload {upload_id} is {record.status}; proposals need a valid card.")
            cards = {card.model_version: card for card in repository.load_model_cards(conn, record.set_id)}
            staged_variants = self._staged_registry_variants(conn)
        card = cards[record.model_version]
        reader = db.connect(self.db_path, read_only=True)
        try:
            live = Dataset(reader)
            registry = {model.model_version: model for model in live.registry.models}
            model = registry.get(record.model_version)
            if model is not None:
                use_cases = [variant.use_case for variant in model.use_cases]
                default = model.default_use_case or (use_cases[0] if use_cases else None)
            else:
                use_cases = [use_case for version, use_case in staged_variants if version == record.model_version]
                default = use_cases[0] if use_cases else None

            warning_sets = repository.WarningSets(reader)
            all_patients = live.atlas.axes.combo_index(ALL_POPULATIONS)
            # One reader per function: its all-patients rows load once, however many codes the card names.
            set_readers: dict[str, repository.MetricSetReader | None] = {}

            def stored_row(use_case: str, concept_id: str):
                if use_case not in set_readers:
                    set_id = live.state.metric_sets.get((record.model_version, use_case))
                    set_readers[use_case] = (
                        repository.MetricSetReader(reader, set_id, warning_sets, cache_size=1) if set_id is not None else None
                    )
                found = set_readers[use_case]
                return found.row(concept_id, all_patients) if found is not None else None

            batches, skipped = model_cards.proposed_records(
                card.card,
                model_version=record.model_version,
                use_cases=use_cases,
                default_use_case=default,
                atlas=live.atlas,
                stored_row=stored_row,
                source_date=card.card.get("date") or record.created_at[:10],
            )
        finally:
            reader.close()
        return {"upload_id": upload_id, "model_version": record.model_version, "batches": batches, "skipped": skipped}
