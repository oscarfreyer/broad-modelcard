"""Reading uploaded CSV and XLSX files (app/importers/spreadsheets.py)."""

from __future__ import annotations

import openpyxl
import pytest

from app.importers.spreadsheets import UnreadableFile, detect_format, open_table


def rows_of(path, file_format):
    with open_table(path, file_format) as table:
        return table.header_row, table.header, list(table.rows()), table.decimal_comma


def test_csv_skips_comments_and_blank_rows_and_keeps_row_numbers(tmp_path):
    path = tmp_path / "a.csv"
    path.write_text("# comment, with comma\n\nCode,Value\n1A00,0.5\n,\n\n1A01, 0.7 \n", encoding="utf-8")
    header_row, header, rows, decimal_comma = rows_of(path, "csv")
    assert header_row == 3 and header == ["Code", "Value"] and not decimal_comma
    assert rows == [(4, ["1A00", "0.5"]), (7, ["1A01", "0.7"])]


def test_csv_with_semicolons_bom_and_windows_1252(tmp_path):
    path = tmp_path / "b.csv"
    path.write_bytes("﻿Code;Name\n1A00;Cholera\n".encode("utf-8"))
    _, header, rows, decimal_comma = rows_of(path, "csv")
    assert header == ["Code", "Name"] and rows == [(2, ["1A00", "Cholera"])] and decimal_comma

    path.write_bytes("Code;Name\n1A00;Méningite\n".encode("cp1252"))
    assert rows_of(path, "csv")[2] == [(2, ["1A00", "Méningite"])]


def test_csv_quoted_cells_and_tabs(tmp_path):
    path = tmp_path / "c.csv"
    path.write_text('Code\tWarnings\n1A00\t"a; b"\n', encoding="utf-8")
    assert rows_of(path, "csv")[2] == [(2, ["1A00", "a; b"])]


def test_empty_csv_has_no_header(tmp_path):
    path = tmp_path / "empty.csv"
    path.write_text("# only a comment\n\n", encoding="utf-8")
    assert rows_of(path, "csv")[:3] == (0, [], [])


def test_xlsx_reads_the_data_sheet_with_typed_cells(tmp_path):
    workbook = openpyxl.Workbook()
    workbook.active.title = "Instructions"
    workbook.active.append(["Read me"])
    data = workbook.create_sheet("Data")
    data.append(["Code", "Value", "Flag"])
    data.append(["1A00", 0.5, True])
    data.append([None, None, None])
    data.append(["1E30", 3, None])
    path = tmp_path / "d.xlsx"
    workbook.save(path)
    header_row, header, rows, _ = rows_of(path, "xlsx")
    assert header_row == 1 and header == ["Code", "Value", "Flag"]
    assert rows == [(2, ["1A00", 0.5, True]), (4, ["1E30", 3, None])]


def test_unreadable_xlsx(tmp_path):
    path = tmp_path / "broken.xlsx"
    path.write_bytes(b"PK\x03\x04 not really a zip")
    with pytest.raises(UnreadableFile):
        open_table(path, "xlsx")


@pytest.mark.parametrize(
    ("name", "head", "expected"),
    [
        ("a.csv", b"Code,Value\n", "csv"),
        ("A.CSV", b"Code,Value\n", "csv"),
        ("a.xlsx", b"PK\x03\x04rest", "xlsx"),
        ("a.xlsx", b"Code,Value", None),  # renamed CSV
        ("a.csv", b"PK\x03\x04rest", None),  # renamed workbook
        ("a.csv", b"\x00\x01binary", None),
        ("a.xls", b"\xd0\xcf\x11\xe0", None),
        ("a.json", b"{}", None),
        ("noextension", b"Code", None),
    ],
)
def test_detect_format(name, head, expected):
    assert detect_format(name, head) == expected
