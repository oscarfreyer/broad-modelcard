"""DEMO PACK ONLY: write the study-link merge files of demo pack v5 (contract v1.13).

Not a data generator for the atlas: nothing here writes to a store. This script
only rebuilds the committed CSV files under ``backend/demo/v5/metrics/`` so that
they can be reviewed and reproduced.

Each file is a metrics merge for one card that gives some of its stored rows the
source of one fictional study of ``v5/studies/studies.csv``. It downloads the
card's **filled metrics template** from a demo store built up to pack v4 or
later (the same file the Data Library offers), keeps every row of the chosen
conditions that has evidence (a Validation type and a Performance value), at
every demographic group the card stores, and sets Source, Study, and Source
date. Since pack v7 it also sets the **Validation type to match the
study's design**, so a row never says "Simulation study" while its study is a
retrospective cohort (``VALIDATION_TYPE_OF_DESIGN``):

* retrospective, prospective, real-world deployment, randomized trial →
  Clinical study (multisite) with more than one site, else (single site);
* benchmark → Benchmark; vignette → Vignette study; simulation → Simulation study.

The evidence counts follow the study record too, so the evidence block never
contradicts the linked study (``linked_counts``): Studies 1, Peer-reviewed
studies 1 or 0 as the study was peer reviewed, Sites the study's sites, and
Samples at most the study's patients (a condition or a group is part of the
study, so its count is kept when it is smaller).

Every other value is copied unchanged, so a publish changes the link, the
validation type, and these counts: the rows are graded with the study record (CONTRACT.md §22). The source date
(2026-10-18) is newer than the demo revision's (2026-10-13), so the merge
replaces those rows instead of keeping the stored ones (CONTRACT.md §11.2).
Running the script twice gives byte-identical files.

Usage (from backend/, on a demo store built up to pack v4; the store is only read):

    .venv/bin/python demo/tools/make_study_links.py --db <demo store> [--out demo/v5/metrics]
"""

from __future__ import annotations

import argparse
import csv
import shutil
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BACKEND_DIR))

from app.publishing.uploads import AdminService  # noqa: E402

DEFAULT_OUT = BACKEND_DIR / "demo" / "v5" / "metrics"
STUDIES = BACKEND_DIR / "demo" / "v5" / "studies" / "studies.csv"
SOURCE_DATE = "2026-10-18"

# The validation type a study's design stands for (pack v7); clinical
# designs depend on the number of sites.
CLINICAL_DESIGNS = frozenset({"Retrospective", "Prospective", "Real-world deployment", "Randomized trial"})
VALIDATION_TYPE_OF_DESIGN = {"Benchmark": "Benchmark", "Vignette": "Vignette study", "Simulation": "Simulation study"}


def validation_type(design: str, sites: int) -> str:
    if design in CLINICAL_DESIGNS:
        return "Clinical study (multisite)" if sites > 1 else "Clinical study (single site)"
    return VALIDATION_TYPE_OF_DESIGN[design]


@dataclass(frozen=True)
class StudyRecord:
    validation_type: str
    sites: int
    patients: int | None
    peer_reviewed: bool


def study_records() -> dict[str, StudyRecord]:
    """Study ID → what a linked row takes from the study, from the pack's studies file."""
    with open(STUDIES, newline="", encoding="utf-8") as handle:
        rows = [row for row in csv.reader(handle) if row and not row[0].startswith("#")]
    header = {name: index for index, name in enumerate(rows[0])}
    records = {}
    for row in rows[1:]:
        sites = int(row[header["Sites"]])
        patients = row[header["Patients"]].strip()
        records[row[header["Study ID"]]] = StudyRecord(
            validation_type(row[header["Design"]], sites), sites, int(patients) if patients else None, row[header["Peer reviewed"]] == "Yes"
        )
    return records


def linked_counts(row: list[str], column: dict[str, int], study: StudyRecord) -> None:
    """Set a linked row's evidence counts from its one study (in place)."""
    row[column["Studies"]] = "1"
    row[column["Peer-reviewed studies"]] = "1" if study.peer_reviewed else "0"
    row[column["Sites"]] = str(study.sites)
    samples = row[column["Samples"]].strip()
    if study.patients is not None and (not samples or int(samples) > study.patients):
        row[column["Samples"]] = str(study.patients)


@dataclass(frozen=True)
class Link:
    model_version: str
    use_case: str
    study_id: str
    source: str
    codes: tuple[str, ...]

    @property
    def filename(self) -> str:
        slug = lambda text: "".join(char if char.isalnum() else "-" for char in text.lower()).strip("-")  # noqa: E731
        return f"{slug(self.model_version)}.{slug(self.use_case)}.study-links.csv"


# The fictional studies of demo pack v5 and the conditions whose rows they report.
LINKS = (
    Link(
        "ICU_GPT-1.0", "CDSS", "ICU-RETRO-2025", "Kelvane retrospective sepsis cohort (fictional)",
        ("1G40", "1G41", "CA40", "CA22", "CA23", "CA43", "1D01", "BA00"),
    ),
    Link(
        "radAIology-1", "Radiology image analysis", "RAD-RCT-2026", "Tessellate chest and head imaging randomized trial (fictional)",
        ("CA40", "CB00", "CB21", "CB27", "BB00", "8B11", "8B00"),
    ),
    Link(
        "SkinAI-1.0", "Skin lesion CDSS", "DERM-VIG-2025", "Dermova vignette reader study (fictional)",
        ("2C30", "2C31", "2C32", "2E63", "EK90", "EA80", "EA90"),
    ),
)


def _unescaped(cell: str) -> str:
    return cell[1:] if cell[:1] == "'" and cell[1:2] in ("=", "+", "-", "@", "\t", "\r") else cell


def write_link(admin: AdminService, link: Link, out_dir: Path) -> tuple[Path, int]:
    with tempfile.TemporaryDirectory(prefix="bmc-demo-tool-") as scratch:
        path, _ = admin.template("metrics", "csv", Path(scratch), filled=True, model_version=link.model_version, use_case=link.use_case)
        with open(path, newline="", encoding="utf-8") as handle:
            lines = list(csv.reader(handle))
    body = [line for line in lines if line and not line[0].startswith("#")]
    header, rows = body[0], [[_unescaped(cell) for cell in row] for row in body[1:]]
    column = {name: index for index, name in enumerate(header)}
    order = {code: index for index, code in enumerate(link.codes)}
    kept = [
        row for row in rows
        if row[column["ICD-11 code"]] in order and row[column["Validation type"]].strip() and row[column["Performance"]].strip()
    ]
    kept.sort(key=lambda row: order[row[column["ICD-11 code"]]])  # stable: groups keep the template's order
    study = study_records()[link.study_id]
    for row in kept:
        row[column["Validation type"]] = study.validation_type
        linked_counts(row, column, study)
        row[column["Action"]] = ""
        row[column["Source"]] = link.source
        row[column["Study"]] = link.study_id
        row[column["Source date"]] = SOURCE_DATE
    target = out_dir / link.filename
    with open(target, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow([
            f"# Broad Modelcard demo pack v5: links rows of {link.model_version} / {link.use_case} to the fictional study {link.study_id}. "
            "Aggregate synthetic data only. Never upload patient-level or real patient data."
        ])
        writer.writerow([
            "# Written by demo/tools/make_study_links.py from the card's filled template: every value is copied unchanged; "
            "only Source, Study, Source date, the Validation type (the study's design), and the counts of studies, sites, and samples (the study's) change. Not clinical evidence."
        ])
        writer.writerow(header)
        writer.writerows(kept)
    return target, len(kept)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", type=Path, required=True, help="a demo store built up to pack v4 or later (only read)")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output folder (default demo/v5/metrics)")
    args = parser.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="bmc-demo-tool-uploads-") as uploads:
        admin = AdminService(args.db, uploads_dir=Path(uploads))
        try:
            for link in LINKS:
                target, count = write_link(admin, link, args.out)
                print(f"{target}: {count} rows")
        finally:
            admin.close()
            shutil.rmtree(uploads, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
