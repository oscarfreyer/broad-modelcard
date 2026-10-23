"""The pinned ontology releases (``scripts/ontologies/sources.json``) and their local files.

``npm run ontologies:fetch`` downloads each file into
``backend/data/ontology-sources/<id>/<file>`` (gitignored); the importer reads
them from there, or from ``$BMC_ONTOLOGY_SOURCES``, after checking the size
and SHA-256 of every file against the manifest.
"""

from __future__ import annotations

import hashlib
import json
import os
import zipfile
from dataclasses import dataclass
from pathlib import Path

from .. import db

MANIFEST_FILE = db.REPO_ROOT / "scripts" / "ontologies" / "sources.json"
DEFAULT_SOURCES_DIR = db.BACKEND_DIR / "data" / "ontology-sources"

# Archive limits: the pinned files are far below them; anything larger is refused unopened.
MAX_MEMBER_BYTES = 64 * 1024 * 1024
MAX_COMPRESSION_RATIO = 200


class SourcesMissing(RuntimeError):
    """A pinned file is not downloaded yet."""


class SourceInvalid(RuntimeError):
    """A file does not match the manifest, or cannot be read safely."""


@dataclass(frozen=True)
class Source:
    id: str
    file: str
    url: str
    release: str
    bytes: int
    sha256: str
    licence: str
    attribution: str


def sources_dir(path: Path | str | None = None) -> Path:
    """``path``, else ``$BMC_ONTOLOGY_SOURCES``, else ``backend/data/ontology-sources``."""
    if path is not None:
        return Path(path)
    override = os.environ.get("BMC_ONTOLOGY_SOURCES")
    return Path(override) if override else DEFAULT_SOURCES_DIR


def load_manifest(path: Path | str = MANIFEST_FILE) -> dict[str, Source]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    sources = {}
    for entry in data["sources"]:
        source = Source(**{name: entry[name] for name in Source.__dataclass_fields__})
        if not source.id.replace("-", "").isalnum() or "/" in source.file or source.file.startswith("."):
            raise SourceInvalid(f"Unexpected manifest entry {source.id!r} / {source.file!r}.")
        sources[source.id] = source
    return sources


def file_path(directory: Path, source: Source) -> Path:
    return directory / source.id / source.file


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def missing(directory: Path, sources: dict[str, Source]) -> list[Source]:
    """The sources whose file is not in ``directory``."""
    return [source for source in sources.values() if not file_path(directory, source).is_file()]


def verify(directory: Path, sources: dict[str, Source]) -> dict[str, Path]:
    """Every source's path after checking its size and SHA-256.

    Raises ``SourcesMissing`` when a file is absent and ``SourceInvalid`` when
    one does not match the manifest (a partial or changed download)."""
    absent = missing(directory, sources)
    if absent:
        names = ", ".join(f"{source.id}/{source.file}" for source in absent)
        raise SourcesMissing(
            f"The ontology sources are not downloaded ({names} missing in {directory}). Run: npm run ontologies:fetch"
        )
    paths = {}
    for source in sources.values():
        path = file_path(directory, source)
        size = path.stat().st_size
        if size != source.bytes:
            raise SourceInvalid(f"{source.id}/{source.file} has {size} bytes, the manifest pins {source.bytes}. Fetch it again.")
        digest = sha256_of(path)
        if digest != source.sha256:
            raise SourceInvalid(f"{source.id}/{source.file} does not match its pinned SHA-256. Fetch it again.")
        paths[source.id] = path
    return paths


def read_member(archive: zipfile.ZipFile, name: str) -> bytes:
    """One archive member, refused unopened when it is large or compressed suspiciously."""
    info = archive.getinfo(name)
    if info.file_size > MAX_MEMBER_BYTES:
        raise SourceInvalid(f"{name} would expand to {info.file_size} bytes, over the {MAX_MEMBER_BYTES} byte limit.")
    if info.compress_size and info.file_size / info.compress_size > MAX_COMPRESSION_RATIO:
        raise SourceInvalid(f"{name} is compressed more than {MAX_COMPRESSION_RATIO}:1; refused unopened.")
    data = archive.read(name)
    if len(data) != info.file_size:
        raise SourceInvalid(f"{name} did not expand to its stated size.")
    return data
