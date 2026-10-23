"""DEMO PACK ONLY: write the files of demo pack v13 (release 0.5).

Not a data generator for the atlas: nothing here reads or writes a store. It
rewrites committed pack files from committed pack files, so they can be
reviewed and reproduced. Running it twice gives byte-identical files.

Two fictional products cover the function categories contract v1.14 added
(CONTRACT.md §11.1, §28): **Parlowe Answers 1.0** (Patient question
answering, category Patient communication, built on SynGPT-2.0, with an
intended-use statement) and **Tallyfern Coding 1.4** (Clinical coding
support, category Administrative, built on MediCore-2.5, without one).

* ``v13/registry.csv``: every line of ``v8/registry.csv`` unchanged (a
  registry upload replaces the whole data set), plus the two products with a
  configuration record, a performance measure and reference standard, the
  developer's declarations, and the data-protection declarations.
* ``v13/studies/function-studies.csv``: one fictional study per product, with
  the v1.14 study fields (applicability, appraisal tool, setting category,
  configuration evaluated).
* ``v13/metrics/<product>.csv``: each product's results at the all-population
  lens, at Any setting for a set of conditions (Parlowe: common conditions a
  patient asks about, three emergencies out of scope; Tallyfern: a broad set,
  about one condition in three of every chapter, chosen by a SHA-256
  selector), plus a few rows at specific care settings (Parlowe: Primary care
  and Outpatient clinic; Tallyfern: Inpatient ward). Performance starts from
  the built-on model's result in the pack's earlier product files (Vantrel
  Triage 2.1's pack v1 rows come from SynGPT-2.0, Quillary Scribe 1.0's from
  MediCore-2.5), moved by a fixed offset and a deterministic jitter; the CI
  follows the samples. Every row with performance carries the evidence of its
  study (Validation type from the design, 1 study, the study's sites and peer
  review, samples within the study's patients), so it is linked and graded.
* ``v13/safety/parlowe-answers-incident.csv``: one mitigated incident.

Every developer, product, study, contact, and link is fictional (.example).
The prompt checksums are SHA-256 digests of a fictional label, not of any prompt.

Usage (from backend/):

    .venv/bin/python demo/tools/make_pack_v13.py
"""

from __future__ import annotations

import csv
import hashlib
import math
from dataclasses import dataclass
from pathlib import Path

PACK = Path(__file__).resolve().parents[1]
V8_REGISTRY = PACK / "v8" / "registry.csv"
OUT = PACK / "v13"

NOTICE = "Synthetic demonstration data; every developer, product, study, contact, and link is fictional."


def _fraction(*parts: str) -> float:
    """A fixed number in [0, 1) from the parts (SHA-256), so reruns write the same values."""
    digest = hashlib.sha256("|".join(parts).encode()).digest()
    return int.from_bytes(digest[:8], "big") / 2**64


def _number(value: float) -> str:
    return f"{value:.3f}".rstrip("0").rstrip(".")


def prompt_digest(model_version: str, use_case: str, config_id: str) -> str:
    """A fictional checksum: the SHA-256 of a label, not of any prompt (as in make_pack_v8.py)."""
    return hashlib.sha256(f"Fictional prompt label: {model_version} | {use_case} | {config_id}".encode()).hexdigest()


# ------------------------------------------------------------------ registry

PARLOWE = {
    "Model version": "Parlowe-Answers-1.0", "Display name": "Parlowe Answers 1.0", "Model name": "Parlowe Answers", "Release": "1.0",
    "Status": "EXPERIMENTAL", "Use case": "Patient question answering", "Default use case": "Yes", "Default model": "No",
    "Kind": "Product", "AI type": "Large language model", "Developer": "Parlowe Health Communication (fictional)", "Release date": "2026-05-11",
    "Description": "Fictional patient communication product built on SynGPT-2.0: answers patients' questions about a common condition in plain language between visits. Synthetic demonstration entry.",
    "Built on": "SynGPT-2.0", "Function category": "Patient communication",
    "Declared intended purpose": "Answers patients' questions about a diagnosed common condition in plain language between visits; not for emergencies or for advice on a patient's own treatment (fictional).",
    "Declared regulatory status": "Not assessed (demonstration)",
    "Declared contact": "demo-contact@parlowe-health.example",
    "Declared documentation URL": "https://parlowe-health.example/docs/parlowe-answers-1.0",
    "Intended use stated": "Yes",
    "Configuration ID": "cfg-parlowe-2026-04", "Configuration date": "2026-04-20",
    "Prompt summary": "Answers a patient's question about a condition their practice has recorded, in plain words at a reading age of about 12; refers questions about their own treatment to the care team and tells them to call emergency services for warning signs (fictional).",
    "Retrieval": "Patient leaflets of the deploying practice and a fictional national health information library",
    "Tools": "leaflet_search; warning_signs_check", "Sampling temperature": "0.3", "Sampling top-p": "0.9", "Max output tokens": "700",
    "Performance measure": "Answer accuracy rated by clinicians",
    "Reference standard": "Two clinicians rate each answer against the practice's patient leaflets (fictional)",
    "Declared data use": "Uses the question the patient types and the conditions the practice has recorded for them; questions are not used for training (fictional).",
    "Declared data location": "The developer's cloud service in the EU (fictional)",
    "Declared retention": "Questions and answers are deleted after 30 days (fictional)",
    "Declared privacy contact": "privacy@parlowe-health.example",
}

TALLYFERN = {
    "Model version": "Tallyfern-Coding-1.4", "Display name": "Tallyfern Coding 1.4", "Model name": "Tallyfern Coding", "Release": "1.4",
    "Status": "ACTIVE", "Use case": "Clinical coding support", "Default use case": "Yes", "Default model": "No",
    "Kind": "Product", "AI type": "Hybrid", "Developer": "Tallyfern Health Records (fictional)", "Release date": "2026-06-22",
    "Description": "Fictional administrative product built on MediCore-2.5 with fixed coding rules: suggests ICD-11 codes for a hospital stay to the clinical coder. Synthetic demonstration entry.",
    "Built on": "MediCore-2.5", "Function category": "Administrative",
    "Declared intended purpose": "Suggests diagnosis codes for hospital stays to clinical coders, who confirm or change every code; not used for care decisions (fictional).",
    "Declared regulatory status": "Not assessed (demonstration)",
    "Declared contact": "demo-contact@tallyfern-health-records.example",
    "Declared documentation URL": "https://tallyfern-health-records.example/docs/tallyfern-coding-1.4",
    # Coding covers every diagnosis of a stay: the card states no condition-level intended use.
    "Intended use stated": "No",
    "Configuration ID": "cfg-tallyfern-2026-06", "Configuration date": "2026-06-08",
    "Prompt summary": "Suggests ICD-11 codes for the diagnoses in a discharge summary, each with the sentence it rests on; fixed coding rules check every suggestion, and the coder accepts or changes each code (fictional).",
    "Retrieval": "ICD-11 coding rules and the hospital's coding guide (fictional)",
    "Tools": "icd11_lookup; coding_rules_check", "Sampling temperature": "0.0", "Sampling top-p": "1.0", "Max output tokens": "800",
    "Performance measure": "Agreement with coded discharge diagnoses",
    "Reference standard": "Codes set by two senior clinical coders, disagreements settled by a third (fictional)",
    "Declared data use": "Reads the discharge summary of the stay being coded; summaries are not kept or used for training (fictional).",
    "Declared data location": "Runs inside the hospital network (fictional)",
    "Declared retention": "Not kept after the codes are accepted (fictional)",
    "Declared privacy contact": "privacy@tallyfern-health-records.example",
}

NEW_ENTRIES = (PARLOWE, TALLYFERN)


def write_registry() -> Path:
    with open(V8_REGISTRY, newline="", encoding="utf-8") as handle:
        lines = handle.read().splitlines()
    body = [line for line in lines if line and not line.startswith("#")]
    header = next(csv.reader([body[0]]))
    out = OUT / "registry.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", newline="", encoding="utf-8") as handle:
        handle.write(
            "# Broad Modelcard demo pack v13: AI systems & functions. Every entry and field of the pack v8 registry unchanged "
            "(a registry upload replaces the whole list), plus two fictional products for the function categories Patient "
            f"communication and Administrative (contract v1.14). {NOTICE}\n"
        )
        handle.write("# Written by demo/tools/make_pack_v13.py from v8/registry.csv. Prompt checksums are digests of fictional labels.\n")
        for line in body:
            handle.write(line + "\n")  # the v8 lines exactly as they are
        writer = csv.writer(handle, lineterminator="\n")
        for entry in NEW_ENTRIES:
            cells = dict(entry)
            cells["Prompt SHA-256"] = prompt_digest(entry["Model version"], entry["Use case"], entry["Configuration ID"])
            unknown = set(cells) - set(header)
            assert not unknown, f"columns not in the v8 registry: {unknown}"
            writer.writerow([cells.get(name, "") for name in header])
    return out


# ------------------------------------------------------------------ studies

STUDY_HEADER = [
    "Study ID", "Title", "Design", "Setting", "Sites", "Patients", "Peer reviewed", "Conducted by", "Reporting guideline",
    "Guideline followed", "Risk of bias", "Risk-of-bias notes", "Population", "Evaluation conditions", "Model version evaluated",
    "Publication date", "Source URL", "Scope", "Local population", "Applicability concerns", "Applicability notes",
    "Appraisal tool", "Appraisal score", "Setting category", "Configuration evaluated", "Action",
]


@dataclass(frozen=True)
class Study:
    study_id: str
    title: str
    design: str  # the template's label
    setting: str
    sites: int
    patients: int
    peer_reviewed: bool
    conducted_by: str
    guideline: str
    followed: str
    risk_of_bias: str
    bias_notes: str
    population: str
    conditions: str
    model_version: str
    publication_date: str
    applicability: str
    applicability_notes: str
    tool: str
    score: str
    setting_category: str
    configuration_id: str
    # Sites by care setting, for the rows measured in one setting.
    setting_sites: tuple[tuple[str, int], ...] = ()

    @property
    def validation_type(self) -> str:
        # As make_study_links.py maps designs: a clinical design with more than one site is multisite.
        return "Clinical study (multisite)" if self.sites > 1 else "Clinical study (single site)"

    def row(self) -> list[str]:
        return [
            self.study_id, self.title, self.design, self.setting, str(self.sites), str(self.patients), "Yes" if self.peer_reviewed else "No",
            self.conducted_by, self.guideline, self.followed, self.risk_of_bias, self.bias_notes, self.population, self.conditions,
            self.model_version, self.publication_date, f"https://studies.example/{self.study_id.lower()}", "", "",
            self.applicability, self.applicability_notes, self.tool, self.score, self.setting_category, self.configuration_id, "",
        ]


PARLOWE_STUDY = Study(
    "PARL-QA-2026", "Ashcombe patient question evaluation (fictional)", "Prospective",
    "Patient portals of 3 general practices and 3 outpatient clinics in the fictional Ashcombe region", 6, 26000, True,
    "Independent", "Other", "Partly", "Some concerns",
    "Participants: patients who use the portal; outcome: ratings by clinicians who knew the system was being tested (synthetic notes).",
    "Adults who sent a question about a diagnosed condition through their practice's or clinic's patient portal (synthetic)",
    "Questions sent over 6 months; two clinicians rated each answer as accurate or not against the practice's patient leaflets, a third settled disagreements; synthetic data.",
    "Parlowe-Answers-1.0", "2026-09-08", "Unclear",
    "Patients who use a portal may ask other questions than those who do not (synthetic notes).",
    "APPRAISE-AI", "68", "Mixed", "cfg-parlowe-2026-04",
    (("Primary care", 3), ("Outpatient clinic", 3)),
)

TALLYFERN_STUDY = Study(
    "TALLY-CODE-2026", "Brennick inpatient coding audit (fictional)", "Retrospective",
    "Coding departments of 4 hospitals in the fictional Brennick health board: inpatient wards and day clinics", 4, 18600, True,
    "Hospital", "Other", "Yes", "Low",
    "Records chosen by a fixed sampling plan; coders who set the reference codes did not see the suggestions (synthetic notes).",
    "Hospital stays with a discharge summary, adults and children (synthetic)",
    "Discharge summaries from 2025 coded again with the suggestions hidden from the reference coders; agreement per condition with the reference codes; synthetic data.",
    "Tallyfern-Coding-1.4", "2026-08-25", "Low",
    "The same coding rules and summaries as where the system is meant to be used (synthetic notes).",
    "Other", "", "Mixed", "cfg-tallyfern-2026-06",
    (("Inpatient ward", 4),),
)

STUDIES = (PARLOWE_STUDY, TALLYFERN_STUDY)


def write_studies() -> Path:
    out = OUT / "studies" / "function-studies.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", newline="", encoding="utf-8") as handle:
        handle.write(
            "# Broad Modelcard demo pack v13: studies, merged (one row per study). Aggregate synthetic descriptions only. "
            "Never upload patient-level or real patient data.\n"
        )
        handle.write(
            "# Two fictional studies behind the products Parlowe Answers 1.0 and Tallyfern Coding 1.4 (contract v1.14). "
            "Written by demo/tools/make_pack_v13.py. Nothing here is clinical evidence or describes a real study.\n"
        )
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(STUDY_HEADER)
        for study in STUDIES:
            writer.writerow(study.row())
    return out


# ------------------------------------------------------------------ metrics

METRIC_HEADER = [
    "ICD-11 code", "Condition", "Age", "Sex", "Ethnicity", "Setting", "Performance", "CI low", "CI high", "Evidence grade", "Samples",
    "Sites", "Studies", "Peer-reviewed studies", "Validation type", "In intended use", "Intended-use coverage", "Intended-use level",
    "Warnings", "Source", "Study", "Source date",
]
ALL_LENS = ("All ages", "All sexes", "All ethnicities")
ANY_SETTING = "Any setting"

# Common conditions a patient asks about between visits (top-level ICD-11 conditions).
PARLOWE_IN_SCOPE = (
    "5A11", "BA00", "CA23", "CA22", "8A80", "8A81", "6A70", "6A71", "6B00", "6B01", "FA00", "FA01", "DA22", "GC08", "GC00",
    "1E32", "CA00", "CA02", "CA03", "EA80", "ED80", "5A00", "5B81", "3A00", "BC81", "FA25", "EA90", "CA08", "AB00", "7A00",
    "DD91", "FA20", "5C80", "GA30", "GA20", "1A40", "DB60", "9A60", "DC11", "BA40", "1F28", "DA60", "AB30", "EA85", "5A10",
)
# Partly in scope: the answer covers the condition in general, not the patient's own treatment plan.
PARLOWE_PARTLY = ("BD10", "GB61", "6C40")
# Out of scope: emergencies. Measured anyway: whether the answer sent the patient to emergency services.
PARLOWE_OUT_OF_SCOPE = ("BA41", "8B20", "1G40")
PARLOWE_PRIMARY_CARE = PARLOWE_IN_SCOPE[:30]
PARLOWE_OUTPATIENT = ("5A10", "5A11", "CA22", "CA23", "BC81", "FA20", "EA90", "DD91", "BA40", "5A00", "GA30", "DC11", "BD10", "GB61", "FA25", "6B00")

TALLYFERN_SHARE = 1 / 3  # about one condition in three, from every chapter
TALLYFERN_INPATIENT_SHARE = 0.15  # of those, the ones also reported for inpatient stays


@dataclass(frozen=True)
class Product:
    model_version: str
    use_case: str
    base_file: Path  # the built-on model's results, as an earlier pack product file holds them
    study: Study
    offset: float
    spread: float  # the jitter's full width
    low: float
    high: float
    samples: tuple[int, int]  # samples per condition at Any setting
    has_intended_use: bool

    @property
    def filename(self) -> str:
        slug = lambda text: "".join(char if char.isalnum() else "-" for char in text.lower()).strip("-")  # noqa: E731
        return f"{slug(self.model_version)}.{slug(self.use_case)}.csv"


PARLOWE_PRODUCT = Product(
    "Parlowe-Answers-1.0", "Patient question answering", PACK / "v1" / "metrics" / "vantrel-triage-2-1.emergency-department-triage.csv",
    PARLOWE_STUDY, 0.02, 0.08, 0.62, 0.97, (90, 1400), True,
)
TALLYFERN_PRODUCT = Product(
    "Tallyfern-Coding-1.4", "Clinical coding support", PACK / "v1" / "metrics" / "quillary-scribe-1-0.discharge-letter-generation.csv",
    TALLYFERN_STUDY, -0.04, 0.10, 0.48, 0.97, (40, 900), False,
)

# The §4.2 evidence signal without the prevalence penalty, for the source grade column only (the atlas derives its own).
SIZE_BANDS = ((3000, 1.00), (1800, 0.90), (900, 0.78), (400, 0.64), (150, 0.50), (50, 0.38))
SITE_BANDS = ((20, 1.00), (10, 0.86), (5, 0.72), (2, 0.58))
GRADES = ((0.90, "A"), (0.80, "B"), (0.68, "C"), (0.56, "D"), (0.44, "E"))


def _band(value: int, bands, otherwise: float) -> float:
    return next((score for floor, score in bands if value >= floor), otherwise)


def source_grade(samples: int, sites: int, peer_reviewed: bool) -> str:
    signal = 0.33 * 1.0 + 0.17 * 0.50 + 0.12 * _band(sites, SITE_BANDS, 0.45) + 0.18 * (1.0 if peer_reviewed else 0.4) + 0.20 * _band(samples, SIZE_BANDS, 0.26)
    return next((grade for floor, grade in GRADES if signal >= floor), "F")


def base_rows(path: Path) -> dict[str, dict[str, str]]:
    with open(path, newline="", encoding="utf-8") as handle:
        body = [line for line in csv.reader(handle) if line and not line[0].startswith("#")]
    header = body[0]
    return {line[0]: dict(zip(header, line, strict=True)) for line in body[1:]}


def tallyfern_conditions(base: dict[str, dict[str, str]]) -> list[str]:
    return [code for code in base if _fraction("Tallyfern-Coding-1.4", "condition", code) < TALLYFERN_SHARE]


def _row(product: Product, code: str, name: str, base_perf: str, setting: str, scope: tuple[str, str, str] | None) -> list[str]:
    key = (product.model_version, code, setting)
    base = float(base_perf) if base_perf.strip() else (product.low + product.high) / 2
    shift = product.offset + (_fraction(*key, "perf") - 0.5) * product.spread
    if setting != ANY_SETTING:
        shift += (_fraction(*key, "setting") - 0.6) * 0.06  # a setting reads a little lower, mostly
    perf = round(min(product.high, max(product.low, base + shift)), 3)
    low_n, high_n = product.samples
    samples = round(low_n + (high_n - low_n) * _fraction(product.model_version, code, "samples") ** 1.6)
    sites = product.study.sites
    if setting != ANY_SETTING:
        samples = max(30, round(samples * (0.35 + 0.3 * _fraction(*key, "share"))))
        sites = dict(product.study.setting_sites)[setting]
    half = max(0.02, 1.96 * math.sqrt(perf * (1 - perf) / samples))
    ci_low, ci_high = max(0.0, perf - half), min(1.0, perf + half)
    warnings = []
    if scope and scope[2] == "Out of scope":
        warnings.append("out_of_scope_group")
    if samples < 150:
        warnings.append("limited_validation_depth")
    if ci_high - ci_low > 0.14:
        warnings.append("wide_confidence_interval")
    in_use, coverage, level = scope or ("", "", "")
    study = product.study
    return [
        code, name, *ALL_LENS, setting, _number(perf), _number(ci_low), _number(ci_high), source_grade(samples, sites, study.peer_reviewed),
        str(samples), str(sites), "1", "1" if study.peer_reviewed else "0", study.validation_type, in_use, coverage, level,
        "; ".join(warnings), study.title, study.study_id, study.publication_date,
    ]


def write_metrics(product: Product, plan: list[tuple[str, str, tuple[str, str, str] | None]]) -> tuple[Path, int]:
    base = base_rows(product.base_file)
    out = OUT / "metrics" / product.filename
    out.parent.mkdir(parents=True, exist_ok=True)
    rows = [_row(product, code, base[code]["Condition"], base[code]["Performance"], setting, scope) for code, setting, scope in plan]
    any_setting = sum(row[5] == ANY_SETTING for row in rows)
    with open(out, "w", newline="", encoding="utf-8") as handle:
        handle.write(
            f"# Broad Modelcard demo pack v13: Performance metrics of the fictional product {product.model_version} / {product.use_case}. "
            f"Synthetic demonstration data. All-population lens only: {any_setting} conditions at Any setting and {len(rows) - any_setting} "
            "rows at a specific care setting (others have no data).\n"
        )
        handle.write(
            f"# Written by demo/tools/make_pack_v13.py; every row comes from the fictional study {product.study.study_id}. "
            "Aggregate synthetic data only; never upload patient-level or real patient data. Not clinical evidence.\n"
        )
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(METRIC_HEADER)
        writer.writerows(rows)
    return out, len(rows)


def parlowe_plan() -> list[tuple[str, str, tuple[str, str, str] | None]]:
    scope = {code: ("Yes", "1.0", "In scope") for code in PARLOWE_IN_SCOPE}
    scope.update({code: ("Yes", "0.6", "Partially in scope") for code in PARLOWE_PARTLY})
    scope.update({code: ("No", "0.0", "Out of scope") for code in PARLOWE_OUT_OF_SCOPE})
    plan = [(code, ANY_SETTING, scope[code]) for code in (*PARLOWE_IN_SCOPE, *PARLOWE_PARTLY, *PARLOWE_OUT_OF_SCOPE)]
    plan += [(code, "Primary care", scope[code]) for code in PARLOWE_PRIMARY_CARE]
    plan += [(code, "Outpatient clinic", scope[code]) for code in PARLOWE_OUTPATIENT]
    return plan


def tallyfern_plan() -> list[tuple[str, str, tuple[str, str, str] | None]]:
    codes = tallyfern_conditions(base_rows(TALLYFERN_PRODUCT.base_file))
    inpatient = [code for code in codes if _fraction("Tallyfern-Coding-1.4", "inpatient", code) < TALLYFERN_INPATIENT_SHARE]
    return [(code, ANY_SETTING, None) for code in codes] + [(code, "Inpatient ward", None) for code in inpatient]


# ------------------------------------------------------------------ safety

SAFETY_HEADER = [
    "Incident ID", "Model version", "Function", "ICD-11 codes", "Age", "Sex", "Ethnicity", "Incident type", "Harm", "Status",
    "Source type", "Source reference", "Study ID", "Reported date", "Updated date", "Summary", "Scope", "Action",
]


def write_safety() -> Path:
    out = OUT / "safety" / "parlowe-answers-incident.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", newline="", encoding="utf-8") as handle:
        handle.write(
            "# Broad Modelcard demo pack v13: one safety incident of Parlowe-Answers-1.0 / Patient question answering. "
            "Aggregate synthetic data only. Never upload patient-level or real patient data.\n"
        )
        handle.write('"# Every incident, report, and notice below is fictional and synthetic. Nothing here describes a real event, product, or patient."\n')
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(SAFETY_HEADER)
        writer.writerow([
            "SI-2026-021", "Parlowe-Answers-1.0", "Patient question answering", "CA23", "", "", "", "Harmful or incorrect recommendation",
            "None", "Mitigated", "Incident report", "Fictional practice report PR-0042 (synthetic)", "", "2026-07-14", "2026-08-03",
            "Synthetic example: an answer about a reliever inhaler did not say when to seek urgent help; the developer added a "
            "warning-signs line to every asthma answer.",
            "Public", "",
        ])
    return out


def main() -> int:
    print(write_registry())
    print(write_studies())
    for product, plan in ((PARLOWE_PRODUCT, parlowe_plan()), (TALLYFERN_PRODUCT, tallyfern_plan())):
        path, count = write_metrics(product, plan)
        print(f"{path} ({count} rows)")
    print(write_safety())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
