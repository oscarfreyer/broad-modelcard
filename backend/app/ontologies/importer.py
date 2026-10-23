"""Import ICD-10-CM and MONDO into a store (contract v1.13, CONTRACT.md §23).

Usage (from backend/; ``npm run ontologies:import`` runs it)::

    python -I -m app.ontologies.importer [--db FILE] [--sources DIR] [--only icd10cm|mondo] [--quiet]

``--db`` defaults to ``$BMC_DB`` when it is set, else the live store, as for
the server. ``--sources`` defaults to ``$BMC_ONTOLOGY_SOURCES``, else
``backend/data/ontology-sources`` (``npm run ontologies:fetch`` downloads the
pinned releases there).

The store must hold the ICD-11 atlas (the seed import). Every file is checked
against its pinned size and SHA-256 first; a missing or changed file stops the
import before anything is written. Each ontology is then replaced as a whole
in one transaction, so the import is idempotent and a failed one leaves the
store as it was. A running backend keeps the ontologies it loaded until it
restarts.

Since contract v1.14 (CONTRACT.md §31) the same transaction also replaces the
ontology's synonyms of ICD-11 concepts (``synonyms``): MONDO labels and
EXACT synonyms with the MONDO import, the ICD-10-CM index's main terms with
the ICD-10-CM import.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from .. import db
from . import icd10cm, mondo, synonyms as synonym_import
from .crosswalk import Icd11Resolver, icd10cm_crosswalk, mondo_crosswalk
from .model import MAPPING_KINDS, Mapping, ParsedOntology
from .obo import read_obo
from .sources import MANIFEST_FILE, Source, SourceInvalid, SourcesMissing, load_manifest, sources_dir, verify
from .who import read_who_mapping

ONTOLOGY_IDS = ("icd10cm", "mondo")
# The sources each ontology reads.
NEEDS = {"icd10cm": ("icd10cm", "who-mapping"), "mondo": ("mondo", "who-mapping")}


class ImportFailed(RuntimeError):
    """The store cannot take the import (no ICD-11 atlas)."""


@dataclass
class OntologyReport:
    ontology_id: str
    name: str
    release: str
    counts: dict
    seconds: float
    # Synonyms of ICD-11 concepts written with this ontology (contract v1.14, §31).
    synonyms: int = 0
    synonym_seconds: float = 0.0

    def describe(self) -> str:
        mapping = self.counts["mapping_conditions"]
        total = max(1, self.counts["conditions"])
        parts = ", ".join(f"{kind} {mapping[kind]:,} ({100 * mapping[kind] / total:.0f} %)" for kind in MAPPING_KINDS if kind in mapping)
        return (
            f"{self.name} {self.release}: {self.counts['chapters']} chapters, {self.counts['blocks']} blocks, "
            f"{self.counts['conditions']:,} conditions ({self.counts['concepts']:,} with deeper levels); "
            f"conditions by mapping: {parts}; {self.synonyms:,} synonyms of ICD-11 concepts "
            f"({self.synonym_seconds:.1f} s); {self.seconds:.1f} s"
        )


@dataclass
class ImportReport:
    db_path: Path
    ontologies: list[OntologyReport] = field(default_factory=list)

    def describe(self) -> str:
        return "\n".join([f"ontologies imported into {self.db_path}:", *(f"  {entry.describe()}" for entry in self.ontologies)])


def counts_of(parsed: ParsedOntology, mappings: list[Mapping]) -> dict:
    levels = Counter(concept.level for concept in parsed.concepts)
    depth_one = {concept.concept_id for concept in parsed.concepts if concept.level == 2 and concept.depth_in_kind == 1}
    by_kind = Counter(mapping.kind for mapping in mappings)
    by_kind_conditions = Counter(mapping.kind for mapping in mappings if mapping.concept_id in depth_one)
    return {
        "chapters": levels[0],
        "blocks": levels[1],
        "conditions": len(depth_one),
        "concepts": levels[2],
        "mapping": {kind: by_kind.get(kind, 0) for kind in MAPPING_KINDS},
        "mapping_conditions": {kind: by_kind_conditions.get(kind, 0) for kind in MAPPING_KINDS},
        "source_notes": parsed.notes,
    }


def _source_record(source: Source) -> dict:
    return {
        "id": source.id,
        "file": source.file,
        "release": source.release,
        "sha256": source.sha256,
        "licence": source.licence,
        "attribution": source.attribution,
    }


def write_ontology(
    conn: sqlite3.Connection,
    parsed: ParsedOntology,
    mappings: list[Mapping],
    *,
    position: int,
    licence: str,
    attribution: str,
    sources: list[Source],
    synonyms: list | None = None,
) -> dict:
    """Replace one ontology's rows (and, given ``synonyms``, its synonym source's rows) in one transaction."""
    counts = counts_of(parsed, mappings)
    with conn:
        if synonyms is not None:
            synonym_import.replace_synonyms(conn, synonym_import.SOURCE_OF_ONTOLOGY[parsed.ontology_id], synonyms)
        conn.execute("DELETE FROM ontology_mappings WHERE ontology_id = ?", (parsed.ontology_id,))
        conn.execute("DELETE FROM ontology_concepts WHERE ontology_id = ?", (parsed.ontology_id,))
        conn.execute("DELETE FROM ontologies WHERE ontology_id = ?", (parsed.ontology_id,))
        conn.execute(
            "INSERT INTO ontologies (ontology_id, position, name, release, licence, attribution, sources_json, counts_json, imported_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                parsed.ontology_id,
                position,
                parsed.name,
                parsed.release,
                licence,
                attribution,
                json.dumps([_source_record(source) for source in sources]),
                json.dumps(counts),
                db.utc_now(),
            ),
        )
        conn.executemany(
            "INSERT INTO ontology_concepts (ontology_id, concept_key, concept_id, parent_id, level, chapter_id, chapter_no,"
            " block_id, code, pt, fsn, sort_order, depth_in_kind, metric_anchor_id, parents_json)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    parsed.ontology_id,
                    key,
                    concept.concept_id,
                    concept.parent_id,
                    concept.level,
                    concept.chapter_id,
                    concept.chapter_no,
                    concept.block_id,
                    concept.code,
                    concept.pt,
                    concept.fsn,
                    concept.sort_order,
                    concept.depth_in_kind,
                    concept.metric_anchor_id,
                    json.dumps(list(concept.parents)) if concept.parents else None,
                )
                for key, concept in enumerate(parsed.concepts)
            ],
        )
        conn.executemany(
            "INSERT INTO ontology_mappings (ontology_id, concept_id, kind, target_concept_id, via_concept_id, steps, source, source_code, icd11_code)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    parsed.ontology_id,
                    mapping.concept_id,
                    mapping.kind,
                    mapping.target_concept_id,
                    mapping.via_concept_id,
                    mapping.steps,
                    mapping.source,
                    mapping.source_code,
                    mapping.icd11_code,
                )
                for mapping in mappings
            ],
        )
    return counts


def import_ontologies(
    db_path: Path | str,
    *,
    sources: Path | str | None = None,
    manifest: Path | str = MANIFEST_FILE,
    only: tuple[str, ...] = ONTOLOGY_IDS,
    log=lambda message: None,
) -> ImportReport:
    """Verify the pinned sources, then import each ontology of ``only``.

    Raises ``SourcesMissing`` (nothing downloaded), ``SourceInvalid`` (a file
    does not match the manifest or cannot be read safely), or
    ``ImportFailed`` (the store has no ICD-11 atlas)."""
    db_path = Path(db_path)
    directory = sources_dir(sources)
    pinned = load_manifest(manifest)
    needed = {source_id for ontology in only for source_id in NEEDS[ontology]}
    unknown = needed - set(pinned)
    if unknown:
        raise SourceInvalid(f"The manifest lacks {sorted(unknown)}.")
    paths = verify(directory, {source_id: pinned[source_id] for source_id in sorted(needed)})
    if not db_path.is_file():
        raise ImportFailed(f"There is no store at {db_path}. Import the seed first: python -m app.importers.legacy_json")

    report = ImportReport(db_path)
    conn = db.connect(db_path)
    try:
        db.migrate(conn)
        resolver = Icd11Resolver.from_store(conn)
        if not resolver.by_code:
            raise ImportFailed(f"{db_path} holds no ICD-11 atlas. Import the seed first: python -m app.importers.legacy_json")
        log("reading the WHO ICD-10 → ICD-11 mapping tables")
        who = read_who_mapping(paths["who-mapping"])
        who_source = pinned["who-mapping"]
        preferred = synonym_import.preferred_terms(conn)
        for position, ontology_id in enumerate(ONTOLOGY_IDS, start=1):
            if ontology_id not in only:
                continue
            started = time.perf_counter()
            source = pinned[ontology_id]
            log(f"reading {source.id}/{source.file}")
            if ontology_id == "icd10cm":
                parsed = icd10cm.read_icd10cm(paths["icd10cm"], source.release)
                mappings = icd10cm_crosswalk(parsed.concepts, who, resolver)
                synonym_started = time.perf_counter()
                candidates = synonym_import.icd10cm_index_candidates(icd10cm.read_index(paths["icd10cm"]), who, resolver)
            else:
                obo = read_obo(paths["mondo"])
                if obo.data_version and source.release.lstrip("v") not in obo.data_version:
                    raise SourceInvalid(f"mondo.obo says {obo.data_version!r}, the manifest pins {source.release}.")
                parsed = mondo.build_mondo(obo, source.release)
                terms = mondo.live_terms(obo)
                mappings = mondo_crosswalk(parsed.concepts, terms, who, resolver)
                synonym_started = time.perf_counter()
                candidates = synonym_import.mondo_candidates(mappings, terms)
            synonyms = synonym_import.finalize(candidates, preferred)
            synonym_seconds = time.perf_counter() - synonym_started
            counts = write_ontology(
                conn,
                parsed,
                mappings,
                position=position,
                licence=source.licence,
                attribution=source.attribution,
                sources=[source, who_source],
                synonyms=synonyms,
            )
            entry = OntologyReport(
                ontology_id, parsed.name, source.release, counts, time.perf_counter() - started,
                synonyms=len(synonyms), synonym_seconds=synonym_seconds,
            )
            report.ontologies.append(entry)
            log(entry.describe())
    finally:
        conn.close()
    return report


# The last line of `npm run ontologies:import` (CONTRACT.md §23): a backend loads the
# ontologies once, at its start. The demo build does not print it: it refuses to build
# a store that a running backend has open.
RESTART_NOTICE = (
    "Restart a backend that is already running on this store (npm run dev, npm run demo, or npm run api) "
    "to read the imported classifications: it keeps the ones it loaded at its start."
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.ontologies.importer", description="Import ICD-10-CM and MONDO into a store.")
    default_db = Path(os.environ["BMC_DB"]) if os.environ.get("BMC_DB") else db.DEFAULT_DB_PATH
    parser.add_argument("--db", type=Path, default=default_db, help="store to import into (default $BMC_DB, else the live store)")
    parser.add_argument("--sources", type=Path, default=None, help="downloaded sources (default $BMC_ONTOLOGY_SOURCES, else backend/data/ontology-sources)")
    parser.add_argument("--manifest", type=Path, default=MANIFEST_FILE, help=argparse.SUPPRESS)
    parser.add_argument("--only", choices=ONTOLOGY_IDS, action="append", help="import only this ontology (repeatable)")
    parser.add_argument("--quiet", action="store_true", help="only print the result")
    args = parser.parse_args(argv)
    log = (lambda message: None) if args.quiet else (lambda message: print(f"  {message}", flush=True))
    try:
        report = import_ontologies(args.db, sources=args.sources, manifest=args.manifest, only=tuple(args.only or ONTOLOGY_IDS), log=log)
    except SourcesMissing as error:
        print(str(error), file=sys.stderr)
        return 2
    except (SourceInvalid, ImportFailed) as error:
        print(f"ontology import failed: {error}", file=sys.stderr)
        return 1
    print(report.describe())
    print(RESTART_NOTICE)
    return 0


if __name__ == "__main__":
    sys.exit(main())
