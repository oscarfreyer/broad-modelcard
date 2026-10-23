# The seed

These JSON files are the official seed of Broad Modelcard: the data a fresh
clone imports into the backend store as **dataset version 1**. They are the
only source of that import.

**All of it is synthetic demonstration data.** It was generated for the
research prototype. It is not clinical evidence, it describes no real model,
and it contains no patient data. Never add real or patient data here.

## What is in it

| File | Holds |
|---|---|
| `atlas-base.json` | The ICD-11 atlas: 21 chapters, 225 blocks, 13,442 categories (13,688 concepts), the demographic axes, and the 90 lens combinations |
| `prevalence_by_code.json` | One commonness tier per ICD-11 code (`very_rare` … `very_common`): relative tiers, not prevalence rates |
| `model-registry.json` | 7 models and their 10 use-case variants, each naming its metrics files |
| `models/*.metrics.json` | Performance, evidence, and intended-use metrics per model and use case: 2,400 conditions × 90 lenses each (2,160,000 metric rows in all) |
| `models/*.multimorbidity.metrics.json` | Metrics for disease combinations, for 4 of the variants (152 combinations) |

The registry names its metrics files as `data/tables/models/<file>`, the path
the retired static app served them under. The importer and the validator
resolve that path against this directory by dropping `data/tables/`, so the
files stay byte for byte as they were.

The formats are checked by `backend/app/validation/legacy_tables.py` and the
importer, and described in `backend/CONTRACT.md`.

## How it becomes dataset version 1

From `backend/`, with the virtual environment set up (see the root `README.md`):

```bash
.venv/bin/python -m app.importers.legacy_json
```

The import checks every file against the data contract, then writes
`backend/data/broad_modelcard.sqlite` (about 155 MB, about 15 s). A failed
check leaves an existing store untouched. Running it again does nothing while
the seed is unchanged.

To check the seed without building a store, run `npm run validate-seed` from
the repository root. It runs the same checks as the import.

## Never edit it by hand

Data changes go through the Data Library (`/admin.html`): download a
spreadsheet, upload it, check it, review the changes, preview them on the
atlas, and publish. Each publish is a new dataset version in the store, and
any version can be restored. The seed stays as it is.

## Rebuilding the store from the seed

To throw away every published update and start again from version 1:

```bash
cd backend
.venv/bin/python -m app.importers.legacy_json --rebuild
```

`--rebuild` discards all published versions and staged uploads. Without it,
the import refuses to replace a store that has published updates.
