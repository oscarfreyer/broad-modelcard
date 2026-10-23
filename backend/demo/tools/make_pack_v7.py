"""DEMO PACK ONLY: write the generated CSV files of demo pack v7 (contract v1.13, CONTRACT.md §26).

Not a data generator for the atlas: nothing here writes to a store. It reads
filled metrics templates from a demo store built up to pack v5 or later (the
store is only read) and rewrites three committed files, so they can be
reviewed and reproduced. Running it twice gives byte-identical files.

* ``v7/local/icu-gpt-1-0.cdss.northbridge-region.csv``: **local results** of
  the fictional Northbridge General ICU evaluation (NBR-ICU-LOCAL-2026, a
  hospital study of the Northbridge region population) for ICU_GPT-1.0 / CDSS:
  the all-population rows of 12 conditions inside the card's intended use and
  the Age 65+ rows of 3 of them,
  each moved by a fixed step from the public value (some up, most down), so
  that several conditions change their mark for a reader of the Northbridge
  population.
* ``v7/submissions/tidewell-sepsis-1-0.sepsis-early-warning.csv``: the
  all-population metrics of a fictional new AI system in a developer
  submission (Tidewell Sepsis 1.0), derived from ICU_GPT-1.0's rows of 20
  infection and respiratory conditions by fixed steps.
* ``v7/submissions/corvessa-skin-review-1-2.prospective-merge.csv``: a metrics
  merge of a second submission that reports a fictional prospective study
  (CORV-PROSP-2026) for 4 conditions of Corvessa Skin Review 1.2.

Validation types follow the study designs, as in ``make_study_links.py``.

Usage (from backend/):

    .venv/bin/python demo/tools/make_pack_v7.py --db <demo store>
"""

from __future__ import annotations

import argparse
import csv
import shutil
import sys
import tempfile
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BACKEND_DIR))

from app.publishing.uploads import AdminService  # noqa: E402

PACK_V7 = BACKEND_DIR / "demo" / "v7"
NOTICE = "Aggregate synthetic data only. Never upload patient-level or real patient data."
ALL = ("All ages", "All sexes", "All ethnicities")
OLDER = ("Age 65+", "All sexes", "All ethnicities")

# (code, step for all patients); the first three also get an Age 65+ row with half the step.
# Conditions inside the card's intended use, so the local values show on the Overview too.
LOCAL_STEPS = (
    ("1G40", -0.21), ("1C45", -0.25), ("BA41", -0.2), ("BD10", -0.18), ("BB00", 0.04), ("CB41", 0.15),
    ("GB60", 0.12), ("1D01", -0.15), ("8B00", 0.18), ("BD11", 0.2), ("BD71", -0.22), ("1D00", -0.2),
)
TIDEWELL_CODES = (
    "1G40", "1G41", "1D01", "1D00", "1B70", "1B71", "1C44", "1A40", "1A04", "1A07",
    "1B10", "1B13", "CA40", "CA43", "CA07", "CA22", "CA23", "1C62", "1B51", "1B54",
)
CORVESSA_CODES = ("2C30", "2C31", "2C32", "2E63")


def _filled(admin: AdminService, model_version: str, use_case: str) -> tuple[list[str], list[list[str]]]:
    with tempfile.TemporaryDirectory(prefix="bmc-demo-tool-") as scratch:
        path, _ = admin.template("metrics", "csv", Path(scratch), filled=True, model_version=model_version, use_case=use_case)
        with open(path, newline="", encoding="utf-8") as handle:
            lines = [line for line in csv.reader(handle) if line and not line[0].startswith("#")]
    return lines[0], lines[1:]


def _rows_by_key(header: list[str], rows: list[list[str]]) -> dict[tuple[str, str, str, str], list[str]]:
    column = {name: index for index, name in enumerate(header)}
    return {
        (row[column["ICD-11 code"]], row[column["Age"]], row[column["Sex"]], row[column["Ethnicity"]]): row
        for row in rows
    }


def _moved(row: list[str], column: dict[str, int], step: float, *, samples: int, sites: int, validation: str, source: tuple[str, str, str]) -> list[str]:
    out = list(row)
    perf = float(row[column["Performance"]] or 0.72)  # a public row without a value starts from 0.72
    value = round(min(0.99, max(0.05, perf + step)), 3)
    half = 0.03 if sites > 1 else 0.045
    out[column["Performance"]] = f"{value}"
    out[column["CI low"]] = f"{round(max(0.0, value - half), 3)}"
    out[column["CI high"]] = f"{round(min(1.0, value + half), 3)}"
    out[column["Evidence grade"]] = ""
    out[column["Samples"]] = str(samples)
    out[column["Sites"]] = str(sites)
    out[column["Studies"]] = "1"
    out[column["Peer-reviewed studies"]] = "0"
    out[column["Validation type"]] = validation
    out[column["Action"]] = ""
    # The row now has a value and its evidence: the warnings for missing ones no longer apply.
    warnings = [code.strip() for code in row[column["Warnings"]].split(";") if code.strip()]
    out[column["Warnings"]] = "; ".join(code for code in warnings if code not in ("no_performance_data", "no_validation_data"))
    out[column["Source"]], out[column["Study"]], out[column["Source date"]] = source
    # A formula-like cell from a filled template carries an apostrophe; the warning codes never do.
    return [cell[1:] if cell[:1] == "'" else cell for cell in out]


def _write(path: Path, header: list[str], rows: list[list[str]], comment: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow([f"# Broad Modelcard demo pack v7: {comment} {NOTICE}"])
        writer.writerow(["# Written by demo/tools/make_pack_v7.py from filled templates of a demo store. Fictional; not clinical evidence."])
        writer.writerow(header)
        writer.writerows(rows)


def write_local(admin: AdminService) -> Path:
    header, rows = _filled(admin, "ICU_GPT-1.0", "CDSS")
    column = {name: index for index, name in enumerate(header)}
    by_key = _rows_by_key(header, rows)
    source = ("Northbridge General ICU local evaluation (fictional)", "NBR-ICU-LOCAL-2026", "2026-10-19")
    out = []
    for index, (code, step) in enumerate(LOCAL_STEPS):
        out.append(_moved(by_key[(code, *ALL)], column, step, samples=420 + 37 * index, sites=1, validation="Clinical study (single site)", source=source))
    for index, (code, step) in enumerate(LOCAL_STEPS[:3]):
        out.append(_moved(by_key[(code, *OLDER)], column, step / 2, samples=160 + 11 * index, sites=1, validation="Clinical study (single site)", source=source))
    target = PACK_V7 / "local" / "icu-gpt-1-0.cdss.northbridge-region.csv"
    _write(target, header, out, "local results of ICU_GPT-1.0 / CDSS for the local population northbridge-region (fictional Northbridge General ICU evaluation).")
    return target


def write_tidewell(admin: AdminService) -> Path:
    header, rows = _filled(admin, "ICU_GPT-1.0", "CDSS")
    column = {name: index for index, name in enumerate(header)}
    by_key = _rows_by_key(header, rows)
    source = ("Tidewell prospective sepsis validation (fictional)", "TIDE-VAL-2026", "2026-09-30")
    out = []
    for index, code in enumerate(TIDEWELL_CODES):
        step = (0.04, -0.06, 0.02, -0.11, 0.07)[index % 5]
        out.append(_moved(by_key[(code, *ALL)], column, step, samples=900 + 53 * index, sites=4, validation="Clinical study (multisite)", source=source))
    target = PACK_V7 / "submissions" / "tidewell-sepsis-1-0.sepsis-early-warning.csv"
    _write(target, header, out, "metrics of the fictional AI system Tidewell-Sepsis-1.0 in a developer submission.")
    return target


def write_corvessa(admin: AdminService) -> Path:
    header, rows = _filled(admin, "Corvessa-Skin-Review-1.2", "Skin lesion CDSS")
    column = {name: index for index, name in enumerate(header)}
    by_key = _rows_by_key(header, rows)
    source = ("Corvessa prospective clinic study (fictional)", "CORV-PROSP-2026", "2026-10-17")
    out = [
        _moved(by_key[(code, *ALL)], column, (0.03, -0.05, 0.02, -0.08)[index], samples=1300 + 41 * index, sites=5, validation="Clinical study (multisite)", source=source)
        for index, code in enumerate(CORVESSA_CODES)
    ]
    target = PACK_V7 / "submissions" / "corvessa-skin-review-1-2.prospective-merge.csv"
    _write(target, header, out, "a metrics merge of Corvessa-Skin-Review-1.2 in a developer submission (fictional prospective study CORV-PROSP-2026).")
    return target


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", type=Path, required=True, help="a demo store built up to pack v5 or later (only read)")
    args = parser.parse_args(argv)
    with tempfile.TemporaryDirectory(prefix="bmc-demo-tool-uploads-") as uploads:
        admin = AdminService(args.db, uploads_dir=Path(uploads))
        try:
            for write in (write_local, write_tidewell, write_corvessa):
                print(write(admin))
        finally:
            admin.close()
            shutil.rmtree(uploads, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
