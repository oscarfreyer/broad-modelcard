"""The WHO ICD-10 → ICD-11 mapping tables (``mapping.zip``, CC BY-ND 3.0 IGO).

Read unmodified at import time; nothing derived from them is committed.

* ``10To11MapToOneCategory.txt``: one ICD-11 code per ICD-10 code. Only
  category rows count: chapter rows carry Roman numerals ("I", "V", "X") that
  a prefix search would otherwise match for ICD-10-CM codes starting with
  those letters.
* ``foundation_11To10MapToOneCategory.txt`` (column "Foundation URI") and
  ``10To11MapToOneCategory.txt`` (column "ICD-11 FoundationURI"): the ICD-11
  MMS code of a Foundation entity, for MONDO's ``icd11.foundation``
  cross-references. The foundation table is listed first: it names each
  entity's own code, while the 10 → 11 rows name the code an ICD-10 concept
  was mapped to (for some, a residual category).
"""

from __future__ import annotations

import zipfile
from dataclasses import dataclass
from pathlib import Path

from .sources import SourceInvalid, read_member

TEN_TO_ELEVEN = "10To11MapToOneCategory.txt"
FOUNDATION_TO_TEN = "foundation_11To10MapToOneCategory.txt"
MIN_ICD10_PREFIX = 3  # a three-character category


@dataclass(frozen=True)
class WhoMapping:
    # ICD-10 category code (with its dot, e.g. "E11.9") → ICD-11 MMS code.
    icd10_to_icd11: dict[str, str]
    # Foundation entity id (the last URI segment) → ICD-11 MMS code.
    foundation_to_mms: dict[str, str]

    def icd10_prefix(self, code: str) -> str | None:
        """The longest prefix of ``code`` (at least a three-character category) that the table maps."""
        candidate = code.strip().upper()
        while len(candidate.replace(".", "")) >= MIN_ICD10_PREFIX:
            if candidate in self.icd10_to_icd11:
                return candidate
            candidate = candidate[:-1].rstrip(".")
        return None


def _rows(text: str) -> tuple[list[str], list[list[str]]]:
    lines = text.splitlines()
    if not lines:
        raise SourceInvalid("A WHO mapping table is empty.")
    header = [name.strip() for name in lines[0].split("\t")]
    return header, [line.split("\t") for line in lines[1:] if line.strip()]


def _column(header: list[str], *names: str) -> int:
    for name in names:
        if name in header:
            return header.index(name)
    raise SourceInvalid(f"A WHO mapping table lacks the column {names[0]!r}.")


def _cell(row: list[str], index: int) -> str:
    return row[index].strip() if index < len(row) else ""


def _foundation_id(uri: str) -> str:
    return uri.rstrip("/").rsplit("/", 1)[-1]


def read_who_mapping(path: Path) -> WhoMapping:
    with zipfile.ZipFile(path) as archive:
        ten_to_eleven = read_member(archive, TEN_TO_ELEVEN).decode("utf-8-sig")
        foundation = read_member(archive, FOUNDATION_TO_TEN).decode("utf-8-sig")

    header, rows = _rows(ten_to_eleven)
    kind_at = _column(header, "10ClassKind")
    code10_at = _column(header, "icd10Code")
    code11_at = _column(header, "icd11Code")
    uri_at = _column(header, "ICD-11 FoundationURI", "ICD-11 Foundation URI")
    icd10_to_icd11: dict[str, str] = {}
    from_ten: dict[str, str] = {}
    for row in rows:
        code10, code11 = _cell(row, code10_at), _cell(row, code11_at)
        if not code11:
            continue
        if _cell(row, kind_at).lower() == "category" and code10:
            icd10_to_icd11.setdefault(code10.upper(), code11)
        uri = _cell(row, uri_at)
        if uri:
            from_ten.setdefault(_foundation_id(uri), code11)

    header, rows = _rows(foundation)
    uri_at = _column(header, "Foundation URI")
    code11_at = _column(header, "icd11Code")
    foundation_to_mms: dict[str, str] = {}
    for row in rows:
        uri, code11 = _cell(row, uri_at), _cell(row, code11_at)
        if uri and code11:
            foundation_to_mms.setdefault(_foundation_id(uri), code11)
    for entity, code11 in from_ten.items():
        foundation_to_mms.setdefault(entity, code11)
    return WhoMapping(icd10_to_icd11=icd10_to_icd11, foundation_to_mms=foundation_to_mms)
