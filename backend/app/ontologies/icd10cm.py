"""ICD-10-CM (US CDC NCHS, public domain) from the tabular XML in the release archive.

The atlas shape: the disease chapters only, 1–17 and 19 (the
ICD-11 atlas also leaves out symptoms, external causes, factors, and codes
for special purposes); sections as blocks; three-character categories as
conditions (depth 1); their four-character subcategories as depth 2 with the
category as metric anchor. Codes with five or more characters are left out.

The same archive holds the alphabetic index to diseases and injuries
(``icd10cm-index-<year>.xml``). Since contract v1.14 (CONTRACT.md §31) its
main terms with a code are read as synonym candidates (``read_index``):
"Stroke", "Myxedema", "Woolsorter's disease". Subterms are left out: they
qualify a main term ("Infarct, infarction" › "adrenal") and read poorly on
their own.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

from .model import OntologyConcept, ParsedOntology
from .sources import SourceInvalid, read_member

ONTOLOGY_ID = "icd10cm"
NAME = "ICD-10-CM"
DISEASE_CHAPTERS = tuple(range(1, 18)) + (19,)
_TABULAR = re.compile(r"(^|/)icd10cm-tabular[^/]*\.xml$")
# The index to diseases and injuries; not the external-cause index (icd10cm-eindex-…).
_INDEX = re.compile(r"(^|/)icd10cm-index-[^/]*\.xml$")
_INDEX_CODE = re.compile(r"^[A-Z][0-9A-Z]{2}(\.[0-9A-Z]{0,4})?$")
_RANGE = re.compile(r"\s*\(([A-Z0-9.]+(?:-[A-Z0-9.]+)?)\)\s*$")


def chapter_id(number: int) -> str:
    return f"CM-CH-{number:02d}"


def block_id(section_id: str) -> str:
    return f"CM-BLK-{section_id}"


def safe_xml(data: bytes, name: str) -> ET.Element:
    """Parse untrusted XML without any document type: entity declarations
    (and so entity expansion or external entities) are refused unread."""
    # The whole document: comments before the root element can push a DOCTYPE past any fixed head.
    lowered = data.lower()
    if b"<!doctype" in lowered or b"<!entity" in lowered:
        raise SourceInvalid(f"{name} declares a document type or entities; refused.")
    try:
        return ET.fromstring(data)
    except ET.ParseError as error:
        raise SourceInvalid(f"{name} is not well-formed XML ({error}).") from error


def _title(desc: str | None) -> tuple[str, str | None]:
    """A chapter or section title without its trailing code range, and the range."""
    text = " ".join((desc or "").split())
    match = _RANGE.search(text)
    if not match:
        return text, None
    return text[: match.start()].strip(), match.group(1)


def read_icd10cm(path: Path, release: str) -> ParsedOntology:
    with zipfile.ZipFile(path) as archive:
        names = [name for name in archive.namelist() if _TABULAR.search(name)]
        if len(names) != 1:
            raise SourceInvalid("The ICD-10-CM archive does not hold exactly one tabular XML file.")
        root = safe_xml(read_member(archive, names[0]), names[0])
    return parse_tabular(root, release)


def read_index(path: Path) -> list[tuple[str, str]]:
    """The index's main terms with a code: ``(title, code)`` in index order.
    An archive without the index file gives an empty list."""
    with zipfile.ZipFile(path) as archive:
        names = [name for name in archive.namelist() if _INDEX.search(name)]
        if not names:
            return []
        if len(names) > 1:
            raise SourceInvalid("The ICD-10-CM archive holds more than one index XML file.")
        root = safe_xml(read_member(archive, names[0]), names[0])
    return parse_index(root)


def _index_title(node: ET.Element | None) -> str:
    """A title's text without its nonessential modifiers (``<nemod>``, the words in parentheses)."""
    if node is None:
        return ""
    parts = [node.text or ""]
    for child in node:
        if child.tag != "nemod":
            parts.append("".join(child.itertext()))
        parts.append(child.tail or "")
    return " ".join("".join(parts).split())


def parse_index(root: ET.Element) -> list[tuple[str, str]]:
    entries = []
    for main_term in root.iter("mainTerm"):
        code = (main_term.findtext("code") or "").strip().upper().rstrip("-").rstrip(".")
        title = _index_title(main_term.find("title"))
        if title and _INDEX_CODE.match(code):
            entries.append((title, code))
    return entries


def parse_tabular(root: ET.Element, release: str) -> ParsedOntology:
    parsed = ParsedOntology(ONTOLOGY_ID, NAME, "ICD-10-CM", release)
    concepts = parsed.concepts
    skipped_chapters = deeper_codes = 0
    for chapter in root.iter("chapter"):
        number_text = (chapter.findtext("name") or "").strip()
        if not number_text.isdigit():
            raise SourceInvalid(f"Unexpected ICD-10-CM chapter number {number_text!r}.")
        number = int(number_text)
        if number not in DISEASE_CHAPTERS:
            skipped_chapters += 1
            continue
        title, code_range = _title(chapter.findtext("desc"))
        chapter_concept_id = chapter_id(number)
        chapter_no = f"{number:02d}"
        concepts.append(
            OntologyConcept(
                concept_id=chapter_concept_id,
                parent_id=None,
                level=0,
                chapter_id=chapter_concept_id,
                chapter_no=chapter_no,
                block_id=None,
                code=None,
                pt=title,
                fsn=f"{title} (ICD-10-CM chapter {number}{', ' + code_range if code_range else ''})",
                sort_order=number,
            )
        )
        for section_index, section in enumerate(chapter.findall("section"), start=1):
            section_id = (section.get("id") or "").strip()
            if not section_id or len(section_id) > 40:
                raise SourceInvalid(f"Unexpected ICD-10-CM section id {section_id!r}.")
            section_title, _ = _title(section.findtext("desc"))
            block_concept_id = block_id(section_id)
            concepts.append(
                OntologyConcept(
                    concept_id=block_concept_id,
                    parent_id=chapter_concept_id,
                    level=1,
                    chapter_id=chapter_concept_id,
                    chapter_no=chapter_no,
                    block_id=section_id,
                    code=section_id,
                    pt=section_title,
                    fsn=f"{section_title} (ICD-10-CM {section_id})",
                    sort_order=number * 1000 + section_index,
                )
            )
            position = 0
            for category in section.findall("diag"):
                code = (category.findtext("name") or "").strip().upper()
                position += 1
                concepts.append(_condition(category, code, None, block_concept_id, chapter_concept_id, chapter_no, section_id, number, section_index, position))
                for subcategory in category.findall("diag"):
                    sub_code = (subcategory.findtext("name") or "").strip().upper()
                    position += 1
                    concepts.append(_condition(subcategory, sub_code, code, block_concept_id, chapter_concept_id, chapter_no, section_id, number, section_index, position))
                    deeper_codes += sum(1 for _ in subcategory.iter("diag")) - 1
    parsed.notes = {"chapters_left_out": skipped_chapters, "codes_beyond_four_characters": deeper_codes}
    return parsed


def _condition(node, code, anchor, block_concept_id, chapter_concept_id, chapter_no, section_id, number, section_index, position):
    if not re.fullmatch(r"[A-Z][0-9A-Z]{2}(\.[0-9A-Z]{1,4})?", code):
        raise SourceInvalid(f"Unexpected ICD-10-CM code {code!r}.")
    title = " ".join((node.findtext("desc") or "").split()) or code
    return OntologyConcept(
        concept_id=code,
        parent_id=block_concept_id,
        level=2,
        chapter_id=chapter_concept_id,
        chapter_no=chapter_no,
        block_id=section_id,
        code=code,
        pt=title,
        fsn=None,  # kept lean: a chapter read of thousands of conditions stays within the 2 MB budget
        sort_order=(number * 1000 + section_index) * 10000 + position,
        depth_in_kind=1 if anchor is None else 2,
        metric_anchor_id=code if anchor is None else anchor,
        parents=() if anchor is None else (anchor,),
    )
