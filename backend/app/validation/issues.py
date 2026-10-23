"""Problems found in an upload, grouped by kind (openapi.json ``IssueGroup``).

Each problem code has a plain-language message and fix. Errors block
publishing; notes do not. A group counts every occurrence but keeps at most
``MAX_EXAMPLES`` examples. Every problem tied to a cell (or a row) is also kept
as a mark for the annotated file, up to ``MAX_MARKS``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

MAX_EXAMPLES = 20
MAX_MARKS = 50_000


@dataclass(frozen=True)
class IssueKind:
    message: str
    fix: str
    blocking: bool = True


ISSUES: dict[str, IssueKind] = {
    # The file as a whole.
    "unreadable_file": IssueKind(
        "The file could not be read.",
        "Save it again from your spreadsheet program as .xlsx (Excel workbook) or as CSV UTF-8, then upload it again.",
    ),
    "empty_file": IssueKind(
        "The file has no data rows.",
        "Fill in at least one row below the header row, or download a fresh template.",
    ),
    "wrong_template": IssueKind(
        "This file uses the template of another data set.",
        "Upload it under the data set it belongs to, or download the template for this data set.",
    ),
    "missing_column": IssueKind(
        "A column of the template is missing.",
        "Add the missing column with exactly the header from the template (download the template to compare).",
    ),
    "extra_column": IssueKind(
        "The file has a column the template does not have.",
        "Delete the column or rename it to a column of the template.",
    ),
    "duplicate_column": IssueKind(
        "A column appears twice.",
        "Keep one of the two columns and delete the other.",
    ),
    "too_many_rows": IssueKind(
        "The file has more rows than this data set can hold.",
        "Check for repeated or stray rows; a full metrics file has at most one row per condition and demographic group.",
    ),
    # The target chosen at upload.
    "unknown_target": IssueKind(
        "The AI system or function chosen for this upload does not exist.",
        "Choose an AI system and function from the registry, or add them under AI systems & functions first.",
    ),
    # Cells.
    "missing_value": IssueKind(
        "A required cell is empty.",
        "Fill in the cell; the column description in the template says what it needs.",
    ),
    "unknown_icd_code": IssueKind(
        "An ICD-11 code is not in the atlas or cannot carry data here.",
        "Check the code for typos. Metrics belong on top-level conditions (e.g. 5A11, not 5A11.0).",
    ),
    "unknown_lens_value": IssueKind(
        "A demographic group is not one the atlas knows.",
        "Pick the value from the dropdown, or copy it exactly from the template (e.g. \"Age 65+\").",
    ),
    # Contract v1.14 (CONTRACT.md §29).
    "unknown_setting": IssueKind(
        "A setting is not one of the care settings the atlas knows.",
        "Write Emergency department, Intensive care, Inpatient ward, Outpatient clinic, or Primary care for a result measured "
        "in that setting only, or leave the cell empty (or write Any setting) for a result that holds across settings.",
    ),
    "not_a_number": IssueKind(
        "A cell that needs a number holds something else.",
        "Enter a plain number such as 0.84, without % signs or text, or leave the cell empty.",
    ),
    "not_a_whole_number": IssueKind(
        "A count is not a whole number.",
        "Enter a whole number such as 1200.",
    ),
    "out_of_range": IssueKind(
        "A number is outside its allowed range.",
        "Performance, confidence bounds, coverage, and sampling top-p are shares between 0 and 1 (write 0.84, not 84); sampling temperature lies between 0 and 2. Counts cannot be negative, and max output tokens is at least 1.",
    ),
    "ci_low_above_ci_high": IssueKind(
        "The lower confidence bound is above the upper bound.",
        "Swap the two values or correct them so that CI low ≤ CI high.",
    ),
    "perf_outside_ci": IssueKind(
        "Performance lies outside its own confidence interval.",
        "Correct Performance, CI low, or CI high so that CI low ≤ Performance ≤ CI high.",
    ),
    "unknown_evidence_grade": IssueKind(
        "An evidence grade is not A, B, C, D, E, or F.",
        "Use one letter from A (strongest) to F, or leave the cell empty.",
    ),
    "unknown_validation_type": IssueKind(
        "A validation type is not one the atlas knows.",
        "Pick the validation type from the dropdown, or leave the cell empty if the AI system was not validated.",
    ),
    "performance_without_evidence": IssueKind(
        "A row gives a performance value without evidence.",
        "Add the evidence on the same row (Validation type, and Samples, Studies, and Sites where known), or leave Performance, CI low, and CI high empty until the evidence is known.",
    ),
    "unknown_intended_use_level": IssueKind(
        "An intended-use level is not one the atlas knows.",
        "Use \"In scope\", \"Partially in scope\", or \"Out of scope\".",
    ),
    "invalid_yes_no": IssueKind(
        "A Yes/No cell holds something else.",
        "Enter Yes or No.",
    ),
    "invalid_warning_code": IssueKind(
        "A warning code is not written as a code.",
        "Write warning codes in lower case with underscores, separated by \";\", e.g. clinician_review_required.",
    ),
    "unknown_tier": IssueKind(
        "A commonness tier is not one the atlas knows.",
        "Use Very rare, Rare, Uncommon, Common, or Very common.",
    ),
    "unknown_status": IssueKind(
        "A status is not one the atlas knows.",
        "Use ACTIVE or EXPERIMENTAL.",
    ),
    "invalid_value": IssueKind(
        "A value is too long or malformed.",
        "Shorten the value, without line breaks: identifiers take at most 64 characters, names 200, descriptions 280, and declarations 500.",
    ),
    # Registry entry fields (contract v1.5).
    "unknown_kind": IssueKind(
        "A kind is not Model or Product.",
        "Write Model for a general AI model, or Product for an AI system packaged for a clinical purpose. An empty cell means Model.",
    ),
    "unknown_ai_type": IssueKind(
        "An AI type is not one the atlas knows.",
        "Pick the AI type from the dropdown (Large language model, Imaging model, Tabular risk model, Rule-based system, or Hybrid), or leave the cell empty.",
    ),
    "unknown_function_category": IssueKind(
        "A function category is not one the atlas knows.",
        "Pick the category from the dropdown (Decision support, Documentation, Image analysis, Triage, Patient communication, or Administrative), or leave the cell empty.",
    ),
    "invalid_date": IssueKind(
        "A date is not a valid calendar date in the form YYYY-MM-DD.",
        "Write the date as year-month-day, e.g. 2026-03-01. If a spreadsheet program changed it, format the column as text and type it again.",
    ),
    "invalid_url": IssueKind(
        "A link is not a web address starting with https:// or http://.",
        "Paste the full address, e.g. https://developer.example/docs, or leave the cell empty.",
    ),
    "built_on_for_model": IssueKind(
        "An AI system whose kind is Model lists models under Built on.",
        "Only products are built on models: set Kind to Product on every row of this AI system, or clear Built on.",
    ),
    "unknown_built_on": IssueKind(
        "Built on names something that is not a model in this file.",
        "List the model versions of other AI systems in this file whose Kind is Model, separated by \";\". A product cannot be built on itself or on another product.",
    ),
    # Configurations and lineage (contract v1.14, §28).
    "invalid_configuration_id": IssueKind(
        "A configuration ID is not a short label.",
        'Use at most 64 letters, digits, ".", "_", or "-", e.g. cfg-2026-09, or leave the cell empty.',
    ),
    "invalid_sha256": IssueKind(
        "A prompt SHA-256 is not a checksum.",
        "Paste the 64-character SHA-256 checksum of the full prompt (digits 0-9 and letters a-f), or leave the cell empty. Never paste the prompt itself.",
    ),
    "too_many_tools": IssueKind(
        "More than 10 tools are listed.",
        'List at most 10 tool names, separated by ";", each at most 60 characters.',
    ),
    "replaces_self": IssueKind(
        "An AI system replaces itself.",
        "Under Replaces, name the earlier version this AI system supersedes, not its own model version, or leave the cell empty.",
    ),
    "unknown_replaces": IssueKind(
        "Replaces names an AI system that is not in this file.",
        "Name the model version of another AI system in this file (keep the earlier version's rows in the file), or leave the cell empty.",
    ),
    "replaces_cycle": IssueKind(
        "The versions replace each other in a loop.",
        "A version can only replace an older one. Clear Replaces on the oldest version of the chain.",
    ),
    "separator_in_name": IssueKind(
        "A model version or function contains | or ,.",
        "Use a name without | or ,. Card links join the model version and the function with | and list cards with commas.",
    ),
    # Rows and keys.
    "duplicate_key": IssueKind(
        "The same record appears more than once.",
        "Keep one row per record and delete the repeats.",
    ),
    "incomplete_lens_coverage": IssueKind(
        "Some records lack rows for demographic groups that other records have.",
        "Give every record the same demographic groups: add the missing rows or remove the extra groups everywhere.",
    ),
    "invalid_condition_set": IssueKind(
        "A condition combination is not a set of two or more different conditions.",
        "Join two to twelve different top-level condition codes with \"+\", e.g. 5A11 + BA00.",
    ),
    "inconsistent_value": IssueKind(
        "Rows of the same record disagree.",
        "Give every row of the record the same value in this column. In AI systems & functions, this applies to the columns that describe the AI system (Display name, Model name, Release, Status, Kind, AI type, Developer, Release date, Description, Built on, Replaces). An empty cell counts as a different value.",
    ),
    "invalid_default": IssueKind(
        "More than one default is marked.",
        "Mark at most one default function per AI system, and at most one AI system as the default.",
    ),
    "use_case_without_metrics": IssueKind(
        "A function has no performance metrics yet.",
        "Publish its performance metrics first (Performance metrics, then choose this AI system and function), then upload this file again.",
    ),
    # Notes (non-blocking).
    "very_wide_confidence_interval": IssueKind(
        "Some confidence intervals are very wide (more than 0.25).",
        "Check the bounds. Wide intervals are allowed and shown as uncertain.",
        blocking=False,
    ),
    "unfamiliar_warning_code": IssueKind(
        "Some warning codes are new to the atlas.",
        "Check the spelling. New codes are allowed and shown with a generic description.",
        blocking=False,
    ),
    "grade_without_validation_type": IssueKind(
        "Some rows have an evidence grade but no validation type.",
        "The atlas treats these rows as not validated and ignores the grade. Add the validation type if the AI system was validated.",
        blocking=False,
    ),
    "scope_mismatch": IssueKind(
        "Some rows say \"In intended use: No\" with a level other than out of scope.",
        "The atlas treats these rows as out of scope. Check In intended use and Intended-use level.",
        blocking=False,
    ),
    "formula_like_text": IssueKind(
        "Some text values start with =, +, -, or @, which spreadsheet programs may run as a formula.",
        "Nothing to do if the text is right. Downloaded templates and checked copies put an apostrophe (') in front of such values so that spreadsheet programs show them as text; uploads drop it again.",
        blocking=False,
    ),
    "target_not_published": IssueKind(
        "The AI system or function is in a staged update of AI systems & functions that is not published yet.",
        "You can publish this upload now; it appears on the atlas once that update is published.",
        blocking=False,
    ),
    # Merge uploads and provenance (contract v1.7).
    "unknown_action": IssueKind(
        "An action is not one the template knows.",
        "Write Remove to delete the record, or leave the cell empty (or write Add or replace) to add or replace it.",
    ),
    # Local populations (contract v1.10): aggregate data only.
    "patient_level_data": IssueKind(
        "The file looks like it holds patient-level data.",
        "A local population holds one commonness tier per condition for the whole population, nothing per person. "
        "Delete columns with identifiers, names, dates of birth, addresses, or values per patient, and give each code "
        "one row only. Never upload patient data, not even for a test.",
    ),
    # A prevalence replace upload that would drop most default tiers (CONTRACT.md §11).
    "prevalence_incomplete": IssueKind(
        "This file would remove the tiers of most conditions from the default prevalence.",
        "To add a local population, use Local populations; to change some codes, use Add or change rows.",
    ),
    "remove_in_replace": IssueKind(
        "A row says Remove, but this upload replaces the whole data set.",
        "Upload the file as a merge to remove single records. In a replace upload, leave the record out of the file instead.",
    ),
    "missing_provenance": IssueKind(
        "A row has no complete source.",
        "Fill in Source, Study, and Source date (YYYY-MM-DD). A merge upload needs them on every row that adds or replaces a record; a replace upload needs Source whenever Study or Source date is given.",
    ),
    # Safety incidents (contract v1.7).
    "unknown_configuration": IssueKind(
        "An incident or effect names a card (AI system and function) the registry does not have.",
        "Check Model version and Function against AI systems & functions (they must match exactly), or add the card there first.",
    ),
    "unknown_incident_type": IssueKind(
        "An incident type is not one the atlas knows.",
        "Pick the type from the dropdown: Harmful or incorrect recommendation, Fabricated content, Subgroup bias, Performance drift, Developer notice or recall, or Other.",
    ),
    "unknown_harm": IssueKind(
        "A harm value is not Occurred, Possible, or None.",
        "Write Occurred if a patient was harmed, Possible if harm could have occurred, or None.",
    ),
    "unknown_incident_status": IssueKind(
        "An incident status is not Open, Mitigated, or Closed.",
        "Write Open, Mitigated, or Closed.",
    ),
    "unknown_source_type": IssueKind(
        "A source type is not Study, Incident report, or Developer notice.",
        "Pick the source type from the dropdown.",
    ),
    "missing_study_id": IssueKind(
        "An incident from a study has no Study ID.",
        "Fill in the study's identifier in Study ID, or choose another Source type.",
    ),
    # Studies (contract v1.13).
    "unknown_study_design": IssueKind(
        "A study design is not one the atlas knows.",
        "Pick the design from the dropdown: Vignette, Simulation, Benchmark, Retrospective, Prospective, Real-world deployment, or Randomized trial.",
    ),
    "unknown_study_conductor": IssueKind(
        "Conducted by is not Developer, Independent, or Hospital.",
        "Write Developer if the AI system's developer ran the study, Independent for an independent group, or Hospital for a hospital's own evaluation.",
    ),
    "unknown_reporting_guideline": IssueKind(
        "A reporting guideline is not one the atlas knows.",
        "Pick the guideline from the dropdown: None, TRIPOD+AI, STARD-AI, CONSORT-AI, DECIDE-AI, or Other.",
    ),
    "unknown_guideline_followed": IssueKind(
        "Guideline followed is not Yes, Partly, or No.",
        "Write Yes, Partly, or No.",
    ),
    "missing_guideline_followed": IssueKind(
        "A study names a reporting guideline but not whether it was followed.",
        "Fill in Guideline followed with Yes, Partly, or No, or set Reporting guideline to None.",
    ),
    "guideline_followed_without_guideline": IssueKind(
        "Guideline followed is filled in although the reporting guideline is None.",
        "Leave Guideline followed empty, or name the reporting guideline the study used.",
    ),
    "unknown_risk_of_bias": IssueKind(
        "A risk of bias is not Low, Some concerns, High, or Unclear.",
        "Write the overall judgement: Low, Some concerns, High, or Unclear.",
    ),
    # Contract v1.14 (§22): optional study fields, never graded.
    "unknown_applicability": IssueKind(
        "Applicability concerns are not Low, High, or Unclear.",
        "Write the overall judgement of how well the study matches the intended use: Low, High, or Unclear, or leave the cell empty.",
    ),
    "unknown_quality_tool": IssueKind(
        "An appraisal tool is not PROBAST+AI, APPRAISE-AI, QUADAS-AI, or Other.",
        "Write PROBAST+AI, APPRAISE-AI, QUADAS-AI, or Other, or leave the cell empty.",
    ),
    "quality_score_without_tool": IssueKind(
        "An appraisal score is given without the appraisal tool that gave it.",
        "Fill in Appraisal tool (e.g. APPRAISE-AI), or leave Appraisal score empty.",
    ),
    "unknown_setting_category": IssueKind(
        "A setting category is not one of the six categories.",
        "Write Emergency department, Intensive care, Inpatient ward, Outpatient clinic, Primary care, or Mixed, or leave the cell empty; Setting keeps the free text.",
    ),
    "invalid_study_configuration": IssueKind(
        "A configuration evaluated is not a valid label.",
        "Use letters, digits, \".\", \"_\", and \"-\" only, at most 64 characters, e.g. cfg-2026-03, or leave the cell empty.",
    ),
    "unknown_study_model": IssueKind(
        "Model version evaluated names an AI system the registry does not have.",
        "Check the model version against AI systems & functions (it must match exactly), add the AI system there first, or leave the cell empty.",
    ),
    "unknown_study": IssueKind(
        "Some rows name a study that is not in Studies.",
        "Nothing to do if the study is free text. To grade these rows with a study record, add the study under Studies with exactly this Study ID.",
        blocking=False,
    ),
    "configuration_not_in_registry": IssueKind(
        "A study names a configuration that its AI system's cards do not list.",
        "Nothing to do if the study evaluated an earlier configuration: the condition card says so. Otherwise check Configuration evaluated against the Configuration ID of the AI system's cards in AI systems & functions.",
        blocking=False,
    ),
    "model_not_published": IssueKind(
        "A study names an AI system that is only in a staged update of AI systems & functions.",
        "You can publish the studies now; the link to the AI system shows once that update is published.",
        blocking=False,
    ),
    # Effects on outcomes (contract v1.13, CONTRACT.md §27).
    "unknown_effect_study": IssueKind(
        "An effect names a study that is not in Studies.",
        "Check Study ID against Studies (it must match exactly). If the study is new, add it under Studies and publish it first, then upload the effects again.",
    ),
    "effect_study_design": IssueKind(
        "An effect names a study whose design cannot show an effect on outcomes.",
        "Effects need a study that compared care with and without the AI system: a randomized trial, a prospective study, or a real-world deployment. Link the effect to such a study, or correct the study's design under Studies.",
    ),
    "unknown_outcome_type": IssueKind(
        "Outcome type is not Benefit, Harm, or Process.",
        "Write Benefit for a gain for patients, Harm for a harm, or Process for a measure of how care runs (for example a waiting time).",
    ),
    "unknown_effect_measure": IssueKind(
        "An effect measure is not one the atlas knows.",
        "Pick the measure from the dropdown: Risk ratio, Odds ratio, Hazard ratio, Risk difference, Mean difference, or Standardized mean difference.",
    ),
    "unknown_effect_direction": IssueKind(
        "Direction of benefit is not Higher is better or Lower is better.",
        "Write Higher is better when a larger value favours the AI system (for example more patients treated in time), or Lower is better (for example fewer deaths or shorter waits).",
    ),
    "unknown_appraisal_tool": IssueKind(
        "Appraisal tool is not RoB 2 or ROBINS-I.",
        "Write RoB 2 for a randomized trial, or ROBINS-I for a prospective study or a real-world deployment.",
    ),
    "appraisal_tool_mismatch": IssueKind(
        "The appraisal tool does not fit the study's design.",
        "Use RoB 2 when the study is a randomized trial, and ROBINS-I when it is a prospective study or a real-world deployment.",
    ),
    "unknown_effect_judgement": IssueKind(
        "A risk-of-bias judgement is not one the atlas knows.",
        "Write the overall judgement: Low, Some concerns, High, Critical (ROBINS-I only), or Unclear. A ROBINS-I Moderate is Some concerns, and Serious is High.",
    ),
    "judgement_not_in_tool": IssueKind(
        "Critical is a ROBINS-I judgement, but the effect is appraised with RoB 2.",
        "RoB 2 ends at High: write High, or check whether the study is really a randomized trial.",
    ),
    "effect_ci_order": IssueKind(
        "The estimate is not inside its confidence interval.",
        "Check the three numbers: CI low must not be above Estimate, and CI high must not be below it.",
    ),
    "effect_ratio_not_positive": IssueKind(
        "A ratio (risk, odds, or hazard) is 0 or below.",
        "Ratios are always above 0, and 1 means no effect. If the numbers are a difference, choose a difference measure instead.",
    ),
    # Notes (non-blocking) of merge uploads and safety incidents.
    "newer_study_kept": IssueKind(
        "Some rows come from an older study than the stored data; the newer study stays.",
        "Nothing to do if that is right. To replace the stored values anyway, give these rows a source date that is not older than the stored one.",
        blocking=False,
    ),
    "nothing_to_remove": IssueKind(
        "Some rows remove records that do not exist.",
        "Check the keys of these rows (code and demographic group, incident ID, study ID, or effect ID). Nothing changes for them.",
        blocking=False,
    ),
    "new_lens_group": IssueKind(
        "The merge adds rows for a demographic group or care setting the stored data does not have.",
        "Other conditions read No data for that group until they get rows too.",
        blocking=False,
    ),
    "configuration_not_published": IssueKind(
        "An incident or effect names a card that is only in a staged update of AI systems & functions.",
        "You can publish them now; they appear on the card once that update is published.",
        blocking=False,
    ),
    # Contract v1.13 (CONTRACT.md §26): local results, scopes, submissions, narrow model cards.
    "unknown_population": IssueKind(
        "The local population named here does not exist.",
        "Publish the local population under Local populations first, or use the id of a published one (e.g. northbridge-region).",
    ),
    "local_study_missing": IssueKind(
        "A local result names no study.",
        "Write the Study ID of the hospital evaluation behind this row in the Study column. Add the evaluation under Studies first, with Scope Hospital and this local population.",
    ),
    "local_study_mismatch": IssueKind(
        "A local result names a study that is not a hospital evaluation of this local population.",
        "Under Studies, give the evaluation Scope Hospital and this Local population, or name the Study ID of an evaluation that has them.",
    ),
    "unknown_scope": IssueKind(
        "A scope is not Public or Hospital.",
        "Write Public (a published or developer study, or a public incident) or Hospital (this hospital's own).",
    ),
    "population_without_hospital_scope": IssueKind(
        "A public record names a local population.",
        "Leave Local population empty for a public record, or set Scope to Hospital.",
    ),
    "registry_remove_unsupported": IssueKind(
        "A submission cannot remove an AI system.",
        "Leave Action empty: a submission adds or replaces one AI system's entry. A maintainer removes entries with a replace upload.",
    ),
    "invalid_model_card": IssueKind(
        "The narrow model card could not be read.",
        "Check the file against the JSON example in the Data Library, or save it as Markdown with simple front matter.",
    ),
    "model_card_field": IssueKind(
        "A field of the narrow model card has a wrong value.",
        "Correct the field as the problem says; the JSON example in the Data Library shows every field.",
    ),
    "unsupported_front_matter": IssueKind(
        "Part of the Markdown front matter is not simple key: value text.",
        "Convert this part to JSON: only flat key: value lines and simple lists are read from Markdown front matter. The Markdown text is kept as it is.",
        blocking=False,
    ),
    # Contract v1.14 (CONTRACT.md §32.2): evaluation results files.
    "invalid_evaluation_file": IssueKind(
        "The evaluation results file could not be read.",
        "Save it as one JSON object in the format bmc-evaluation-results/1; docs/evaluation-results-example.json shows every field.",
    ),
    "evaluation_field": IssueKind(
        "A field of the evaluation results has a wrong or missing value.",
        "Correct the field as the problem says; docs/evaluation-results.md describes every field.",
    ),
    "measure_differs_from_card": IssueKind(
        "A result measures something other than the card's performance measure.",
        "Nothing blocks this. Check that the values can stand beside the card's figures, or correct the measure.",
        blocking=False,
    ),
    "configuration_not_current": IssueKind(
        "The run evaluated another configuration than the card's current one.",
        "Nothing blocks this. The condition card will name the configuration its results were measured on; import a run of the current configuration when you can.",
        blocking=False,
    ),
    "unknown_result_code": IssueKind(
        "A result names an ICD-11 code the atlas does not have; it will not be proposed as a metric record.",
        "Nothing to do if the code is not an ICD-11 condition. Otherwise use the code of a top-level ICD-11 condition.",
        blocking=False,
    ),
}


@dataclass
class IssueGroup:
    code: str
    message: str
    fix: str
    count: int = 0
    examples: list[dict] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {"code": self.code, "message": self.message, "fix": self.fix, "count": self.count, "examples": self.examples}


@dataclass(frozen=True)
class Mark:
    """A problem tied to a row (and a column, when known), for the annotated file."""

    row: int
    column: str | None
    problem: str
    blocking: bool


def _shown(value: Any) -> str | None:
    if value is None:
        return None
    text = value if isinstance(value, str) else repr(value) if isinstance(value, float) else str(value)
    return text if len(text) <= 120 else text[:117] + "..."


class Issues:
    """Collects problems in order of first occurrence."""

    def __init__(self) -> None:
        self.groups: dict[str, IssueGroup] = {}
        self.marks: list[Mark] = []
        self.marks_truncated = False

    def add(
        self,
        code: str,
        row: int,
        problem: str,
        *,
        column: str | None = None,
        value: Any = None,
        fix: str | None = None,
        mark: bool = True,
    ) -> None:
        kind = ISSUES[code]
        group = self.groups.get(code)
        if group is None:
            group = self.groups[code] = IssueGroup(code, kind.message, fix or kind.fix)
        group.count += 1
        if len(group.examples) < MAX_EXAMPLES:
            group.examples.append({"row": row, "column": column, "value": _shown(value), "problem": problem})
        if mark and row > 0:
            if len(self.marks) < MAX_MARKS:
                self.marks.append(Mark(row, column, problem, kind.blocking))
            else:
                self.marks_truncated = True

    @property
    def has_errors(self) -> bool:
        return any(ISSUES[code].blocking for code in self.groups)

    def report(self, row_count: int) -> dict:
        """openapi.json ``ValidationReport``."""
        return {
            "row_count": row_count,
            "errors": [group.as_dict() for code, group in self.groups.items() if ISSUES[code].blocking],
            "notes": [group.as_dict() for code, group in self.groups.items() if not ISSUES[code].blocking],
        }
