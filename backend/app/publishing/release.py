"""Public release bundles (contract v1.13, CONTRACT.md §26).

A **public instance** exports its live public layers as one bundle: the
registry, every card's metrics and multimorbidity, the default prevalence, the
public safety incidents, the public studies, and the narrow model cards. The
bundle is a SQLite file (the store's own tables, filtered to those sets) with a
manifest, gzip-compressed: ``exportPublicRelease`` streams it.

A **hospital instance** imports a bundle: ``importPublicRelease`` checks it
(format, manifest checksums, the same ICD-11 atlas) and summarizes what
publishing it would change; ``publishReleaseImport`` publishes it as **one
version** that replaces the public layers and keeps the local ones (local
populations, local results, hospital studies, hospital incidents). A second
import keeps them again. Tracked cards and defaults live in each browser's
profile and are never touched.

Bundles are limited to ``MAX_BUNDLE_BYTES`` compressed and
``MAX_BUNDLE_EXPANDED_BYTES`` expanded (a 100:1 ratio is refused), apart from
the 128 MB limit of data set uploads. All data is synthetic demonstration data.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import secrets
import shutil
import sqlite3
from pathlib import Path

from .. import db, repository
from ..repository import DatasetState
from ..schema.contract import PUBLIC_LAYER_KINDS
from . import content as contents
from . import versions

BUNDLE_FORMAT = "broad-modelcard-public-release"
BUNDLE_FORMAT_VERSION = 1
MAX_BUNDLE_BYTES = 512 * 1024 * 1024
MAX_BUNDLE_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024
MAX_BUNDLE_RATIO = 100
GZIP_MAGIC = b"\x1f\x8b"

# Tables keyed by set_id that a bundle carries for its sets.
_SET_TABLES = (
    "content_sets", "registry_sets", "models", "use_case_variants", "set_combos", "metric_rows", "metric_row_provenance",
    "mm_combinations", "mm_combination_conditions", "mm_rows", "prevalence_sets", "prevalence_tiers", "prevalence_provenance",
    "set_provenance", "safety_incidents", "safety_incident_conditions", "studies", "effects", "model_cards",
)
# Every table a bundle holds, each listed in its manifest with a row count and checksum.
BUNDLE_TABLES = (*_SET_TABLES, "warning_sets", "provenance_sources")
# Copied set by set on import (content_sets, safety, and studies are written by the importer).
_COPIED = (
    ("registry_sets", None), ("models", None), ("use_case_variants", None), ("set_combos", None),
    ("metric_rows", "warning_set_id"), ("metric_row_provenance", "provenance_id"),
    ("mm_combinations", None), ("mm_combination_conditions", None), ("mm_rows", "warning_set_id"),
    ("prevalence_sets", None), ("prevalence_tiers", None), ("prevalence_provenance", "provenance_id"),
    ("set_provenance", "provenance_id"), ("effects", None), ("model_cards", None),
)


class BundleError(Exception):
    """A bundle that cannot be checked or published (``code``, plain ``detail``)."""

    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail


# ----------------------------------------------------------- fingerprints

def atlas_fingerprint(conn: sqlite3.Connection, schema: str = "main") -> str:
    """The ICD-11 atlas and lens axes a bundle's rows are keyed by."""
    digest = hashlib.sha256()
    for row in conn.execute(f"SELECT concept_id, parent_id, level, icd11_code FROM {schema}.concepts ORDER BY concept_key"):
        digest.update(repr(row).encode())
    for row in conn.execute(f"SELECT axis, position, value FROM {schema}.axis_values ORDER BY axis, position"):
        digest.update(repr(row).encode())
    return digest.hexdigest()


def _table_digest(conn: sqlite3.Connection, table: str) -> tuple[int, str]:
    digest = hashlib.sha256()
    count = 0
    for row in conn.execute(f"SELECT * FROM {table} ORDER BY rowid"):
        digest.update(repr(row).encode())
        count += 1
    return count, digest.hexdigest()


def _columns(conn: sqlite3.Connection, table: str, schema: str = "main") -> list[str]:
    return [row[1] for row in conn.execute(f"PRAGMA {schema}.table_info({table})")]


# ------------------------------------------------------------------ export

def public_sets(state: DatasetState) -> list[int]:
    """The live public layers' content sets."""
    sets = [state.registry_set_id, state.prevalence_set_id, *state.metric_sets.values(), *state.multimorbidity_sets.values()]
    sets += [set_id for set_id in (state.safety_set_id, state.studies_set_id, state.effects_set_id, state.model_cards_set_id) if set_id is not None]
    return sorted(set(sets))


def export_bundle(store_path: Path, out_path: Path, *, instance: dict) -> dict:
    """Write the live public layers of the store at ``store_path`` as a gzip
    bundle at ``out_path``; returns the manifest."""
    work = out_path.with_suffix(".sqlite.part")
    work.unlink(missing_ok=True)
    conn = sqlite3.connect(f"file:{work}", uri=True)
    try:
        conn.execute("ATTACH DATABASE ? AS store", (f"file:{store_path}?mode=ro",))
        state = repository.load_state(conn)  # reads through the attached schema's unqualified names
        sets = public_sets(state)
        marks = ", ".join("?" * len(sets))
        for table in _SET_TABLES:
            where = f"set_id IN ({marks})"
            if table == "safety_incidents":
                where += " AND scope = 'public'"
            elif table == "studies":
                where += " AND scope = 'public'"
            conn.execute(f"CREATE TABLE main.{table} AS SELECT * FROM store.{table} WHERE {where}", sets)
        conn.execute(
            "DELETE FROM main.safety_incident_conditions WHERE NOT EXISTS (SELECT 1 FROM main.safety_incidents i "
            "WHERE i.set_id = main.safety_incident_conditions.set_id AND i.incident_id = main.safety_incident_conditions.incident_id)"
        )
        conn.execute("CREATE TABLE main.warning_sets AS SELECT * FROM store.warning_sets ORDER BY warning_set_id")
        conn.execute("CREATE TABLE main.provenance_sources AS SELECT * FROM store.provenance_sources ORDER BY provenance_id")
        conn.commit()
        tables = {}
        for table in BUNDLE_TABLES:
            rows, digest = _table_digest(conn, f"main.{table}")
            tables[table] = {"rows": rows, "sha256": digest}
        manifest = {
            "format": BUNDLE_FORMAT,
            "format_version": BUNDLE_FORMAT_VERSION,
            "dataset_version": state.version_id,
            "created_at": db.utc_now(),
            "organisation": instance["organisation"],
            "maintained_by": instance["maintained_by"],
            "atlas_sha256": atlas_fingerprint(conn, "store"),
            "sets": [
                {"set_id": row[0], "kind": row[1], "model_version": row[2], "use_case": row[3]}
                for row in conn.execute("SELECT set_id, kind, model_version, use_case FROM main.content_sets ORDER BY set_id")
            ],
            "tables": tables,
            "notice": "Synthetic demonstration data. Public layers only: no local populations, local results, hospital studies, or hospital incidents.",
        }
        conn.execute("CREATE TABLE main.bundle_manifest (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)")
        conn.execute("INSERT INTO main.bundle_manifest (key, value_json) VALUES ('manifest', ?)", (json.dumps(manifest, sort_keys=True),))
        conn.commit()
        conn.execute("DETACH DATABASE store")
        conn.execute("VACUUM")
    finally:
        conn.close()
    with open(work, "rb") as source, gzip.open(out_path, "wb", compresslevel=6) as target:
        shutil.copyfileobj(source, target, 1 << 20)
    work.unlink(missing_ok=True)
    return manifest


# ------------------------------------------------------------------ import

def expand_bundle(source: Path, target: Path) -> None:
    """Decompress a gzip bundle with size and ratio limits."""
    size = source.stat().st_size
    with open(source, "rb") as handle:
        if handle.read(2) != GZIP_MAGIC:
            raise BundleError("invalid_bundle", "This is not a public release bundle (a .sqlite.gz file exported by a public instance).")
    written = 0
    try:
        with gzip.open(source, "rb") as reader, open(target, "wb") as writer:
            while chunk := reader.read(1 << 20):
                written += len(chunk)
                if written > MAX_BUNDLE_EXPANDED_BYTES or written > max(size, 1) * MAX_BUNDLE_RATIO:
                    raise BundleError("invalid_bundle", "The bundle expands beyond the size this tool accepts.")
                writer.write(chunk)
    except (OSError, EOFError, gzip.BadGzipFile) as error:
        raise BundleError("invalid_bundle", "The bundle could not be decompressed; export it again.") from error


_NO_MANIFEST = "The bundle holds no readable manifest; export it again from a public instance."
_TARGETED = ("metrics", "multimorbidity")


def read_manifest(bundle: sqlite3.Connection) -> dict:
    """The bundle's manifest, its shape checked (``invalid_bundle`` otherwise)
    before any of its names or ids are used: the file is untrusted input."""
    try:
        row = bundle.execute("SELECT value_json FROM bundle_manifest WHERE key = 'manifest'").fetchone()
        manifest = json.loads(row[0]) if row is not None else None
    except (sqlite3.DatabaseError, TypeError, ValueError, RecursionError) as error:
        raise BundleError("invalid_bundle", _NO_MANIFEST) from error
    if not isinstance(manifest, dict):
        raise BundleError("invalid_bundle", _NO_MANIFEST)
    if manifest.get("format") != BUNDLE_FORMAT or manifest.get("format_version") != BUNDLE_FORMAT_VERSION:
        raise BundleError("invalid_bundle", "The bundle has another format or format version than this tool reads.")
    _check_manifest_shape(manifest)
    return manifest


def _check_manifest_shape(manifest: dict) -> None:
    def invalid(what: str) -> BundleError:
        return BundleError("invalid_bundle", f"The bundle's manifest is incomplete or damaged ({what}); export it again.")

    for key in ("created_at", "organisation", "maintained_by", "atlas_sha256"):
        if not isinstance(manifest.get(key), str):
            raise invalid(key)
    if not isinstance(manifest.get("dataset_version"), int):
        raise invalid("dataset_version")
    tables = manifest.get("tables")
    if not isinstance(tables, dict) or set(tables) != set(BUNDLE_TABLES):
        raise invalid("tables")
    for entry in tables.values():
        if not isinstance(entry, dict) or not isinstance(entry.get("rows"), int) or not isinstance(entry.get("sha256"), str):
            raise invalid("tables")
    sets = manifest.get("sets")
    if not isinstance(sets, list):
        raise invalid("sets")
    for entry in sets:
        if not isinstance(entry, dict) or not isinstance(entry.get("set_id"), int) or entry.get("kind") not in PUBLIC_LAYER_KINDS:
            raise invalid("sets")
        targeted = entry["kind"] in _TARGETED
        for key in ("model_version", "use_case"):
            value = entry.get(key)
            if (targeted and not (isinstance(value, str) and value)) or (not targeted and value is not None):
                raise invalid("sets")
    ids = [entry["set_id"] for entry in sets]
    if len(set(ids)) != len(ids):
        raise invalid("sets")
    singles = [entry["kind"] for entry in sets if entry["kind"] not in _TARGETED]
    targets = [(entry["kind"], entry["model_version"], entry["use_case"]) for entry in sets if entry["kind"] in _TARGETED]
    if len(set(singles)) != len(singles) or len(set(targets)) != len(targets):
        raise invalid("sets")


def _check_tables(bundle: sqlite3.Connection, store: sqlite3.Connection) -> None:
    """Every bundle table is a table with exactly the store's columns (a bundle
    of another schema version cannot be copied)."""
    present = {name for (name,) in bundle.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    for table in BUNDLE_TABLES:
        if table not in present:
            raise BundleError("invalid_bundle", f"The bundle has no {table} table; export it again.")
        if _columns(bundle, table) != _columns(store, table):
            raise BundleError(
                "invalid_bundle",
                f"The bundle's {table} table has other columns than this store's: it was exported by another version "
                "of Broad Modelcard. Export it again with the same version.",
            )


def check_bundle(bundle: sqlite3.Connection, store: sqlite3.Connection) -> dict:
    """Verify a bundle's manifest; returns it. Raises ``BundleError``."""
    manifest = read_manifest(bundle)
    _check_tables(bundle, store)
    for table, expected in manifest["tables"].items():
        rows, digest = _table_digest(bundle, table)
        if rows != expected["rows"] or digest != expected["sha256"]:
            raise BundleError("bundle_checksum", f"The bundle's {table} table does not match its manifest; it was changed or damaged. Export it again.")
    if manifest["atlas_sha256"] != atlas_fingerprint(store):
        raise BundleError("bundle_atlas_mismatch", "The bundle was made for another ICD-11 atlas or lens axes than this store; both instances need the same seed.")
    kinds = [entry["kind"] for entry in manifest["sets"]]
    if kinds.count("models") != 1 or kinds.count("prevalence") != 1:
        raise BundleError("invalid_bundle", "The bundle must hold one registry and one default prevalence.")
    stored = [list(row) for row in bundle.execute("SELECT set_id, kind, model_version, use_case FROM content_sets ORDER BY set_id")]
    listed = sorted([entry["set_id"], entry["kind"], entry.get("model_version"), entry.get("use_case")] for entry in manifest["sets"])
    if stored != listed:
        raise BundleError("invalid_bundle", "The bundle's sets do not match its manifest; export it again.")
    _check_json(bundle)
    return manifest


def _check_json(bundle: sqlite3.Connection) -> None:
    """The JSON a publish reads from the bundle (warning lists, set metadata) is readable."""
    try:
        for (codes,) in bundle.execute("SELECT codes_json FROM warning_sets"):
            value = json.loads(codes)
            if not isinstance(value, list) or not all(isinstance(code, str) for code in value):
                raise ValueError("a warning list is not a list of codes")
        for (meta,) in bundle.execute("SELECT meta_json FROM content_sets"):
            if not isinstance(json.loads(meta), dict):
                raise ValueError("set metadata is not an object")
    except (TypeError, ValueError, RecursionError) as error:
        raise BundleError("invalid_bundle", "The bundle's warning lists or set metadata cannot be read; export it again.") from error


def bundle_state(manifest: dict) -> dict:
    """The bundle's sets by kind (bundle set ids)."""
    found: dict = {"metrics": {}, "multimorbidity": {}}
    for entry in manifest["sets"]:
        if entry["kind"] in ("metrics", "multimorbidity"):
            found[entry["kind"]][(entry["model_version"], entry["use_case"])] = entry["set_id"]
        else:
            found[entry["kind"]] = entry["set_id"]
    return found


def _metric_digest(conn: sqlite3.Connection, set_id: int) -> str:
    """A metrics set's rows with their warning codes, in key order."""
    digest = hashlib.sha256()
    for row in conn.execute(
        "SELECT r.combo_idx, r.concept_id, r.perf, r.ci_low, r.ci_high, r.evidence_grade, r.n_samples, r.n_sites, r.n_studies, "
        "r.peer_reviewed_studies, r.validation_type, r.in_intended_use, r.intended_use_coverage, r.intended_use_level, w.codes_json "
        "FROM metric_rows r JOIN warning_sets w USING (warning_set_id) WHERE r.set_id = ? ORDER BY r.combo_idx, r.concept_id",
        (set_id,),
    ):
        digest.update(repr(row).encode())
    return digest.hexdigest()


def _counts(staged: dict, live: dict) -> dict:
    added = sum(1 for key in staged if key not in live)
    removed = sum(1 for key in live if key not in staged)
    changed = sum(1 for key, value in staged.items() if key in live and live[key] != value)
    return {"added": added, "changed": changed, "removed": removed, "unchanged": len(staged) - added - changed}


def summarize(bundle: sqlite3.Connection, store: sqlite3.Connection, manifest: dict, digests: dict[int, str]) -> tuple[dict, dict, list[str]]:
    """What publishing would change in the public layers, what stays (the local
    layers), and notes. ``digests`` caches live metrics set digests by set id."""
    live = repository.load_state(store)
    sets = bundle_state(manifest)
    notes: list[str] = []
    staged_registry = contents.load_registry(bundle, sets["models"])
    live_registry = contents.load_registry(store, live.registry_set_id)

    def registry_rows(registry) -> dict:
        return {
            model.model_version: (model.display_name, model.status, model.entry_values(), model.use_cases,
                                  tuple(model.configuration(use_case).values() for use_case in model.use_cases))
            for model in registry.models
        }

    def live_digest(set_id: int) -> str:
        if set_id not in digests:
            digests[set_id] = _metric_digest(store, set_id)
        return digests[set_id]

    staged_cards = {key: _metric_digest(bundle, set_id) for key, set_id in sets["metrics"].items()}
    live_cards = {key: live_digest(set_id) for key, set_id in live.metric_sets.items()}
    staged_mm = {key: _table_rows(bundle, "mm_rows", set_id) for key, set_id in sets["multimorbidity"].items()}
    live_mm = {key: _table_rows(store, "mm_rows", set_id) for key, set_id in live.multimorbidity_sets.items()}
    staged_tiers = dict(bundle.execute("SELECT code, tier FROM prevalence_tiers WHERE set_id = ?", (sets["prevalence"],)))
    live_tiers = dict(store.execute("SELECT code, tier FROM prevalence_tiers WHERE set_id = ?", (live.prevalence_set_id,)))
    bundle_studies = {study.study_id: study for study in repository.load_studies(bundle, sets.get("studies"))}
    live_studies = repository.load_studies(store, live.studies_set_id)
    hospital_studies = [study for study in live_studies if study.scope == "hospital"]
    bundle_incidents = {incident.incident_id: incident for incident in repository.load_incidents(bundle, sets.get("safety"))}
    live_incidents = repository.load_incidents(store, live.safety_set_id)
    hospital_incidents = [incident for incident in live_incidents if incident.scope == "hospital"]
    for study in hospital_studies:
        if study.study_id in bundle_studies:
            notes.append(f"Study {study.study_id} is a hospital study here and a public study in the release; the hospital study stays.")
    for incident in hospital_incidents:
        if incident.incident_id in bundle_incidents:
            notes.append(f"Incident {incident.incident_id} is a hospital incident here and a public incident in the release; the hospital incident stays.")
    bundle_cards = {card.model_version: card for card in repository.load_model_cards(bundle, sets.get("model_cards"))}
    live_cards_mc = {card.model_version: card for card in repository.load_model_cards(store, live.model_cards_set_id)}
    changes = {
        "models": _counts(registry_rows(staged_registry), registry_rows(live_registry)),
        "metrics": _counts(staged_cards, live_cards),
        "multimorbidity": _counts(staged_mm, live_mm),
        "prevalence": _counts(staged_tiers, live_tiers),
        "studies": _counts(
            {key: value.as_dict() for key, value in bundle_studies.items()},
            {study.study_id: study.as_dict() for study in live_studies if study.scope == "public"},
        ),
        "safety": _counts(
            {key: value for key, value in bundle_incidents.items()},
            {incident.incident_id: incident for incident in live_incidents if incident.scope == "public"},
        ),
        "model_cards": _counts(
            {key: (card.card, card.markdown) for key, card in bundle_cards.items()},
            {key: (card.card, card.markdown) for key, card in live_cards_mc.items()},
        ),
        "effects": _counts(
            {effect.effect_id: effect.as_dict() for effect in repository.load_effects(bundle, sets.get("effects"))},
            {effect.effect_id: effect.as_dict() for effect in repository.load_effects(store, live.effects_set_id)},
        ),
    }
    registry_cards = set(staged_registry.variants())
    orphaned = sorted({(model, use_case) for model, use_case, _ in live.local_metric_sets} - registry_cards)
    if orphaned:
        notes.append(
            "Local results stay for cards the release no longer lists, unread until they return: "
            + ", ".join(f"{model} / {use_case}" for model, use_case in orphaned[:5]) + "."
        )
    keeps = {
        "populations": len(live.population_sets),
        "local_results": len(live.local_metric_sets),
        "hospital_studies": len(hospital_studies),
        "hospital_incidents": len(hospital_incidents),
    }
    return changes, keeps, notes


def _table_rows(conn: sqlite3.Connection, table: str, set_id: int) -> tuple:
    """A multimorbidity set's rows without the set id, in key order (for comparing sets)."""
    return tuple(row[1:] for row in conn.execute(f"SELECT * FROM {table} WHERE set_id = ? ORDER BY position, combo_idx", (set_id,)))


# ----------------------------------------------------------------- publish

def copy_bundle(conn: sqlite3.Connection, bundle_path: Path, manifest: dict, import_id: str, created_at: str) -> DatasetState:
    """Copy the bundle's sets into the store (inside the caller's transaction;
    the caller has attached the bundle as ``bundle``, see ``attached``) and
    return the new version's state: the bundle's public layers, with the
    live local layers kept and the live hospital studies and incidents merged
    into the public ones."""
    live = repository.load_state(conn)
    sets = bundle_state(manifest)
    conn.execute("CREATE TEMP TABLE IF NOT EXISTS set_map (old INTEGER PRIMARY KEY, new INTEGER NOT NULL)")
    conn.execute("CREATE TEMP TABLE IF NOT EXISTS warning_map (old INTEGER PRIMARY KEY, new INTEGER NOT NULL)")
    conn.execute("CREATE TEMP TABLE IF NOT EXISTS provenance_map (old INTEGER PRIMARY KEY, new INTEGER NOT NULL)")
    for table in ("set_map", "warning_map", "provenance_map"):
        conn.execute(f"DELETE FROM temp.{table}")
    # Interned warning lists and sources: reuse equal ones, add the rest.
    warnings = contents.WarningSetIds(conn)
    conn.executemany(
        "INSERT INTO temp.warning_map (old, new) VALUES (?, ?)",
        [(old, warnings(tuple(json.loads(codes)))) for old, codes in conn.execute("SELECT warning_set_id, codes_json FROM bundle.warning_sets").fetchall()],
    )
    sources = contents.ProvenanceIds(conn)
    conn.executemany(
        "INSERT INTO temp.provenance_map (old, new) VALUES (?, ?)",
        [
            (old, sources(repository.RowSource(source, study, date)))
            for old, source, study, date in conn.execute("SELECT provenance_id, source, study, source_date FROM bundle.provenance_sources").fetchall()
        ],
    )
    for entry in manifest["sets"]:
        if entry["kind"] in ("safety", "studies"):
            continue
        meta = conn.execute("SELECT meta_json FROM bundle.content_sets WHERE set_id = ?", (entry["set_id"],)).fetchone()[0]
        meta = {**json.loads(meta), "release_import": import_id, "release_set_id": entry["set_id"]}
        meta.pop("base_set_id", None)
        meta.pop("mode", None)
        new = conn.execute(
            "INSERT INTO content_sets (kind, model_version, use_case, source, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (entry["kind"], entry["model_version"], entry["use_case"], f"release:{import_id}", json.dumps(meta, sort_keys=True), created_at),
        ).lastrowid
        conn.execute("INSERT INTO temp.set_map (old, new) VALUES (?, ?)", (entry["set_id"], new))
    for table, interned in _COPIED:
        columns = [column for column in _columns(conn, table) if column != "set_id"]
        select = []
        joins = "JOIN temp.set_map s ON s.old = b.set_id"
        for column in columns:
            if column == interned == "warning_set_id":
                select.append("w.new")
                joins += " JOIN temp.warning_map w ON w.old = b.warning_set_id"
            elif column == interned == "provenance_id":
                select.append("p.new")
                joins += " JOIN temp.provenance_map p ON p.old = b.provenance_id"
            else:
                select.append(f"b.{column}")
        conn.execute(
            f"INSERT INTO main.{table} (set_id, {', '.join(columns)}) SELECT s.new, {', '.join(select)} FROM bundle.{table} b {joins}"
        )
    mapping = dict(conn.execute("SELECT old, new FROM temp.set_map"))
    # Studies and incidents: the release's public records, then this hospital's own.
    safety_set = _merged_set(
        conn, "safety", repository.load_incidents(conn, live.safety_set_id),
        _bundle_records(bundle_path, "safety", sets.get("safety")), created_at, import_id,
    )
    studies_set = _merged_set(
        conn, "studies", repository.load_studies(conn, live.studies_set_id),
        _bundle_records(bundle_path, "studies", sets.get("studies")), created_at, import_id,
    )
    return DatasetState(
        version_id=live.version_id,
        registry_set_id=mapping[sets["models"]],
        prevalence_set_id=mapping[sets["prevalence"]],
        metric_sets={key: mapping[set_id] for key, set_id in sets["metrics"].items()},
        multimorbidity_sets={key: mapping[set_id] for key, set_id in sets["multimorbidity"].items()},
        safety_set_id=safety_set,
        population_sets=dict(live.population_sets),
        studies_set_id=studies_set,
        local_metric_sets=dict(live.local_metric_sets),
        model_cards_set_id=mapping.get(sets.get("model_cards")) if sets.get("model_cards") is not None else None,
        effects_set_id=mapping.get(sets.get("effects")) if sets.get("effects") is not None else None,
    )


def _bundle_records(bundle_path: Path, kind: str, set_id: int | None) -> list:
    if set_id is None:
        return []
    reader = sqlite3.connect(f"file:{bundle_path}?mode=ro", uri=True)
    try:
        return repository.load_incidents(reader, set_id) if kind == "safety" else repository.load_studies(reader, set_id)
    finally:
        reader.close()


def _merged_set(conn: sqlite3.Connection, kind: str, live_records: list, public_records: list, created_at: str, import_id: str) -> int | None:
    """A new set of the release's public records and the live hospital records
    (a hospital record keeps its id when the release has the same one)."""
    key = "incident_id" if kind == "safety" else "study_id"
    hospital = [record for record in live_records if record.scope == "hospital"]
    taken = {getattr(record, key) for record in hospital}
    records = [record for record in public_records if getattr(record, key) not in taken] + hospital
    if not records:
        return None
    content = contents.SafetyContent(records) if kind == "safety" else contents.StudiesContent(records)
    return contents.insert_content_set(conn, content, source=f"release:{import_id}", created_at=created_at, meta={"release_import": import_id})


def new_import_id() -> str:
    return f"rel-{secrets.token_hex(5)}"


def describe(manifest: dict, changes: dict) -> str:
    """The version summary of a published import."""
    words = {
        "models": "AI systems", "metrics": "cards' metrics", "studies": "public studies", "safety": "public incidents",
        "effects": "effects on outcomes", "model_cards": "narrow model cards",
    }
    parts = []
    for kind, label in words.items():
        counts = changes.get(kind, {})
        moved = [f"{counts[name]} {name}" for name in ("added", "changed", "removed") if counts.get(name)]
        if moved:
            parts.append(f"{label} {', '.join(moved)}")
    return (
        f"Imported the public release of {manifest['organisation']} (its version {manifest['dataset_version']}): "
        + ("; ".join(parts) if parts else "no changes to the public layers")
        + ". Local layers kept."
    )


def check_consistent(conn: sqlite3.Connection, state: DatasetState) -> None:
    try:
        versions.check_consistent(conn, state)
    except versions.PublishConflict as error:
        raise BundleError("invalid_bundle", f"The release is inconsistent: {error}") from error


class attached:
    """``with attached(conn, path):``: the checked bundle attached as ``bundle``
    (ATTACH and DETACH must run outside a transaction; nothing writes to it)."""

    def __init__(self, conn: sqlite3.Connection, path: Path):
        self.conn = conn
        self.path = path

    def __enter__(self):
        self.conn.execute("ATTACH DATABASE ? AS bundle", (str(self.path),))
        return self.conn

    def __exit__(self, *exc):
        self.conn.execute("DETACH DATABASE bundle")
