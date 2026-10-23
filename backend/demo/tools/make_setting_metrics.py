"""DEMO PACK ONLY: write the care-setting merge files of demo pack v10 (contract v1.14, CONTRACT.md §29).

Not a data generator for the atlas: nothing here writes to a store. This script
only rebuilds the committed CSV files under ``backend/demo/v10/metrics/`` so
that they can be reviewed and reproduced.

Each file is a metrics merge for one card that adds results **at one specific
care setting** (the Setting column), from one fictional study of that setting
(``v9/studies/study-fields.csv`` or ``v10/studies/setting-studies.csv``,
whose Setting category matches). It reads the card's **filled metrics
template** from a demo store built up to pack v9 or later (the same file the
Data Library offers) and, for a believable subset of conditions (chosen by
ICD-11 chapter, at most ``limit``, each with an all-patients Performance value
and evidence in Any setting), writes rows at the all-patients lens and a few
one-group lenses:

* **Performance** is the Any-setting all-patients value moved by a fixed,
  deterministic amount per card, setting, condition, and group (a hash, never
  random), within the setting's range (``SETTINGS``), clamped to 0.30–0.98;
  the CI follows the samples (about 1.96·√(p(1−p)/n), at least ±0.02).
* **Evidence** is the study's: Validation type from its design (as in
  ``make_study_links.py``), Studies 1, Peer-reviewed studies 1 or 0, Sites the
  study's sites, Samples a share of the study's patients (smaller for a group).
* Intended use, the source evidence grade, and the warnings are copied from
  the Any-setting all-patients row.
* Source, Study, and Source date name the study (a file may take its last few
  conditions from a second study of the same setting, ``other``).

Running the script twice gives byte-identical files. Every value is synthetic.

Usage (from backend/, on a demo store built up to pack v9; the store is only read):

    .venv/bin/python demo/tools/make_setting_metrics.py --db <demo store> [--out demo/v10/metrics]
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import math
import shutil
import sqlite3
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BACKEND_DIR))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.publishing.uploads import AdminService  # noqa: E402
from make_study_links import validation_type  # noqa: E402

DEFAULT_OUT = BACKEND_DIR / "demo" / "v10" / "metrics"
STUDY_FILES = (
    BACKEND_DIR / "demo" / "v9" / "studies" / "study-fields.csv",
    BACKEND_DIR / "demo" / "v10" / "studies" / "setting-studies.csv",
)
SOURCE_DATE = "2026-10-21"
ALL = ("All ages", "All sexes", "All ethnicities")
# (age, sex, ethnicity, share of the setting's samples, extra shift)
GROUPS = {
    "all": (*ALL, 1.0, 0.0),
    "65+": ("Age 65+", "All sexes", "All ethnicities", 0.38, -0.025),
    "40-64": ("Age 40-64", "All sexes", "All ethnicities", 0.34, 0.005),
    "18-39": ("Age 18-39", "All sexes", "All ethnicities", 0.24, 0.012),
    "female": ("All ages", "Sex Female", "All ethnicities", 0.51, -0.004),
    "male": ("All ages", "Sex Male", "All ethnicities", 0.49, 0.004),
}
# Setting → (lowest, highest) change from the Any-setting result, and the share of the study's patients per condition.
SETTINGS = {
    "Emergency department": (-0.075, 0.02, 0.06),
    "Intensive care": (-0.09, 0.015, 0.18),
    "Primary care": (-0.04, 0.035, 0.05),
}


@dataclass(frozen=True)
class Study:
    study_id: str
    title: str
    validation_type: str
    sites: int
    patients: int
    peer_reviewed: bool
    setting_category: str


def studies() -> dict[str, Study]:
    found = {}
    for path in STUDY_FILES:
        with open(path, newline="", encoding="utf-8") as handle:
            rows = [row for row in csv.reader(handle) if row and not row[0].startswith("#")]
        header = {name: index for index, name in enumerate(rows[0])}
        for row in rows[1:]:
            sites = int(row[header["Sites"]])
            found[row[header["Study ID"]]] = Study(
                row[header["Study ID"]], row[header["Title"]], validation_type(row[header["Design"]], sites), sites,
                int(row[header["Patients"]]), row[header["Peer reviewed"]] == "Yes", row[header["Setting category"]],
            )
    return found


@dataclass(frozen=True)
class SettingFile:
    model_version: str
    use_case: str
    setting: str
    study_id: str
    chapters: tuple[str, ...]  # ICD-11 chapter numbers, in the order conditions are taken
    groups: tuple[str, ...]
    limit: int
    first: tuple[str, ...] = ()  # conditions taken first (when the card has them), whatever their chapter
    # (study id, n): the last n conditions come from this other study of the same setting instead.
    other: tuple[str, int] | None = None

    @property
    def filename(self) -> str:
        slug = lambda text: "".join(char if char.isalnum() else "-" for char in text.lower()).strip("-")  # noqa: E731
        return f"{slug(self.model_version)}.{slug(self.use_case)}.{slug(self.setting)}.csv"


# The cards of demo pack v10 and where their setting-specific results come from.
FILES = (
    SettingFile(
        "Vantrel-Triage-2.1", "Emergency department triage", "Emergency department", "VANTREL-RCT-2026",
        ("22", "11", "12", "21", "01"), ("all", "65+", "18-39", "female", "male"), 120, ("8B20", "8B11", "BA41", "CA40", "1G40"),
        # 12 conditions from the developer's earlier triage simulation (an earlier configuration, Q4).
        ("TRIAGE-SIM-2026", 12),
    ),
    SettingFile(
        "ICU_GPT-1.0", "CDSS", "Intensive care", "ICU-RETRO-2025",
        ("01", "11", "12", "13", "16"), ("all", "65+", "40-64"), 80, ("1G40", "1G41", "CA40", "CB41", "BD10", "1D01"),
    ),
    SettingFile(
        "SynGPT-2.0", "Clinician Facing CDSS", "Emergency department", "SYN-ED-2026",
        ("11", "12", "22", "21", "08"), ("all", "65+", "female", "male"), 150, ("8B20", "BA41", "CA40", "1G40", "BA00"),
    ),
    SettingFile(
        "SynGPT-2.0", "Clinician Facing CDSS", "Primary care", "SYN-PC-2026",
        ("05", "11", "12", "06", "13", "15"), ("all", "65+", "female", "male"), 200, ("5A11", "BA00", "CA23", "6A70", "FA00"),
    ),
)


def _fraction(*parts: str) -> float:
    """A fixed number in [0, 1) from the parts (SHA-256), so reruns write the same values."""
    digest = hashlib.sha256("|".join(parts).encode()).digest()
    return int.from_bytes(digest[:8], "big") / 2**64


def _unescaped(cell: str) -> str:
    return cell[1:] if cell[:1] == "'" and cell[1:2] in ("=", "+", "-", "@", "\t", "\r") else cell


def _number(value: float) -> str:
    return f"{value:.3f}".rstrip("0").rstrip(".")


def chapter_numbers(db: Path) -> dict[str, str]:
    """ICD-11 code → its chapter number (read-only)."""
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        return {code: chapter for code, chapter in conn.execute("SELECT concept_id, chapter_no FROM concepts WHERE level = 2")}
    finally:
        conn.close()


def write_file(admin: AdminService, chapters: dict[str, str], spec: SettingFile, out_dir: Path) -> tuple[Path, int, int]:
    with tempfile.TemporaryDirectory(prefix="bmc-demo-tool-") as scratch:
        path, _ = admin.template("metrics", "csv", Path(scratch), filled=True, model_version=spec.model_version, use_case=spec.use_case)
        with open(path, newline="", encoding="utf-8") as handle:
            lines = list(csv.reader(handle))
    body = [line for line in lines if line and not line[0].startswith("#")]
    header, rows = body[0], [[_unescaped(cell) for cell in row] for row in body[1:]]
    column = {name: index for index, name in enumerate(header)}
    primary = studies()[spec.study_id]
    if primary.setting_category != spec.setting:
        raise SystemExit(f"{spec.study_id} is a {primary.setting_category} study, not {spec.setting}.")
    base = {
        row[column["ICD-11 code"]]: row
        for row in rows
        if (row[column["Age"]], row[column["Sex"]], row[column["Ethnicity"]]) == ALL
        and row[column["Setting"]] in ("", "Any setting")
        and row[column["Performance"]].strip()
        and row[column["Validation type"]].strip()
    }
    # The conditions the setting is known for first, then a round robin over the chapters (each in
    # code order), so the subset spans them all.
    codes = [code for code in spec.first if code in base]
    by_chapter = {chapter: sorted(code for code in base if chapters.get(code) == chapter and code not in codes) for chapter in spec.chapters}
    for rank in range(max(len(found) for found in by_chapter.values())):
        codes += [found[rank] for found in by_chapter.values() if rank < len(found)]
    codes = codes[: spec.limit]
    other = studies()[spec.other[0]] if spec.other else None
    if other is not None and other.setting_category != spec.setting:
        raise SystemExit(f"{other.study_id} is a {other.setting_category} study, not {spec.setting}.")
    other_codes = set(codes[-spec.other[1]:]) if spec.other else set()
    low, high, share = SETTINGS[spec.setting]
    written = []
    for code in codes:
        study = other if code in other_codes else primary
        source = base[code]
        perf = float(source[column["Performance"]])
        shift = low + (high - low) * _fraction(spec.model_version, spec.use_case, spec.setting, code)
        condition_samples = max(80, round(study.patients * share * (0.6 + 0.8 * _fraction("samples", spec.study_id, code))))
        for group in spec.groups:
            age, sex, ethnicity, group_share, group_shift = GROUPS[group]
            jitter = (_fraction("group", spec.setting, code, group) - 0.5) * 0.02 if group != "all" else 0.0
            value = min(0.98, max(0.30, perf + shift + group_shift + jitter))
            samples = max(40, round(condition_samples * group_share))
            half = max(0.02, 1.96 * math.sqrt(value * (1 - value) / samples))
            row = list(source)
            row[column["Age"]], row[column["Sex"]], row[column["Ethnicity"]] = age, sex, ethnicity
            row[column["Setting"]] = spec.setting
            row[column["Performance"]] = _number(value)
            row[column["CI low"]] = _number(max(0.0, value - half))
            row[column["CI high"]] = _number(min(1.0, value + half))
            row[column["Samples"]] = str(samples)
            row[column["Sites"]] = str(study.sites)
            row[column["Studies"]] = "1"
            row[column["Peer-reviewed studies"]] = "1" if study.peer_reviewed else "0"
            row[column["Validation type"]] = study.validation_type
            row[column["Action"]] = ""
            row[column["Source"]] = study.title
            row[column["Study"]] = study.study_id
            row[column["Source date"]] = SOURCE_DATE
            written.append(row)
    target = out_dir / spec.filename
    with open(target, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        # Comment lines without commas, so they stay unquoted.
        named = f"studies {spec.study_id} and {spec.other[0]}" if spec.other else f"study {spec.study_id}"
        writer.writerow([
            f"# Broad Modelcard demo pack v10: results of {spec.model_version} / {spec.use_case} measured in one care setting ({spec.setting}) "
            f"in the fictional {named}. Aggregate synthetic data only. Never upload patient-level or real patient data."
        ])
        writer.writerow([
            "# Written by demo/tools/make_setting_metrics.py from the card's filled template: synthetic values moved by a fixed amount "
            "from the Any-setting result; the evidence is the study's. Not clinical evidence."
        ])
        writer.writerow(header)
        writer.writerows(written)
    return target, len(codes), len(written)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", type=Path, required=True, help="a demo store built up to pack v9 or later (only read)")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output folder (default demo/v10/metrics)")
    args = parser.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    chapters = chapter_numbers(args.db)
    with tempfile.TemporaryDirectory(prefix="bmc-demo-tool-uploads-") as uploads:
        admin = AdminService(args.db, uploads_dir=Path(uploads))
        try:
            for spec in FILES:
                target, conditions, count = write_file(admin, chapters, spec, args.out)
                print(f"{target}: {conditions} conditions, {count} rows")
        finally:
            admin.close()
            shutil.rmtree(uploads, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
