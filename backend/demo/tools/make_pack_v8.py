"""DEMO PACK ONLY: write the files of demo pack v8 (contract v1.14, CONTRACT.md §28).

Not a data generator for the atlas: nothing here reads or writes a store. It
rewrites two committed files from committed pack files, so they can be
reviewed and reproduced. Running it twice gives byte-identical files.

* ``v8/registry.csv``: the pack v4 registry (``v4/registry.csv``) with the
  contract v1.14 columns: a fictional **configuration record** for most cards
  (language models: a prompt summary and its SHA-256, retrieval, tools,
  sampling; imaging products: fine-tuning), a **performance measure** and
  **reference standard** on every card, **data-protection declarations** on
  five cards, and **lineage**: SynGPT-2.0 replaces SynGPT-1.0, and the new
  fictional **Vantrel Triage 2.0** (the earlier release of Vantrel Triage,
  built on SynGPT-1.0) is replaced by Vantrel Triage 2.1. DoAIHaveCancer-1.0
  keeps no configuration record, so the absence can be seen. Every other value
  is copied unchanged, so no grade changes.
* ``v8/metrics/vantrel-triage-2-0.emergency-department-triage.csv``: the
  all-population metrics of Vantrel Triage 2.0 for a small set of emergency
  conditions (circulatory, respiratory, sepsis, injuries),
  derived from Vantrel Triage 2.1's pack v1 rows: performance and its interval
  lower by 0.035 plus a deterministic jitter in [-0.01, +0.01], samples x0.6
  (at least 24), every other column (evidence, intended use, warnings) copied,
  so every row with performance keeps its evidence. Fixed Source, Study, and
  Source date (2025-06-30).

The prompt checksums are SHA-256 digests of a fictional label, not of any
prompt. Every developer, product, contact, and link is fictional (.example).

Usage (from backend/):

    .venv/bin/python demo/tools/make_pack_v8.py
"""

from __future__ import annotations

import csv
import hashlib
from pathlib import Path

PACK = Path(__file__).resolve().parents[1]
V4_REGISTRY = PACK / "v4" / "registry.csv"
V2_1_METRICS = PACK / "v1" / "metrics" / "vantrel-triage-2-1.emergency-department-triage.csv"
OUT_REGISTRY = PACK / "v8" / "registry.csv"
OUT_METRICS = PACK / "v8" / "metrics" / "vantrel-triage-2-0.emergency-department-triage.csv"

NEW_COLUMNS = [
    "Replaces", "Configuration ID", "Configuration date", "Prompt summary", "Prompt SHA-256", "Retrieval", "Tools",
    "Sampling temperature", "Sampling top-p", "Max output tokens", "Fine-tuning", "Performance measure",
    "Reference standard", "Declared data use", "Declared data location", "Declared retention", "Declared privacy contact",
]

# The earlier release of Vantrel Triage (fictional), inserted before 2.1.
VANTREL_2_0 = {
    "Model version": "Vantrel-Triage-2.0", "Display name": "Vantrel Triage 2.0", "Model name": "Vantrel Triage", "Release": "2.0",
    "Status": "ACTIVE", "Use case": "Emergency department triage", "Default use case": "Yes", "Default model": "No",
    "Kind": "Product", "AI type": "Hybrid", "Developer": "Vantrel Clinical Systems (fictional)", "Release date": "2025-07-14",
    "Description": "Fictional earlier release of the Vantrel Triage product, built on SynGPT-1.0 with fewer triage rules; replaced by Vantrel Triage 2.1. Synthetic demonstration entry.",
    "Built on": "SynGPT-1.0", "Function category": "Triage",
    "Declared intended purpose": "Suggests an urgency level to the triage nurse, who sets the final level (fictional).",
    "Declared regulatory status": "Not assessed (demonstration)",
    "Declared contact": "demo-contact@vantrel-clinical-systems.example",
    "Declared documentation URL": "https://vantrel-clinical-systems.example/docs/vantrel-triage-2.0",
    "Intended use stated": "Yes",
}

TRIAGE_MEASURE = {
    "Performance measure": "Agreement with the expert urgency level (five-level scale)",
    "Reference standard": "Urgency level set afterwards by two senior triage nurses (fictional)",
}
DIAGNOSIS_MEASURE = {
    "Performance measure": "Top-3 diagnostic accuracy",
    "Reference standard": "Final diagnosis at discharge, from chart review (fictional)",
}
LETTER_MEASURE = {
    "Performance measure": "Share of letters signed without major edits",
    "Reference standard": "Review of each letter by a senior clinician (fictional)",
}
SKIN_MEASURE = {
    "Performance measure": "Accuracy of the referral decision",
    "Reference standard": "Histopathology or dermatologist follow-up (fictional)",
}


def llm(config_id, date, prompt, *, retrieval=None, tools=(), temperature, top_p, max_tokens, fine_tuning=None) -> dict:
    return {
        "Configuration ID": config_id, "Configuration date": date, "Prompt summary": prompt,
        "Retrieval": retrieval, "Tools": "; ".join(tools) or None, "Sampling temperature": temperature,
        "Sampling top-p": top_p, "Max output tokens": max_tokens, "Fine-tuning": fine_tuning,
    }


def imaging(config_id, date, fine_tuning) -> dict:
    return {"Configuration ID": config_id, "Configuration date": date, "Fine-tuning": fine_tuning}


def protection(use, location, retention, contact) -> dict:
    return {"Declared data use": use, "Declared data location": location, "Declared retention": retention, "Declared privacy contact": contact}


# (model version, function) → the v1.14 cells. Fictional throughout.
CARDS: dict[tuple[str, str], dict] = {
    ("SynGPT-1.0", "Clinician Facing CDSS"): {
        **llm("cfg-syngpt1-cdss-2024-04", "2024-04-15",
              "Answers clinicians' diagnostic questions with a ranked differential and next steps, asks for missing findings, and gives no dosing advice (fictional).",
              temperature=0.3, top_p=0.95, max_tokens=1024,
              fine_tuning="Instruction-tuned on synthetic clinical question-and-answer pairs (fictional)."),
        **DIAGNOSIS_MEASURE,
    },
    ("SynGPT-1.0", "Discharge letter generation"): {
        **llm("cfg-syngpt1-letters-2024-04", "2024-04-15",
              "Drafts a discharge letter from the structured record in the hospital's template and marks every uncertain item for review (fictional).",
              retrieval="Letter template library of the hospital (fictional)", temperature=0.2, top_p=0.9, max_tokens=2048),
        **LETTER_MEASURE,
    },
    ("SynGPT-2.0", "Clinician Facing CDSS"): {
        "Replaces": "SynGPT-1.0",
        **llm("cfg-2025-06-cdss", "2025-06-02",
              "Answers clinicians' diagnostic questions with a ranked differential, cites the guideline passage it used, and gives no dosing advice (fictional).",
              retrieval="Fictional national guideline collection, updated monthly", tools=("guideline_search", "lab_reference_ranges"),
              temperature=0.2, top_p=0.9, max_tokens=1200),
        **DIAGNOSIS_MEASURE,
        **protection(
            "Uses the question and the record extract the clinician shares; nothing is kept after the answer or used for training (fictional).",
            "Servers run by the hospital in the EU (fictional)", "Not kept after the session (fictional)",
            "privacy@synthetica-health-labs.example",
        ),
    },
    ("SynGPT-2.0", "Discharge letter generation"): {
        "Replaces": "SynGPT-1.0",
        **llm("cfg-2025-06-letters", "2025-06-02",
              "Drafts a discharge letter from the structured record in the hospital's template, lists the medication changes, and marks uncertain items (fictional).",
              retrieval="Letter template library of the hospital (fictional)", tools=("medication_list",),
              temperature=0.2, top_p=0.9, max_tokens=2048),
        **LETTER_MEASURE,
    },
    ("MediCore-2.5", "Discharge letter generation"): {
        **llm("cfg-medicore-letters-2025-03", "2025-03-10",
              "Writes a discharge summary for ward clinicians to edit, in plain sections: reason for admission, course, plan (fictional).",
              temperature=0.3, top_p=0.9, max_tokens=1800,
              fine_tuning="Fine-tuned on synthetic ward documentation (fictional)."),
        **LETTER_MEASURE,
    },
    ("MediCore-2.5", "Clinician Facing CDSS"): {
        **llm("cfg-medicore-cdss-2025-03", "2025-03-10",
              "Offers guideline-based suggestions during ward rounds and says when a question is outside its scope (fictional).",
              retrieval="Fictional ward guideline handbook", temperature=0.2, top_p=0.9, max_tokens=900,
              fine_tuning="Fine-tuned on synthetic ward documentation (fictional)."),
        **DIAGNOSIS_MEASURE,
    },
    ("ICU_GPT-1.0", "CDSS"): {
        **llm("cfg-icu-2025-09", "2025-09-29",
              "Flags deterioration risks from vital-sign trends and labs, suggests checks, and never suggests treatment changes (fictional).",
              retrieval="ICU protocols of the deploying unit (fictional)", tools=("vitals_trend", "lab_lookup"),
              temperature=0.1, top_p=0.8, max_tokens=600),
        "Performance measure": "Sensitivity for deterioration within 12 hours",
        "Reference standard": "Unplanned escalation of care recorded in the chart (fictional)",
    },
    ("radAIology-1", "Radiology image analysis"): {
        **imaging("cfg-radaiology-2024-11", "2024-11-20", "Trained on synthetic chest and head images labelled by radiologists (fictional)."),
        "Performance measure": "Sensitivity for findings the reference panel marked",
        "Reference standard": "Consensus of three radiologists (fictional)",
        **protection(
            "Analyses the images the hospital's image archive sends; no image leaves the hospital (fictional).",
            "On-premises server in the radiology department (fictional)", "Images are not kept after the analysis (fictional)",
            "privacy@tessellate-imaging.example",
        ),
    },
    ("SkinAI-1.0", "Skin lesion CDSS"): {
        **imaging("cfg-skinai-2024-08", "2024-08-05", "Trained on a synthetic dermoscopy image set (fictional)."),
        **SKIN_MEASURE,
    },
    ("DoAIHaveCancer-1.0", "Skin lesion CDSS"): {
        # No configuration record: the absence is part of the demonstration.
        "Performance measure": "Accuracy of the referral decision",
        "Reference standard": "Dermatologist assessment of the same photo (fictional)",
    },
    ("Quillary-Scribe-1.0", "Discharge letter generation"): {
        **llm("cfg-quillary-2026-02", "2026-02-16",
              "Drafts the discharge letter inside the ward workflow from the record of the patient being discharged; the clinician edits and signs it (fictional).",
              retrieval="The patient's ward record and the hospital's letter templates (fictional)",
              tools=("ehr_record_fetch", "letter_template"), temperature=0.2, top_p=0.9, max_tokens=2048),
        **LETTER_MEASURE,
        **protection(
            "Reads the ward record of the patient being discharged; drafts stay in the hospital record system (fictional).",
            "Runs inside the hospital network (fictional)", "Drafts are deleted after sign-off or after 14 days (fictional)",
            "privacy@quillary-health-software.example",
        ),
    },
    ("Vantrel-Triage-2.0", "Emergency department triage"): {
        **llm("cfg-vantrel-2025-07", "2025-07-14",
              "Suggests a five-level urgency from the triage note; the nurse sets the final level (fictional).",
              tools=("triage_scale",), temperature=0.2, top_p=0.95, max_tokens=300),
        **TRIAGE_MEASURE,
    },
    ("Vantrel-Triage-2.1", "Emergency department triage"): {
        "Replaces": "Vantrel-Triage-2.0",
        **llm("cfg-vantrel-2026-05", "2026-05-04",
              "Suggests a five-level urgency from the triage note and vital signs, with fixed rules for red flags; the nurse sets the final level (fictional).",
              tools=("vital_signs_rules", "triage_scale"), temperature=0.0, top_p=1.0, max_tokens=300),
        **TRIAGE_MEASURE,
        **protection(
            "Uses the triage note and vital signs of the current visit only (fictional).",
            "The developer's cloud service in the EU (fictional)", "Visit data is deleted after 30 days (fictional)",
            "privacy@vantrel-clinical-systems.example",
        ),
    },
    ("Corvessa-Skin-Review-1.2", "Skin lesion CDSS"): {
        **imaging("cfg-corvessa-2025-09", "2025-09-22", "Adapted to teledermatology photos from three fictional clinics."),
        "Performance measure": "Accuracy of the urgency sorting",
        "Reference standard": "Dermatologist review of every photo within a week (fictional)",
        **protection(
            "Processes the lesion photos the clinic sends for review; photos are linked to the referral, not to a name (fictional).",
            "The developer's cloud service in the EU (fictional)", "Photos are deleted 90 days after the review (fictional)",
            "privacy@corvessa-imaging.example",
        ),
    },
}


def prompt_digest(model_version: str, use_case: str, config_id: str) -> str:
    """A fictional checksum: the SHA-256 of a label, not of any prompt."""
    return hashlib.sha256(f"Fictional prompt label: {model_version} | {use_case} | {config_id}".encode()).hexdigest()


def cell(value) -> str:
    return "" if value is None else str(value)


def write_registry() -> Path:
    with open(V4_REGISTRY, newline="", encoding="utf-8") as handle:
        lines = [line for line in csv.reader(handle) if line]
    body = [line for line in lines if not line[0].startswith("#")]
    header, rows = body[0], [dict(zip(body[0], line, strict=True)) for line in body[1:]]
    index = next(position for position, row in enumerate(rows) if row["Model version"] == "Vantrel-Triage-2.1")
    rows.insert(index, dict(VANTREL_2_0))
    OUT_REGISTRY.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_REGISTRY, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        # Comment lines are written as they are, never quoted (as in the earlier pack files).
        handle.write(
            "# Broad Modelcard demo pack v8: AI systems & functions with the contract v1.14 columns (configuration records, "
            "lineage, performance measures, data-protection declarations). Synthetic demonstration data; every developer, "
            "product, contact, and link is fictional.\n"
        )
        handle.write(
            "# Written by demo/tools/make_pack_v8.py from v4/registry.csv. SynGPT-2.0 replaces SynGPT-1.0; the new fictional "
            "Vantrel Triage 2.0 is replaced by Vantrel Triage 2.1. Prompt checksums are digests of fictional labels.\n"
        )
        writer.writerow([*header, *NEW_COLUMNS])
        for row in rows:
            key = (row["Model version"], row["Use case"])
            extra = dict(CARDS[key])
            if extra.get("Prompt summary"):
                extra["Prompt SHA-256"] = prompt_digest(*key, extra["Configuration ID"])
            writer.writerow([*(row[name] for name in header), *(cell(extra.get(name)) for name in NEW_COLUMNS)])
    return OUT_REGISTRY


# Emergency conditions of Vantrel Triage 2.0 (ICD-11 code prefixes): circulatory, respiratory, sepsis, injuries.
PREFIXES = ("BA", "BB", "BC", "BD", "BE", "CA", "CB", "1G4", "NA", "NB")
OFFSET = -0.035
SAMPLE_FACTOR = 0.6
MIN_SAMPLES = 24
SOURCE = ["Demo pack v8: Vantrel Triage 2.0 validation (synthetic)", "DEMO-VANTREL-2-0-2025", "2025-06-30"]


def jitter(code: str) -> float:
    digest = hashlib.sha256(f"Vantrel-Triage-2.0|{code}".encode()).digest()
    return (int.from_bytes(digest[:4], "big") / 0xFFFFFFFF - 0.5) * 0.02


def _shifted(text: str, shift: float) -> float | None:
    return None if not text.strip() else round(min(1.0, max(0.0, float(text) + shift)), 3)


def write_metrics() -> Path:
    with open(V2_1_METRICS, newline="", encoding="utf-8") as handle:
        body = [line for line in csv.reader(handle) if line and not line[0].startswith("#")]
    header, rows = body[0], body[1:]
    column = {name: position for position, name in enumerate(header)}
    out_rows = []
    for row in rows:
        code = row[column["ICD-11 code"]]
        if not code.startswith(PREFIXES):
            continue
        out = list(row)
        shift = OFFSET + jitter(code)
        perf, low, high = (_shifted(row[column[name]], shift) for name in ("Performance", "CI low", "CI high"))
        if perf is not None:
            low = None if low is None else min(low, perf)
            high = None if high is None else max(high, perf)
        for name, value in (("Performance", perf), ("CI low", low), ("CI high", high)):
            out[column[name]] = "" if value is None else repr(value)
        samples = row[column["Samples"]].strip()
        if samples:
            out[column["Samples"]] = str(max(MIN_SAMPLES, round(int(samples) * SAMPLE_FACTOR)))
        out[column["Source"]], out[column["Study"]], out[column["Source date"]] = SOURCE
        out_rows.append(out)
    OUT_METRICS.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_METRICS, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        handle.write(
            "# Broad Modelcard demo pack v8: Performance metrics of the fictional product Vantrel-Triage-2.0 / Emergency department "
            f"triage. Synthetic demonstration data. All-population lens only: {len(out_rows)} emergency conditions (others have no data).\n"
        )
        handle.write(
            "# Derived by demo/tools/make_pack_v8.py from Vantrel Triage 2.1's pack v1 rows (offset -0.035 and samples x0.6). "
            "Not clinical evidence.\n"
        )
        writer.writerow(header)
        writer.writerows(out_rows)
    return OUT_METRICS


def main() -> int:
    print(write_registry())
    print(write_metrics())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
