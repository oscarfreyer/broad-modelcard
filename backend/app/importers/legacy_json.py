"""Import of the seed (the synthetic JSON tables in ``backend/seed``) into the SQLite store.

Usage (from backend/)::

    python -m app.importers.legacy_json [--seed seed] [--db data/broad_modelcard.sqlite] [--rebuild]
    python -m app.importers.legacy_json --check [--seed seed]   # validate only (npm run validate-seed)

``--db`` defaults to ``$BMC_DB`` when it is set, as for the server.

The import builds a fresh store next to the target and swaps it in only after
every file passed contract validation, so a failed import never leaves a
half-written store. It is idempotent: when the store already holds exactly
these source files as dataset version 1, it does nothing. It refuses to
replace a store that has later (published) versions unless ``--rebuild`` is
given. All imported data is synthetic demonstration data.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .. import db
from ..schema.contract import CARE_SETTINGS
from ..services.atlas import Atlas
from ..services.jsnum import locale_sort_key
from ..services.types import Axes, Concept, Lens
from ..validation import legacy_tables as contract
from ..validation.legacy_tables import ContractViolation, require

DEFAULT_SEED_DIR = db.BACKEND_DIR / "seed"
ATLAS_FILE = "atlas-base.json"
PREVALENCE_FILE = "prevalence_by_code.json"
REGISTRY_FILE = "model-registry.json"

CONCEPT_FIELDS = {
    "concept_id": "concept_id",
    "parent_id": "parent_id",
    "level": "level",
    "chapter": "chapter",
    "specialty": "specialty",
    "chapter_no": "chapter_no",
    "group": "group",
    "subgroup": "subgroup",
    "block_id": "block_id",
    "fsn": "fsn",
    "pt": "pt",
    "prevalence_score": "prevalence_score",
    "icd11_code": "icd11_code",
    "semanticTag": "semantic_tag",
    "sort_order": "sort_order",
    "depth_in_kind": "depth_in_kind",
    "is_high_depth": "is_high_depth",
    "metric_anchor_id": "metric_anchor_id",
}
MODEL_FIELDS = {
    "model_version",
    "model_name",
    "model_release",
    "display_name",
    "status",
    "default_use_case",
    "effects",
    "capabilities",
    "use_case_variants",
}
METRICS_HEADER_SKIP = {"rows_by_condition_id", "combinations", "combo_definitions", "row_format", "generated_at"}

ROW_INSERT_COLUMNS = (
    "perf, ci_low, ci_high, evidence_grade, n_samples, n_sites, n_studies, peer_reviewed_studies, "
    "validation_type, in_intended_use, intended_use_coverage, intended_use_level, warning_set_id"
)


class ImportRefused(RuntimeError):
    """The target store must not be replaced without --rebuild."""


@dataclass
class ImportReport:
    status: str  # 'imported' | 'up_to_date' | 'valid' (--check)
    db_path: Path  # the seed directory for 'valid'
    duration_s: float = 0.0
    db_size_bytes: int = 0
    counts: dict[str, int] = field(default_factory=dict)

    def describe(self) -> str:
        lines = [f"{self.status}: {self.db_path}"]
        if self.status in ("imported", "valid"):
            lines.append(f"  duration: {self.duration_s:.1f} s")
            if self.status == "imported":
                lines.append(f"  size: {self.db_size_bytes / 1_000_000:.1f} MB")
            lines.extend(f"  {name}: {value:,}" for name, value in self.counts.items())
        return "\n".join(lines)


# ------------------------------------------------------------------ sources

def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_json(path: Path) -> Any:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError as error:
        raise ContractViolation(f"Missing source file {path}.") from error
    except json.JSONDecodeError as error:
        raise ContractViolation(f"{path} is not valid JSON: {error}.") from error


def source_files(seed_dir: Path) -> list[str]:
    """All files the import reads, relative to the seed root."""
    registry = _read_json(seed_dir / REGISTRY_FILE)
    files = [ATLAS_FILE, PREVALENCE_FILE, REGISTRY_FILE]
    for variant in contract.validate_registry(registry):
        files.append(contract.seed_relative(variant["metrics_file"]))
        if variant["multimorbidity_metrics_file"]:
            files.append(contract.seed_relative(variant["multimorbidity_metrics_file"]))
    contract.require_referenced_metrics_files(
        (path.relative_to(seed_dir).as_posix() for path in (seed_dir / "models").glob("*.metrics.json")), files
    )
    return files


def fingerprint(seed_dir: Path) -> dict[str, tuple[str, int]]:
    result = {}
    for relative in source_files(seed_dir):
        path = seed_dir / relative
        if not path.is_file():
            raise ContractViolation(f"Missing source file {path}.")
        result[relative] = (_sha256(path), path.stat().st_size)
    return result


def _stored_fingerprint(db_path: Path) -> tuple[dict[str, tuple[str, int]], int, int]:
    """(sources, version count, schema version) of an existing store."""
    try:
        conn = db.connect(db_path, read_only=True)
        try:
            stored = {
                path: (sha, size)
                for path, sha, size in conn.execute("SELECT path, sha256, size_bytes FROM legacy_import_sources")
            }
            versions = conn.execute("SELECT COUNT(*) FROM dataset_versions").fetchone()[0]
            return stored, versions, db.schema_version(conn)
        finally:
            conn.close()
    except sqlite3.DatabaseError as error:
        raise ImportRefused(
            f"{db_path} exists but is not a readable Broad Modelcard store ({error}). "
            "Rerun with --rebuild to replace it."
        ) from error


# ------------------------------------------------------------------- writer

class _Writer:
    """Inserts one import into an open connection inside one transaction."""

    def __init__(self, conn: sqlite3.Connection, seed_dir: Path, log: Callable[[str], None]):
        self.conn = conn
        self.seed_dir = seed_dir
        self.log = log
        self.now = db.utc_now()
        self.warning_set_ids: dict[str, int] = {}
        self.set_ids: list[int] = []
        self.counts: dict[str, int] = {}
        self.axes: Axes | None = None
        self.atlas_axes: dict | None = None
        self.atlas: Atlas | None = None
        self.top_level_ids: frozenset[str] = frozenset()

    def _count(self, name: str, amount: int = 1) -> None:
        self.counts[name] = self.counts.get(name, 0) + amount

    def _content_set(self, kind: str, source: str, sha256: str | None, generated_at, meta: dict,
                     model_version: str | None = None, use_case: str | None = None) -> int:
        cursor = self.conn.execute(
            "INSERT INTO content_sets (kind, model_version, use_case, source, source_sha256, generated_at, "
            "meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (kind, model_version, use_case, source, sha256, generated_at, json.dumps(meta, sort_keys=True), self.now),
        )
        self.set_ids.append(cursor.lastrowid)
        return cursor.lastrowid

    def _warning_set_id(self, codes: list[str]) -> int:
        key = json.dumps(codes, separators=(",", ":"))
        warning_set_id = self.warning_set_ids.get(key)
        if warning_set_id is None:
            warning_set_id = len(self.warning_set_ids) + 1
            self.warning_set_ids[key] = warning_set_id
        return warning_set_id

    # -------------------------------------------------------------- atlas

    def atlas_base(self, atlas: dict) -> None:
        contract.validate_atlas_base(atlas)
        concepts = atlas["concepts"]
        by_id = {concept["concept_id"]: concept for concept in concepts}
        top_level_position = {concept_id: index for index, concept_id in enumerate(atlas["top_level_condition_ids"])}
        self.top_level_ids = frozenset(top_level_position)

        def chapter_of(concept: dict) -> str:
            seen = set()
            while concept["level"] != 0:
                require(concept["concept_id"] not in seen, f'Concept "{concept["concept_id"]}" has a parent cycle.')
                seen.add(concept["concept_id"])
                parent = by_id.get(concept.get("parent_id"))
                require(parent is not None, f'Concept "{concept["concept_id"]}" has no chapter ancestor.')
                concept = parent
            return concept["concept_id"]

        rows = []
        for key, concept in enumerate(concepts):
            unknown = set(concept) - set(CONCEPT_FIELDS)
            require(not unknown, f'Concept "{concept["concept_id"]}" has unsupported fields: {sorted(unknown)}.')
            is_high_depth = concept.get("is_high_depth")
            rows.append(
                (
                    key,
                    concept["concept_id"],
                    concept.get("parent_id"),
                    concept["level"],
                    chapter_of(concept),
                    concept.get("chapter"),
                    concept.get("specialty"),
                    concept.get("chapter_no"),
                    concept.get("group"),
                    concept.get("subgroup"),
                    concept.get("block_id"),
                    concept.get("fsn"),
                    concept["pt"],
                    concept.get("prevalence_score"),
                    concept.get("icd11_code"),
                    concept.get("semanticTag"),
                    concept.get("sort_order"),
                    concept.get("depth_in_kind"),
                    None if is_high_depth is None else int(bool(is_high_depth)),
                    concept.get("metric_anchor_id"),
                    top_level_position.get(concept["concept_id"]),
                )
            )
        self.conn.executemany(
            "INSERT INTO concepts (concept_key, concept_id, parent_id, level, chapter_id, chapter, specialty, "
            'chapter_no, "group", subgroup, block_id, fsn, pt, prevalence_score, icd11_code, semantic_tag, '
            "sort_order, depth_in_kind, is_high_depth, metric_anchor_id, top_level_position) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
        self._count("concepts", len(rows))

        for key, value in atlas.items():
            if key in ("concepts", "top_level_condition_ids"):
                continue
            self.conn.execute(
                "INSERT INTO atlas_meta (key, value_json) VALUES (?, ?)", (key, json.dumps(value, sort_keys=True))
            )

        axes = atlas["metric_axes"]
        for axis, values in axes.items():
            self.conn.executemany(
                "INSERT INTO axis_values (axis, position, value) VALUES (?, ?, ?)",
                [(axis, position, value) for position, value in enumerate(values)],
            )
        self.atlas_axes = axes
        self.axes = Axes(
            context=tuple(axes["context"]),
            age=tuple(axes["age_lens"]),
            sex=tuple(axes["sex_lens"]),
            ethnicity=tuple(axes["ethnicity_lens"]),
        )
        lenses = self.axes.all_lenses()
        self.conn.executemany(
            "INSERT INTO lens_combos (combo_idx, context, age_lens, sex_lens, ethnicity_lens) VALUES (?, ?, ?, ?, ?)",
            [(self.axes.combo_index(lens), self.axes.context[0], lens.age, lens.sex, lens.ethnicity) for lens in lenses],
        )
        self._count("lens_combos", len(lenses))
        self._care_settings(lenses)

        # Concept index for canonical multimorbidity keys (prevalence is irrelevant there).
        self.atlas = Atlas(
            [
                Concept(
                    concept_id=concept["concept_id"],
                    parent_id=concept.get("parent_id"),
                    level=concept["level"],
                    chapter_id="",
                    chapter_no=concept.get("chapter_no"),
                    block_id=concept.get("block_id"),
                    pt=concept["pt"],
                    fsn=concept.get("fsn"),
                    icd11_code=concept.get("icd11_code"),
                    sort_order=concept.get("sort_order"),
                    depth_in_kind=concept.get("depth_in_kind"),
                    metric_anchor_id=concept.get("metric_anchor_id"),
                    is_top_level_condition=concept["concept_id"] in top_level_position,
                    prevalence_tier=None,
                    prevalence_score=None,
                )
                for concept in concepts
            ],
            self.axes,
        )

    def _care_settings(self, lenses: list[Lens]) -> None:
        """The specific care settings after the seed's one context (contract v1.14, CONTRACT.md §29):
        what migration 0013 adds to a store imported before it, so both paths give the same axes."""
        first = len(self.axes.context)
        self.conn.executemany(
            "INSERT INTO axis_values (axis, position, value) VALUES ('context', ?, ?)",
            [(first + offset, value) for offset, value in enumerate(CARE_SETTINGS.values())],
        )
        per_setting = len(lenses)
        self.conn.executemany(
            "INSERT INTO lens_combos (combo_idx, context, age_lens, sex_lens, ethnicity_lens) VALUES (?, ?, ?, ?, ?)",
            [
                ((first + offset) * per_setting + self.axes.combo_index(lens), value, lens.age, lens.sex, lens.ethnicity)
                for offset, value in enumerate(CARE_SETTINGS.values())
                for lens in lenses
            ],
        )
        self._count("lens_combos", len(CARE_SETTINGS) * per_setting)

    # --------------------------------------------------------- prevalence

    def prevalence(self, payload: dict, sha256: str) -> None:
        tiers = contract.validate_prevalence(payload)

        def bound(key: str, default: float) -> float:
            value = payload.get(key)
            try:
                number = float(value)
            except (TypeError, ValueError):
                return default
            return number if number == number and abs(number) != float("inf") else default

        meta = {key: value for key, value in payload.items() if key not in ("scores_by_code", "generated_at")}
        set_id = self._content_set("prevalence", f"legacy_json:{PREVALENCE_FILE}", sha256, payload.get("generated_at"), meta)
        self.conn.execute(
            "INSERT INTO prevalence_sets (set_id, min_score, max_score) VALUES (?, ?, ?)",
            (set_id, bound("min_score", 0.01), bound("max_score", 0.99)),
        )
        self.conn.executemany(
            "INSERT INTO prevalence_tiers (set_id, code, tier) VALUES (?, ?, ?)",
            [(set_id, code, tier) for code, tier in tiers],
        )
        self._count("prevalence_codes", len(tiers))

    # ----------------------------------------------------------- registry

    def registry(self, registry: dict, sha256: str) -> list[dict]:
        variants = contract.validate_registry(registry)
        meta = {key: value for key, value in registry.items() if key not in ("models", "generated_at", "default_model_version")}
        set_id = self._content_set("models", f"legacy_json:{REGISTRY_FILE}", sha256, registry.get("generated_at"), meta)
        self.conn.execute(
            "INSERT INTO registry_sets (set_id, default_model_version) VALUES (?, ?)",
            (set_id, registry.get("default_model_version")),
        )
        for position, model in enumerate(registry["models"]):
            unknown = set(model) - MODEL_FIELDS
            require(not unknown, f'Model "{model["model_version"]}" has unsupported fields: {sorted(unknown)}.')
            self.conn.execute(
                "INSERT INTO models (set_id, model_version, position, model_name, model_release, display_name, "
                "status, default_use_case, effects_json, capabilities_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    set_id,
                    model["model_version"],
                    position,
                    model.get("model_name"),
                    model.get("model_release"),
                    model["display_name"],
                    model["status"],
                    model.get("default_use_case"),
                    None if model.get("effects") is None else json.dumps(model["effects"]),
                    None if model.get("capabilities") is None else json.dumps(model["capabilities"]),
                ),
            )
            for variant_position, variant in enumerate(model["use_case_variants"]):
                mm_file = variant.get("multimorbidity_metrics_file")
                self.conn.execute(
                    "INSERT INTO use_case_variants (set_id, model_version, use_case, position, legacy_metrics_file, "
                    "legacy_multimorbidity_metrics_file) VALUES (?, ?, ?, ?, ?, ?)",
                    (set_id, model["model_version"], variant["use_case"], variant_position, variant["metrics_file"],
                     mm_file if mm_file and str(mm_file).strip() else None),
                )
        self._count("models", len(registry["models"]))
        self._count("use_case_variants", len(variants))
        return variants

    # ------------------------------------------------------------ metrics

    def _header_meta(self, payload: dict) -> dict:
        return {key: value for key, value in payload.items() if key not in METRICS_HEADER_SKIP}

    def _set_combos(self, set_id: int, combos: list[dict]) -> list[int]:
        combo_indices = [self.axes.combo_index(Lens(c["age_lens"], c["sex_lens"], c["ethnicity_lens"])) for c in combos]
        require(len(set(combo_indices)) == len(combo_indices), f"Content set {set_id} defines a lens combination twice.")
        self.conn.executemany(
            "INSERT INTO set_combos (set_id, position, combo_idx) VALUES (?, ?, ?)",
            [(set_id, position, combo_idx) for position, combo_idx in enumerate(combo_indices)],
        )
        return combo_indices

    def _stored_values(self, values: list, label: str) -> tuple:
        problem = contract.tuple_problem(values)
        require(problem is None, f"{label} {problem}.")
        return (
            *values[:9],
            1 if values[9] else 0,
            values[10],
            values[11],
            self._warning_set_id(values[12]),
        )

    def metrics(self, variant: dict, relative: str, sha256: str) -> None:
        label = relative
        payload = _read_json(self.seed_dir / relative)
        contract.validate_payload_header(
            payload, kind="metrics", label=label, expected_model=variant["model_version"],
            expected_use_case=variant["use_case"], atlas_axes=self.atlas_axes,
        )
        rows_by_condition = payload.get("rows_by_condition_id")
        require(isinstance(rows_by_condition, dict) and rows_by_condition,
                f"Runtime metrics payload {label} rows_by_condition_id must be a non-empty object.")
        set_id = self._content_set(
            "metrics", f"legacy_json:{relative}", sha256, payload.get("generated_at"), self._header_meta(payload),
            model_version=variant["model_version"], use_case=variant["use_case"],
        )
        combo_indices = self._set_combos(set_id, payload["combo_definitions"])
        rows = []
        for concept_id, tuples in rows_by_condition.items():
            require(concept_id in self.top_level_ids,
                    f'Runtime metrics payload {label} references condition "{concept_id}" outside top_level_condition_ids.')
            require(isinstance(tuples, list) and len(tuples) == len(combo_indices),
                    f'Runtime metrics payload {label} condition "{concept_id}" row count does not match combo_definitions length.')
            for position, values in enumerate(tuples):
                rows.append((set_id, combo_indices[position], concept_id,
                             *self._stored_values(values, f'{label} condition "{concept_id}" row {position}')))
        rows.sort(key=lambda row: (row[1], row[2]))
        self.conn.executemany(
            f"INSERT INTO metric_rows (set_id, combo_idx, concept_id, {ROW_INSERT_COLUMNS}) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
        self._count("metric_sets")
        self._count("metric_rows", len(rows))

    def multimorbidity(self, variant: dict, relative: str, sha256: str) -> None:
        label = relative
        payload = _read_json(self.seed_dir / relative)
        contract.validate_payload_header(
            payload, kind="multimorbidity", label=label, expected_model=variant["model_version"],
            expected_use_case=variant["use_case"], atlas_axes=self.atlas_axes,
        )
        combinations = payload.get("combinations")
        require(isinstance(combinations, list) and combinations,
                f"Runtime multimorbidity payload {label} combinations must be a non-empty array.")
        set_id = self._content_set(
            "multimorbidity", f"legacy_json:{relative}", sha256, payload.get("generated_at"), self._header_meta(payload),
            model_version=variant["model_version"], use_case=variant["use_case"],
        )
        combo_indices = self._set_combos(set_id, payload["combo_definitions"])
        keys = set()
        members, rows = [], []
        for position, combination in enumerate(combinations):
            where = f"Runtime multimorbidity payload {label} combination {position}"
            require(isinstance(combination, dict), f"{where} must be an object.")
            condition_ids = combination.get("condition_ids")
            require(isinstance(condition_ids, list) and len(condition_ids) >= 2,
                    f"{where} must define at least two condition_ids.")
            for index, concept_id in enumerate(condition_ids):
                require(isinstance(concept_id, str) and concept_id.strip(),
                        f"{where} condition_ids[{index}] must be non-empty.")
                require(concept_id in self.top_level_ids, f'{where} references unknown condition "{concept_id}".')
            require(len(set(condition_ids)) == len(condition_ids), f"{where} condition_ids contains a duplicate.")
            canonical = sorted(
                {self.atlas.canonical_condition_id(self.atlas.by_id[concept_id]) for concept_id in condition_ids},
                key=locale_sort_key,
            )
            key = "+".join(canonical)
            require(key not in keys, f"{where} repeats the disease set {key}.")
            keys.add(key)
            label_value = combination.get("label")
            self.conn.execute(
                "INSERT INTO mm_combinations (set_id, position, combination_key, label) VALUES (?, ?, ?, ?)",
                (set_id, position, key, label_value if isinstance(label_value, str) else None),
            )
            members.extend((set_id, position, index, concept_id) for index, concept_id in enumerate(condition_ids))
            tuples = combination.get("rows")
            require(isinstance(tuples, list) and len(tuples) == len(combo_indices),
                    f"{where} row count does not match combo_definitions length.")
            for row_position, values in enumerate(tuples):
                rows.append((set_id, position, combo_indices[row_position],
                             *self._stored_values(values, f"{where} row {row_position}")))
        self.conn.executemany(
            "INSERT INTO mm_combination_conditions (set_id, position, member_index, concept_id) VALUES (?, ?, ?, ?)",
            members,
        )
        self.conn.executemany(
            f"INSERT INTO mm_rows (set_id, position, combo_idx, {ROW_INSERT_COLUMNS}) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
        self._count("multimorbidity_sets")
        self._count("multimorbidity_combinations", len(combinations))
        self._count("multimorbidity_rows", len(rows))

    # ------------------------------------------------------------ version

    def finish(self, sources: dict[str, tuple[str, int]]) -> None:
        self.conn.executemany(
            "INSERT INTO warning_sets (warning_set_id, codes_json) VALUES (?, ?)",
            [(warning_set_id, key) for key, warning_set_id in self.warning_set_ids.items()],
        )
        self._count("warning_sets", len(self.warning_set_ids))
        self.conn.execute(
            "INSERT INTO dataset_versions (version_id, kind, created_at, summary) VALUES (1, NULL, ?, ?)",
            (self.now, "Initial import of the legacy JSON tables (synthetic demonstration data)."),
        )
        self.conn.executemany(
            "INSERT INTO version_content_sets (version_id, set_id) VALUES (1, ?)", [(set_id,) for set_id in self.set_ids]
        )
        self.conn.executemany(
            "INSERT INTO legacy_import_sources (path, sha256, size_bytes) VALUES (?, ?, ?)",
            [(path, sha, size) for path, (sha, size) in sources.items()],
        )


# ------------------------------------------------------------------- driver

def _remove_with_sidecars(path: Path) -> None:
    for candidate in (path, *(path.with_name(path.name + suffix) for suffix in ("-wal", "-shm", "-journal"))):
        candidate.unlink(missing_ok=True)


def build_store(seed_dir: Path, target: Path, sources: dict[str, tuple[str, int]], log: Callable[[str], None]) -> dict:
    """Write a complete store to ``target`` (which must not exist)."""
    conn = sqlite3.connect(target, isolation_level=None)
    try:
        for pragma in ("journal_mode = OFF", "synchronous = OFF", "temp_store = MEMORY", "cache_size = -262144"):
            conn.execute(f"PRAGMA {pragma}")
        db.migrate(conn)
        writer = _Writer(conn, seed_dir, log)
        conn.execute("BEGIN")
        log(f"atlas: {ATLAS_FILE}")
        writer.atlas_base(_read_json(seed_dir / ATLAS_FILE))
        log(f"prevalence: {PREVALENCE_FILE}")
        writer.prevalence(_read_json(seed_dir / PREVALENCE_FILE), sources[PREVALENCE_FILE][0])
        log(f"registry: {REGISTRY_FILE}")
        variants = writer.registry(_read_json(seed_dir / REGISTRY_FILE), sources[REGISTRY_FILE][0])
        for variant in variants:
            relative = contract.seed_relative(variant["metrics_file"])
            log(f"metrics: {relative}")
            writer.metrics(variant, relative, sources[relative][0])
            if variant["multimorbidity_metrics_file"]:
                relative = contract.seed_relative(variant["multimorbidity_metrics_file"])
                log(f"multimorbidity: {relative}")
                writer.multimorbidity(variant, relative, sources[relative][0])
        writer.finish(sources)
        violations = conn.execute("PRAGMA foreign_key_check").fetchall()
        require(not violations, f"Foreign key check failed: {violations[:5]}")
        conn.execute("COMMIT")
        conn.execute("ANALYZE")
        conn.execute("PRAGMA journal_mode = WAL")
        return writer.counts
    finally:
        conn.close()


def import_legacy_tables(
    seed_dir: Path = DEFAULT_SEED_DIR,
    db_path: Path = db.DEFAULT_DB_PATH,
    *,
    rebuild: bool = False,
    log: Callable[[str], None] = lambda message: None,
) -> ImportReport:
    started = time.perf_counter()
    seed_dir = Path(seed_dir)
    db_path = Path(db_path)
    sources = fingerprint(seed_dir)

    if db_path.exists() and not rebuild:
        stored, versions, schema = _stored_fingerprint(db_path)
        if versions > 1:
            raise ImportRefused(
                f"{db_path} has {versions} dataset versions (published updates after the import). "
                "Rerun with --rebuild to discard them and import the seed again."
            )
        if stored == sources and versions == 1 and schema == len(db.available_migrations()):
            return ImportReport("up_to_date", db_path)
        log("source files or schema changed since the last import; rebuilding")

    db_path.parent.mkdir(parents=True, exist_ok=True)
    staging = db_path.with_name(db_path.name + ".importing")
    _remove_with_sidecars(staging)
    try:
        counts = build_store(seed_dir, staging, sources, log)
    except BaseException:
        _remove_with_sidecars(staging)
        raise
    for suffix in ("-wal", "-shm"):
        db_path.with_name(db_path.name + suffix).unlink(missing_ok=True)
    os.replace(staging, db_path)
    return ImportReport(
        "imported",
        db_path,
        duration_s=time.perf_counter() - started,
        db_size_bytes=db_path.stat().st_size,
        counts=counts,
    )


def check_seed(
    seed_dir: Path = DEFAULT_SEED_DIR, *, log: Callable[[str], None] = lambda message: None
) -> ImportReport:
    """Run every check of the import on the seed, without touching the store.

    The seed is written into a throwaway store, so validation and import
    cannot disagree. Raises ContractViolation on the first problem.
    """
    started = time.perf_counter()
    seed_dir = Path(seed_dir)
    sources = fingerprint(seed_dir)
    with tempfile.TemporaryDirectory(prefix="bmc-seed-check-") as scratch:
        counts = build_store(seed_dir, Path(scratch) / "check.sqlite", sources, log)
    return ImportReport("valid", seed_dir, duration_s=time.perf_counter() - started, counts=counts)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Import the seed (synthetic JSON tables) into the SQLite store.")
    parser.add_argument("--seed", type=Path, default=DEFAULT_SEED_DIR, help="seed directory (default: backend/seed)")
    # $BMC_DB, as for the server (app.main), so a scratch store set for a
    # session is never confused with the default store of the checkout.
    default_db = Path(os.environ["BMC_DB"]) if os.environ.get("BMC_DB") else db.DEFAULT_DB_PATH
    parser.add_argument("--db", type=Path, default=default_db, help="SQLite store to build (default: $BMC_DB, else backend/data/broad_modelcard.sqlite)")
    parser.add_argument("--rebuild", action="store_true", help="replace the store even if it has later versions")
    parser.add_argument("--check", action="store_true", help="only validate the seed; the store is not touched")
    parser.add_argument("--quiet", action="store_true", help="only print the result")
    args = parser.parse_args(argv)
    log = (lambda message: None) if args.quiet else (lambda message: print(f"  {message}", flush=True))
    try:
        if args.check:
            report = check_seed(args.seed, log=log)
        else:
            report = import_legacy_tables(args.seed, args.db, rebuild=args.rebuild, log=log)
    except (ContractViolation, ImportRefused) as error:
        print(f"{'seed check' if args.check else 'import'} failed: {error}", file=sys.stderr)
        return 1
    print(report.describe())
    return 0


if __name__ == "__main__":
    sys.exit(main())
