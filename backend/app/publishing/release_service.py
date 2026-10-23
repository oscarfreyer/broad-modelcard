"""The admin side of public release bundles (contract v1.13, CONTRACT.md §26):
export on a public instance; check, publish, or discard an import on a
hospital instance. The bundle format and the copy are in ``release.py``."""

from __future__ import annotations

import json
import shutil
import sqlite3
from pathlib import Path

from .. import db, repository
from ..schema.contract import PUBLIC_LAYER_KINDS
from . import release, versions
from .release import BundleError


class ReleaseMixin:
    """Mixed into ``AdminService`` (app/publishing/uploads.py)."""

    def release_dir(self, import_id: str) -> Path:
        return self.uploads_dir / "releases" / import_id

    # --------------------------------------------------------------- export

    def export_release(self, out_dir: Path) -> tuple[Path, str]:
        """Write the live public layers as a bundle into ``out_dir``; returns the
        path and a download name. A hospital instance does not export (409
        ``not_public_instance``): its public layers come from a public one."""
        from .uploads import AdminError

        with self._lock:
            conn = self._connection()
            instance = repository.load_instance(conn)
            version = repository.live_version_id(conn)
        if instance["kind"] != "public":
            raise AdminError(
                409, "not_public_instance", "Only a public instance exports public releases; this is a hospital version (see Instance)."
            )
        path = out_dir / "release.sqlite.gz"
        release.export_bundle(self.db_path, path, instance=instance)
        return path, f"broad-modelcard-public-release-v{version}.sqlite.gz"

    # --------------------------------------------------------------- import

    def _release_payload(self, row: tuple) -> dict:
        """openapi.json ``ReleaseImport``."""
        report = json.loads(row[4])
        return {
            "import_id": row[0],
            "filename": row[1],
            "created_at": row[2],
            "status": row[3],
            "release": report.get("release"),
            "problems": report.get("problems", []),
            "changes": report.get("changes"),
            "keeps": report.get("keeps"),
            "notes": report.get("notes", []),
            "published_version": row[5],
        }

    def _release_row(self, conn: sqlite3.Connection, import_id: str) -> tuple | None:
        return conn.execute(
            "SELECT import_id, filename, created_at, status, report_json, published_version FROM release_imports WHERE import_id = ?",
            (import_id,),
        ).fetchone()

    def get_release_import(self, import_id: str) -> dict:
        from .uploads import AdminError

        with self._lock:
            row = self._release_row(self._connection(), import_id)
        if row is None:
            raise AdminError(404, "unknown_import", "There is no release import with this import_id.")
        return self._release_payload(row)

    def import_release(self, source: Path, filename: str) -> dict:
        """Check a public release bundle on a hospital instance and summarize
        what publishing it would change; nothing is published yet."""
        from .uploads import AdminError, clean_filename

        with self._lock:
            conn = self._connection()
            instance = repository.load_instance(conn)
        if instance["kind"] != "hospital":
            raise AdminError(
                409, "not_hospital_instance", "Only a hospital version imports public releases. Set this instance to Hospital version under Instance first."
            )
        import_id = release.new_import_id()
        directory = self.release_dir(import_id)
        directory.mkdir(parents=True, exist_ok=False)
        bundle_path = directory / "bundle.sqlite"
        report: dict = {"problems": [], "notes": []}
        status = "invalid"
        try:
            release.expand_bundle(source, bundle_path)
            bundle = sqlite3.connect(f"file:{bundle_path}?mode=ro", uri=True)
            store = db.connect(self.db_path, read_only=True)
            try:
                manifest = release.check_bundle(bundle, store)
                changes, keeps, notes = release.summarize(bundle, store, manifest, self._release_digests)
            finally:
                bundle.close()
                store.close()
            report.update(
                release={
                    "dataset_version": manifest["dataset_version"],
                    "created_at": manifest["created_at"],
                    "organisation": manifest["organisation"],
                    "maintained_by": manifest["maintained_by"],
                    "format_version": manifest["format_version"],
                },
                changes=changes,
                keeps=keeps,
                notes=notes,
            )
            status = "valid"
        except BundleError as error:
            report["problems"].append({"code": error.code, "message": error.detail})
        except sqlite3.DatabaseError:
            report["problems"].append({"code": "invalid_bundle", "message": "The bundle is not a readable SQLite file; export it again."})
        except (KeyError, TypeError, ValueError, RecursionError):
            # Content a public instance never exports (e.g. unreadable JSON in a row): untrusted input, not a server error.
            report["problems"].append({"code": "invalid_bundle", "message": "The bundle's content cannot be read; export it again."})
        finally:
            if status != "valid":
                shutil.rmtree(directory, ignore_errors=True)
        with self._lock:
            conn = self._connection()
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.execute(
                    "INSERT INTO release_imports (import_id, filename, created_at, status, report_json) VALUES (?, ?, ?, ?, ?)",
                    (import_id, clean_filename(filename), db.utc_now(), status, json.dumps(report)),
                )
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            return self._release_payload(self._release_row(conn, import_id))

    def discard_release_import(self, import_id: str) -> None:
        from .uploads import AdminError

        with self._lock:
            conn = self._connection()
            row = self._release_row(conn, import_id)
            if row is None:
                raise AdminError(404, "unknown_import", "There is no release import with this import_id.")
            if row[3] not in ("valid", "invalid"):
                raise AdminError(409, "import_not_staged", f"Release import {import_id} is {row[3]}.")
            conn.execute("UPDATE release_imports SET status = 'discarded' WHERE import_id = ?", (import_id,))
        shutil.rmtree(self.release_dir(import_id), ignore_errors=True)

    def publish_release_import(
        self, import_id: str, *, note: str | None = None, role: str | None = None, publisher_name: str | None = None
    ) -> dict:
        """Publish a checked import as one version: the release's public layers,
        with this instance's local layers kept (contract v1.13, §26)."""
        from .uploads import AdminError, clean_note, clean_publisher

        note = clean_note(note)
        role, publisher_name = clean_publisher(role, publisher_name)
        self.get_release_import(import_id)  # 404 unknown_import before the publish slot
        bundle_path = self.release_dir(import_id) / "bundle.sqlite"
        self._begin_publish()
        try:
            with self._lock:
                # Read under the lock: a discard (or another publish) may have come first.
                payload = self.get_release_import(import_id)
                if payload["status"] != "valid":
                    raise AdminError(
                        409, "import_not_valid", f"Release import {import_id} is {payload['status']}; only a checked, valid import is published."
                    )
                conn = self._connection()
                bundle = sqlite3.connect(f"file:{bundle_path}?mode=ro", uri=True)
                try:
                    manifest = release.read_manifest(bundle)
                finally:
                    bundle.close()
                with release.attached(conn, bundle_path):
                    entry = self._copy_and_publish(conn, bundle_path, manifest, import_id, payload, note, role, publisher_name)
        finally:
            self._publish_lock.release()
        shutil.rmtree(self.release_dir(import_id), ignore_errors=True)
        self._notify()
        self._recheck_after(PUBLIC_LAYER_KINDS)  # every public set was replaced
        return entry

    def _copy_and_publish(self, conn, bundle_path, manifest, import_id, payload, note, role, publisher_name) -> dict:
        """Copy the attached bundle and add the version, in one transaction."""
        from .uploads import AdminError

        conn.execute("BEGIN IMMEDIATE")
        try:
            created = db.utc_now()
            state = release.copy_bundle(conn, bundle_path, manifest, import_id, created)
            release.check_consistent(conn, state)
            version_id = versions.insert_version(
                conn,
                state=state,
                kind=None,
                summary=release.describe(manifest, payload["changes"] or {}),
                created_at=created,
                note=note,
                publisher_role=role,
                publisher_name=publisher_name,
            )
            conn.execute(
                "UPDATE release_imports SET status = 'published', published_version = ? WHERE import_id = ? AND status = 'valid'",
                (version_id, import_id),
            )
            conn.execute("COMMIT")
        except BundleError as error:
            conn.execute("ROLLBACK")
            raise AdminError(409, error.code, error.detail) from error
        except sqlite3.IntegrityError as error:
            # Rows the store's constraints refuse (a hand-made bundle): nothing is written.
            conn.execute("ROLLBACK")
            raise AdminError(
                409, "invalid_bundle", "The bundle's rows do not fit this store's rules, so nothing was published. Export the release again."
            ) from error
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        return versions.version_entry(conn, version_id)
