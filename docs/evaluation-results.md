# Evaluation results files (`bmc-evaluation-results/1`)

A benchmark or evaluation harness run outside Broad Modelcard can hand its results to the Data Library as one JSON file. The file is checked like any upload and then **proposes** records: one study record for the benchmark run and one performance row per result. A maintainer (Performance metrics, *Import evaluation results*) or a custodian (a developer submission's part) ticks what to stage; the staged records go through check, review, preview, and publish like every update. **Nothing publishes on its own.** The rules are in `backend/CONTRACT.md` §32.2.

All data in Broad Modelcard is synthetic demonstration data. Benchmark names, makers, and addresses in examples are fictional. Never put patient-level or real patient data in a file: the format holds aggregate results per condition and group only.

An example that is valid on the demo store: [`evaluation-results-example.json`](evaluation-results-example.json).

## One file, one card

```json
{
  "format": "bmc-evaluation-results/1",
  "model_version": "MediCore-2.5",
  "use_case": "Clinician Facing CDSS",
  "configuration_id": "cfg-medicore-cdss-2025-03",
  "benchmark": { "name": "Harbourline Clinical Vignette Benchmark (fictional)", "version": "3.0", "description": "…", "url": "https://studies.example/…" },
  "run_date": "2026-10-18",
  "conducted_by": "independent",
  "setting": "mixed",
  "results": [
    { "icd11_code": "5A11", "measure": "Top-3 diagnostic accuracy", "value": 0.82, "ci_low": 0.76, "ci_high": 0.88, "cases": 160, "sites": 3 },
    { "icd11_code": "BA41", "measure": "Top-3 diagnostic accuracy", "value": 0.69, "cases": 44, "age": "Age 65+" }
  ]
}
```

| Field | Required | What it holds |
|---|---|---|
| `format` | yes | Exactly `bmc-evaluation-results/1`. |
| `model_version`, `use_case` | yes | The card: an AI system and its function as *AI systems & functions* lists them (a card only in a staged registry update is accepted with a note). |
| `configuration_id` | yes | The configuration the run evaluated (letters, digits, `.`, `_`, `-`; at most 64), e.g. the card's current one. |
| `benchmark.name` | yes | The benchmark's name, at most 120 characters. |
| `benchmark.version`, `.description`, `.url` | no | Version (≤ 40), a description of its cases (≤ 280), and a link (`https://` or `http://`). |
| `run_date` | yes | The day of the run, `YYYY-MM-DD`. |
| `conducted_by` | yes | `developer`, `independent`, or `hospital`: who ran it. |
| `setting` | no | Where the cases come from: `emergency_department`, `intensive_care`, `inpatient_ward`, `outpatient_clinic`, `primary_care` (or their names), or `mixed`. |
| `results` | yes | 1 to 5,000 results, below. |

Each result:

| Field | Required | What it holds |
|---|---|---|
| `icd11_code` | yes | An ICD-11 MMS code of a condition or a subcategory (`5A11`, `BA41.Z`). A subcategory is stored on its top-level condition. Chapters, blocks, and codes of other classifications are refused. |
| `measure` | yes | What `value` measures, e.g. `Top-3 diagnostic accuracy` (≤ 200). |
| `value` | yes | A share between 0 and 1 (`0.82`, not `82`). |
| `ci_low`, `ci_high` | no | The 95% interval, 0 to 1, with `ci_low ≤ value ≤ ci_high`. |
| `cases` | yes | The number of cases the value rests on (a whole number ≥ 1). |
| `sites` | no | The number of sites (a whole number ≥ 1). |
| `age`, `sex`, `ethnicity` | no | The group, as the atlas names it (`Age 65+`, `Sex Female`, `Ethnicity Asian`); left out means all patients. |

Fields the format does not list are refused, so a typo never drops a value silently. One result per condition and group: a subcategory counts for its condition.

## The check

Problems that block the file, each with a plain fix: a file that is not JSON, not one object, larger than 1 MB, or of another format; a missing or malformed field; a card the registry does not have; an unknown ICD-11 code; a value, bound, or count out of range; an interval in the wrong order; an unknown group; a repeated condition and group.

Notes that do not block:

- **The measure differs from the card's.** A result's `measure` is not the card's *Performance measure* (compared ignoring case and spacing). Check that the values can stand beside the card's figures.
- **Another configuration.** `configuration_id` is not the card's current configuration. The condition card will say which configuration its results were measured on.

## What it proposes

- **A study record** for the run: Study ID `EVAL-<benchmark and version>-<run date>` (the same run proposes the same ID, so importing it again updates that record), design *Benchmark*, who ran it, the setting, the most sites any result names, the sum of the cases, not peer reviewed, no reporting guideline, risk of bias *Unclear* until a reviewer judges it, the run date as its publication date, the benchmark's link, and the configuration evaluated.
- **One performance row per result**, as a merge of the card's rows: the value with its interval, the cases as samples, the sites, one study, validation type *Benchmark*, and the source *Evaluation run: <benchmark> <version>* with the study's ID and the run date. The stored row's intended-use fields and warnings stay as they were (a merge row replaces the whole row).

Stage the study first and publish it under *Studies*; then publish the rows under *Performance metrics*. Once both are live, the rows link the study: Study quality and Evaluated configuration on the condition card name it, and its *Unclear* risk of bias enters the evidence grade as for every linked study.
