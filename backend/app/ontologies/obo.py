"""A minimal reader of OBO 1.2 flat files (MONDO), standard library only.

Only ``[Term]`` stanzas and the tags the projection needs are read: ``id``,
``name``, ``is_obsolete``, ``is_a`` (the parent id, without qualifiers or the
trailing ``! name``), ``xref`` (the cross-reference id, without
qualifiers), and, since contract v1.14 (CONTRACT.md §31), the text of
``synonym`` lines whose scope is ``EXACT``. Everything else is skipped.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from .sources import SourceInvalid

MAX_LINE = 1024 * 1024


@dataclass
class OboTerm:
    id: str
    name: str = ""
    obsolete: bool = False
    is_a: list[str] = field(default_factory=list)
    xrefs: list[str] = field(default_factory=list)
    # EXACT synonyms only (contract v1.14, §31); BROAD, NARROW, and RELATED ones are skipped.
    synonyms: list[str] = field(default_factory=list)


@dataclass
class OboFile:
    data_version: str | None
    terms: dict[str, OboTerm]


def _first_token(value: str) -> str:
    return value.split(" ", 1)[0].split("{", 1)[0].strip()


def _exact_synonym(value: str) -> str | None:
    """The text of an OBO ``synonym`` value when its scope is EXACT: ``"text" EXACT [refs]``.
    Backslash escapes inside the quotes are undone; a malformed value is None."""
    if not value.startswith('"'):
        return None
    chars: list[str] = []
    index = 1
    while index < len(value):
        char = value[index]
        if char == "\\" and index + 1 < len(value):
            chars.append(value[index + 1])
            index += 2
            continue
        if char == '"':
            rest = value[index + 1 :].split()
            return "".join(chars) if rest and rest[0] == "EXACT" else None
        chars.append(char)
        index += 1
    return None


def parse_obo_lines(lines: Iterable[str]) -> OboFile:
    terms: dict[str, OboTerm] = {}
    data_version = None
    current: OboTerm | None = None
    in_header = True
    for raw in lines:
        if len(raw) > MAX_LINE:
            raise SourceInvalid("An OBO line is longer than 1 MB; refused.")
        line = raw.rstrip("\r\n")
        if line.startswith("["):
            in_header = False
            current = OboTerm(id="") if line == "[Term]" else None
            continue
        if ": " not in line:
            continue
        tag, value = line.split(": ", 1)
        if in_header:
            if tag == "data-version":
                data_version = value.strip()
            continue
        if current is None:
            continue
        if tag == "id":
            current.id = value.strip()
            if current.id in terms:
                raise SourceInvalid(f"The OBO file repeats the term {current.id}.")
            terms[current.id] = current
        elif tag == "name":
            current.name = value.strip()
        elif tag == "is_obsolete":
            current.obsolete = value.strip() == "true"
        elif tag == "is_a":
            current.is_a.append(_first_token(value))
        elif tag == "xref":
            current.xrefs.append(_first_token(value))
        elif tag == "synonym":
            text = _exact_synonym(value.strip())
            if text:
                current.synonyms.append(text)
    terms.pop("", None)
    return OboFile(data_version=data_version, terms=terms)


def read_obo(path: Path) -> OboFile:
    with Path(path).open(encoding="utf-8") as handle:
        return parse_obo_lines(handle)
