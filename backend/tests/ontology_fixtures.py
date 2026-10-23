"""Tiny ontology sources for the tests (contract v1.13, CONTRACT.md §23).

``tests/fixtures/ontologies`` holds hand-written stand-ins for the three
pinned downloads, in their formats but made up: a small OBO file, a small
ICD-10-CM tabular XML file, a small index XML file (contract v1.14), and the two WHO mapping tables the importer reads
(with their real column names). ``write_sources`` packs them as the downloads
are packed (two zip archives and the OBO file) into a sources folder, with a
manifest that pins their sizes and checksums like ``scripts/ontologies/sources.json``.
They are never copies of the real sources.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import zipfile
from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures" / "ontologies"
REAL_MANIFEST_IDS = ("mondo", "icd10cm", "who-mapping")


def _pin(path: Path) -> tuple[int, str]:
    data = path.read_bytes()
    return len(data), hashlib.sha256(data).hexdigest()


def write_sources(root: Path) -> Path:
    """The fixture sources in ``root/<id>/<file>``; returns the manifest's path."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "mondo").mkdir(exist_ok=True)
    shutil.copyfile(FIXTURES / "mondo.obo", root / "mondo" / "mondo.obo")
    (root / "icd10cm").mkdir(exist_ok=True)
    with zipfile.ZipFile(root / "icd10cm" / "icd10cm-table-and-index-2027.zip", "w", zipfile.ZIP_DEFLATED) as archive:
        archive.write(FIXTURES / "icd10cm-tabular.xml", "icd10cm-table-and-index-2027/icd10cm-tabular_-2027.xml")
        # The index to diseases (contract v1.14, §31: its main terms are synonym candidates).
        archive.write(FIXTURES / "icd10cm-index.xml", "icd10cm-table-and-index-2027/icd10cm-index-2027.xml")
    (root / "who-mapping").mkdir(exist_ok=True)
    with zipfile.ZipFile(root / "who-mapping" / "mapping.zip", "w", zipfile.ZIP_DEFLATED) as archive:
        for name in ("10To11MapToOneCategory.txt", "foundation_11To10MapToOneCategory.txt"):
            archive.write(FIXTURES / name, name)
        archive.writestr("readme.txt", "Test fixture: made-up rows in the shape of the WHO mapping tables.\n")
    entries = []
    for source_id, file, release in (
        ("mondo", "mondo.obo", "v2026-10-06"),
        ("icd10cm", "icd10cm-table-and-index-2027.zip", "FY2027"),
        ("who-mapping", "mapping.zip", "ICD-11 MMS 2026-01"),
    ):
        size, digest = _pin(root / source_id / file)
        entries.append(
            {
                "id": source_id,
                "file": file,
                "url": f"https://example.invalid/{file}",
                "release": release,
                "bytes": size,
                "sha256": digest,
                "licence": f"Test fixture ({source_id})",
                "attribution": f"Test fixture standing in for {source_id}",
            }
        )
    manifest = root / "sources.json"
    manifest.write_text(json.dumps({"note": "test fixture", "sources": entries}, indent=2), encoding="utf-8")
    return manifest


def import_fixture_ontologies(store: Path, root: Path):
    from app.ontologies.importer import import_ontologies

    manifest = write_sources(root)
    return import_ontologies(store, sources=root, manifest=manifest)
