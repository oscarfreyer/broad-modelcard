"""Read uploaded CSV and XLSX files as a header plus numbered rows.

* Row numbers are the spreadsheet's: the first line or row of the file is 1.
* Lines before the header whose first cell starts with ``#`` are comments (the
  CSV templates start with two). Blank rows are skipped everywhere.
* CSV: UTF-8 (with or without BOM), otherwise Windows-1252. The delimiter is
  ``,``, ``;``, or tab, whichever the header line uses most; spreadsheet
  programs with a German locale write ``;`` and decimal commas
  (``CsvTable.decimal_comma``).
* XLSX: the sheet named "Data", otherwise the first sheet. Cached formula
  values are read, not formulas. Before openpyxl opens a workbook, its zip
  directory is checked (``check_xlsx_archive``): a workbook that would expand
  beyond the limits, or is compressed more than 100:1 (a decompression bomb),
  is refused as unreadable.

Cells come back as ``None`` (empty), stripped strings, or numbers and booleans
from XLSX. Parsing values is the validator's job.

Formula-like text: the files this tool writes put an apostrophe in front of
text that starts with ``=``, ``+``, ``-``, ``@``, a tab, or a carriage return,
so a spreadsheet program shows it as text instead of running it
(``escape_formula``; CONTRACT.md §11). Reading drops that apostrophe again
(``_clean``), so a downloaded file uploads unchanged.
"""

from __future__ import annotations

import codecs
import csv
import io
import re
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO, Any, Iterator

XLSX_SIGNATURE = b"PK\x03\x04"
DATA_SHEET = "Data"
DELIMITERS = (",", ";", "\t")


class UnreadableFile(ValueError):
    """The file cannot be read as the format it claims to be."""


def _reason(error: Exception) -> str:
    """The error in words for a report: an OSError's text names the file's path, so only its reason is kept."""
    if isinstance(error, OSError):
        return error.strerror or type(error).__name__
    return str(error)


MB = 1024 * 1024


@dataclass(frozen=True)
class ArchiveLimits:
    """How far an XLSX file may expand when opened.

    ``total``: all parts together, and any worksheet (openpyxl streams those).
    ``whole_part``: any other part, e.g. ``xl/sharedStrings.xml``, which
    openpyxl reads into memory at once. ``ratio``: expanded to compressed size,
    for every part above 1 MB and for the whole file."""

    total: int
    whole_part: int
    ratio: int = 100
    parts: int = 10_000


# A full filled metrics template (216,000 rows) expands to about 200 MB at 12:1.
UPLOAD_ARCHIVE_LIMITS = ArchiveLimits(total=1024 * MB, whole_part=200 * MB)
RATIO_FLOOR = 1 * MB  # small parts (styles, empty sheets) may compress very well


def xlsx_archive_problem(source: Path | IO[bytes], limits: ArchiveLimits, *, unreadable: str | None = None) -> str | None:
    """Why the workbook must not be opened, in plain words, or None. Reads only the
    zip directory: the sizes it declares bound what Python's zipfile will expand.
    ``unreadable`` replaces the message for a file that is not a zip archive."""
    try:
        with zipfile.ZipFile(source) as archive:
            parts = archive.infolist()
    except (zipfile.BadZipFile, OSError, ValueError) as error:
        return unreadable or f"The file is not a readable Excel workbook (.xlsx): {_reason(error)}."
    if len(parts) > limits.parts:
        return f"The workbook has more than {limits.parts:,} parts, more than this tool reads."
    expanded = sum(part.file_size for part in parts)
    compressed = sum(part.compress_size for part in parts)
    too_large = (
        f"The workbook would take more than {{limit}} MB once opened, more than this tool reads. "
        "Save the data as CSV, or split it into smaller files."
    )
    if expanded > limits.total:
        return too_large.format(limit=f"{limits.total // MB:,}")
    if any(not part.filename.startswith("xl/worksheets/") and part.file_size > limits.whole_part for part in parts):
        return too_large.format(limit=f"{limits.whole_part // MB:,}")

    def inflated(size: int, packed: int) -> bool:
        return size > RATIO_FLOOR and size > limits.ratio * max(1, packed)

    if inflated(expanded, compressed) or any(inflated(part.file_size, part.compress_size) for part in parts):
        return (
            f"The workbook is compressed more than {limits.ratio}:1, as a damaged or malicious file would be. "
            "Save it again from your spreadsheet program, or save the data as CSV."
        )
    return None


def detect_format(filename: str, head: bytes) -> str | None:
    """``csv``, ``xlsx``, or None when the file is neither (HTTP 415)."""
    suffix = Path(filename or "").suffix.lower()
    if suffix == ".xlsx":
        return "xlsx" if head.startswith(XLSX_SIGNATURE) else None
    if suffix in (".csv", ".txt"):
        return None if b"\x00" in head or head.startswith(XLSX_SIGNATURE) else "csv"
    return None


FORMULA_TRIGGERS = ("=", "+", "-", "@", "\t", "\r")
# Plain numbers (also with a decimal comma) are values, not formulas: -0.5, +3, 1e-3.
_PLAIN_NUMBER = re.compile(r"[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:[eE][+-]?\d+)?")


def looks_like_formula(value: Any) -> bool:
    """True for text a spreadsheet program could run as a formula (CSV/formula injection)."""
    return isinstance(value, str) and value.startswith(FORMULA_TRIGGERS) and not _PLAIN_NUMBER.fullmatch(value)


def escape_formula(value: Any) -> Any:
    """``=HYPERLINK(…)`` → ``'=HYPERLINK(…)``; everything else unchanged."""
    return "'" + value if looks_like_formula(value) else value


def _clean(value: Any) -> Any:
    if isinstance(value, str):
        value = value.strip()
        if value.startswith("'") and looks_like_formula(value[1:]):
            value = value[1:]  # escaped by escape_formula
        return value or None
    return value


@dataclass
class Table:
    """Header and rows of one upload. Iterate ``rows()`` once."""

    header: list[Any]
    header_row: int
    decimal_comma: bool = False
    _rows: Iterator[tuple[int, list[Any]]] | None = field(default=None, repr=False)
    _progress: Any = field(default=None, repr=False)
    _close: Any = field(default=None, repr=False)

    def rows(self) -> Iterator[tuple[int, list[Any]]]:
        """``(row number, cells)`` for each non-blank row after the header."""
        assert self._rows is not None
        return self._rows

    @property
    def knows_size(self) -> bool:
        """False for workbooks without a recorded size (e.g. written by openpyxl)."""
        return self._progress is not None

    def progress(self) -> float:
        """Share of the file read so far (0–1), approximate; 0 when unknown."""
        return min(1.0, max(0.0, self._progress())) if self._progress else 0.0

    def close(self) -> None:
        if self._close:
            self._close()

    def __enter__(self) -> "Table":
        return self

    def __exit__(self, *exc) -> None:
        self.close()


def _is_blank(cells: list[Any]) -> bool:
    return all(cell is None for cell in cells)


def _header_and_rows(numbered: Iterator[tuple[int, list[Any]]]) -> tuple[list[Any], int, Iterator]:
    for number, cells in numbered:
        if _is_blank(cells):
            continue
        first = cells[0]
        if isinstance(first, str) and first.startswith("#"):
            continue
        header = list(cells)
        while header and header[-1] is None:
            header.pop()

        def rest() -> Iterator[tuple[int, list[Any]]]:
            for row_number, row in numbered:
                if not _is_blank(row):
                    yield row_number, row

        return header, number, rest()
    return [], 0, iter(())


# --------------------------------------------------------------------- CSV

def _encoding(path: Path) -> str:
    """UTF-8 (with or without BOM) when the whole file decodes as UTF-8, else Windows-1252."""
    decoder = codecs.getincrementaldecoder("utf-8")()
    try:
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                decoder.decode(chunk)
        decoder.decode(b"", final=True)
    except UnicodeDecodeError:
        return "cp1252"
    return "utf-8-sig"


def _delimiter(line: str) -> str:
    counts = {delimiter: line.count(delimiter) for delimiter in DELIMITERS}
    best = max(DELIMITERS, key=lambda delimiter: counts[delimiter])
    return best if counts[best] else ","


def open_csv(path: Path) -> Table:
    encoding = _encoding(path)
    raw = open(path, "rb")  # noqa: SIM115 (closed by Table.close)
    size = max(1, path.stat().st_size)
    try:
        text = io.TextIOWrapper(raw, encoding=encoding, newline="", errors="strict")
        # Find the delimiter from the header line: skip leading comments and blanks.
        lines: list[str] = []
        while True:
            line = text.readline()
            if not line:
                break
            lines.append(line)
            stripped = line.strip()
            if stripped and not stripped.startswith("#") and stripped.strip(",;\t"):
                break
        delimiter = _delimiter(lines[-1] if lines else "")
        reader = csv.reader(_chain(lines, text), delimiter=delimiter)

        def numbered() -> Iterator[tuple[int, list[Any]]]:
            try:
                for record in reader:
                    yield reader.line_num, [_clean(cell) for cell in record]
            except (UnicodeDecodeError, csv.Error) as error:
                raise UnreadableFile(f"Line {reader.line_num} could not be read ({error}).") from error

        header, header_row, rows = _header_and_rows(numbered())
    except UnicodeDecodeError as error:
        raw.close()
        raise UnreadableFile(f"The file is not readable text ({error.reason}).") from error
    except BaseException:
        raw.close()
        raise
    return Table(
        header=header,
        header_row=header_row,
        decimal_comma=delimiter != ",",
        _rows=rows,
        _progress=lambda: raw.tell() / size if not raw.closed else 1.0,
        _close=raw.close,
    )


def _chain(lines: list[str], rest: io.TextIOWrapper) -> Iterator[str]:
    yield from lines
    yield from rest


# -------------------------------------------------------------------- XLSX

def open_xlsx(path: Path, limits: ArchiveLimits = UPLOAD_ARCHIVE_LIMITS) -> Table:
    import openpyxl

    problem = xlsx_archive_problem(path, limits)
    if problem is not None:
        raise UnreadableFile(problem)
    try:
        workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    except (zipfile.BadZipFile, KeyError, OSError, ValueError, TypeError) as error:
        raise UnreadableFile(f"The file is not a readable Excel workbook (.xlsx): {_reason(error)}.") from error
    try:
        names = workbook.sheetnames
        if DATA_SHEET in names:
            sheet = workbook[DATA_SHEET]
        else:
            sheet = next(
                (workbook[name] for name in names if name.lower() not in ("instructions", "lists", "summary")),
                workbook[names[0]],
            )
        try:
            total = sheet.max_row or 0
        except (TypeError, ValueError):
            total = 0
        first = sheet.min_row or 1
        state = {"row": first}

        def numbered() -> Iterator[tuple[int, list[Any]]]:
            number = first - 1
            try:
                for values in sheet.iter_rows(values_only=True):
                    number += 1
                    state["row"] = number
                    yield number, [_clean(value) for value in values]
            except (zipfile.BadZipFile, KeyError, ValueError, TypeError) as error:
                raise UnreadableFile(f"Row {number + 1} of the workbook could not be read ({error}).") from error

        header, header_row, rows = _header_and_rows(numbered())
    except BaseException:
        workbook.close()
        raise
    return Table(
        header=header,
        header_row=header_row,
        _rows=rows,
        _progress=(lambda: state["row"] / total) if total > 1 else None,
        _close=workbook.close,
    )


def open_table(path: Path, file_format: str) -> Table:
    if file_format == "xlsx":
        return open_xlsx(path)
    if file_format == "csv":
        return open_csv(path)
    raise UnreadableFile(f"Unsupported file format {file_format!r}.")
