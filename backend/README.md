# Broad Modelcard backend

Python backend of Broad Modelcard. It owns the canonical
SQLite store, the import and validation of the seed, the derivations that turn
stored metric tuples into what the atlas shows (grades, statuses, rollups,
demographic fallback, multimorbidity), the read API that serves them, and
the update workflow (upload, check, review, publish, roll back).

All data is **synthetic demonstration data**. It is not clinical evidence.
Never import or upload real patient data.

It serves the catalogue, the atlas, the Data Library, and the live panel
(`npm run dev` starts it; see the root `README.md`). The API contract (v1.11)
is in [`openapi.json`](openapi.json) and
[`CONTRACT.md`](CONTRACT.md).

## Setup

Requires Python 3.14 (3.12 or later should work) and, for the parity tests, Node.js.

```bash
cd backend
python3.14 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
```

`requirements.txt` pins the runtime dependencies (pilot spec P2): FastAPI,
uvicorn, and pydantic for the API, python-multipart for uploads, and openpyxl
for XLSX files. `requirements-dev.txt` adds pytest and httpx. The store, import,
and derivations use only the standard library.

## Build the store

```bash
cd backend
.venv/bin/python -m app.importers.legacy_json
```

This reads the seed in [`seed/`](seed/README.md) (the atlas, prevalence
tiers, model registry, and every metrics and multimorbidity file the registry
names), validates it against the data contract, and writes
`backend/data/broad_modelcard.sqlite` (gitignored; `$BMC_DB` when that is set,
as for the server) as dataset version 1. On the
development Mac it takes about 15 s and produces a 155 MB file from 350 MB of
JSON. The registry names files as `data/tables/models/<file>`; they are read
from `seed/models/<file>`.

- Running it again is a no-op while the source files are unchanged.
- When a source file changes, the store is rebuilt.
- A failed import (any contract violation) leaves the existing store untouched.
- Once published versions exist, the import refuses to replace the store
  unless you pass `--rebuild`, which discards them. A rebuild also forgets
  staged uploads.
- A store built before Track A3 is migrated in place (it gains the `uploads`
  table, and since contract v1.5 the registry entry columns) the first time
  the API starts. The same holds for every later migration, up to 0006
  (contract v1.11, the intended-use statement column).
- The seed's rows without validation evidence are imported as they are; they
  read No data (contract v1.11). The upload check that rejects performance
  without evidence (`performance_without_evidence`) does not apply to the
  import.

Options: `--seed <dir>` (default `backend/seed`), `--db <file>` (default
`$BMC_DB` when it is set, else `backend/data/broad_modelcard.sqlite`),
`--rebuild`, `--check`, `--quiet`.

### Validate the seed

```bash
npm run validate-seed                                # from the repository root
.venv/bin/python -m app.importers.legacy_json --check   # the same, from backend/
```

`--check` runs every check of the import on the seed and writes the result
into a throwaway store, so validation and import cannot disagree; the real
store is not touched. It exits 1 with the first problem. The rules live in
`app/validation/legacy_tables.py` (files, atlas, registry, prevalence, payload
headers, and metric tuples) and in the importer (rows, condition ids, and
combinations), and are tested in `tests/test_import.py`:

- every file the registry names exists, and every `models/*.metrics.json`
  file is named by the registry;
- atlas: concepts with unique ids, levels 0–2, names, existing parents, no
  parent cycles, a chapter ancestor, and only known fields; top-level
  conditions that are unique concepts; combo definitions with all five keys;
  one context; age, sex, and ethnicity axes with their "All" values;
- registry: unique models with a display name, status, and use cases; unique
  use cases per model; defaults that exist; metrics paths under
  `data/tables/models/` ending in `.metrics.json`, without traversal;
- prevalence: a `dataset_id`; finite `min_score` < `max_score` when present; a
  matching `code_count` when present; non-empty codes; every value a
  commonness tier;
- metrics and multimorbidity: schema version 1, the registry's model and use
  case, the 13-field row format, combos on the atlas axes with a matching
  `combo_count`, rows only for top-level conditions, one row per combo, and
  every tuple field of the right type (grades A–F, `in_intended_use` 0/1);
  combinations of at least two different known conditions, each disease set
  once.

## Run the API

```bash
cd backend
.venv/bin/python -m app.serve            # http://127.0.0.1:8000/api/v1
.venv/bin/python -m app.serve --port 8001 --db path/to/store.sqlite
.venv/bin/python -m app.serve --db data/dashboard-demo.sqlite --uploads-dir data/dashboard-demo-uploads
```

`--uploads-dir` (or `BMC_UPLOADS_DIR`) sets the folder for upload files;
without it they go to `uploads/` next to the store. A second store next to
the live one, such as the demo store, must keep its uploads apart, because
the live store's `data/uploads/` holds the live store's staged files.

`python -m app.serve` is the only supported way to start the API. It listens
on **127.0.0.1 only** and has **no authentication** (pilot spec D11). There is
deliberately no host option, and startup logs a "LOCAL ONLY, NO
AUTHENTICATION" warning. Never expose the port to a network (no port
forwarding). Hosting needs authentication first.

- **Local-only guard** (`app/api/guard.py`, CONTRACT.md §16): even if the app
  were started some other way on every interface, it answers 403 `local_only`
  to any client whose address is not loopback, to a `Host` header that is not
  exactly `host[:port]` naming `localhost`, `127.0.0.1`, or `[::1]` (DNS
  rebinding), to an `Origin` that is not the request's own `scheme://Host`
  (another site, or another page on localhost such as `http://localhost:3000`),
  and to a non-GET request whose `Sec-Fetch-Site` is neither `same-origin` nor
  `none`. A web page open in the maintainer's browser therefore cannot read the
  helper settings, publish, roll back, or upload. The app's own pages pass:
  the Vite proxy keeps the browser's `Host`, so their `Origin` matches. Vite
  runs with `cors: false`, and the API sends no CORS headers. Requests without
  `Origin` (curl, scripts, tests) are checked by address and `Host` only.
- **Spreadsheet formulas** (`importers/spreadsheets.py` `escape_formula`,
  `publishing/files.py`): templates and checked copies write text that starts
  with `=`, `+`, `-`, `@`, a tab, or a carriage return (and is not a plain
  number) with a leading `'`, and XLSX text cells are string cells, so a
  spreadsheet program never runs uploaded text as a formula. Uploads drop the
  `'` again and note such values (`formula_like_text`).
- **XLSX decompression bombs** (`importers/spreadsheets.py`
  `xlsx_archive_problem`, used by uploads and by `assist/inputs.py`): before
  openpyxl opens a workbook, its zip directory is checked. Uploads may expand
  to 1,024 MB in all and 200 MB in any part other than a worksheet (openpyxl
  reads `xl/sharedStrings.xml` whole); study files to 100 MB; nothing may be
  compressed more than 100:1. Larger or denser files are refused unopened
  (`unreadable_file`, or 422 `assist_unsupported_input`).
- **Body limits** (`app/api/limits.py`, the table in `app/main.py`): uploads,
  records uploads, study files, narrow model cards, release bundles, `lookup`
  bodies (64 KB), and every other request body (1 MB) are refused with 413
  `upload_too_large` before they are read, by `Content-Length` or while a
  chunked body arrives.
- **Release bundles** are untrusted input: an import checks the manifest's
  shape, each table's columns against the store's, the checksums, and the
  atlas before it uses any name or id from the file, and a publish that the
  store's constraints refuse answers 409 `invalid_bundle` with nothing written.
- Interactive docs: <http://127.0.0.1:8000/api/v1/docs>. The generated schema
  is at `/api/v1/openapi.json`. The contract is `backend/openapi.json`, and the
  drift test keeps the two in line.
- If the store is missing, `app.serve` refuses to start and prints the import
  command. An app started otherwise answers 503 `store_unavailable`.

### Behavior

- **Operations:** `getMeta`, `listModels`, `getCatalogue`, `getAtlasOverview`,
  `getChapter`, `getMetricMap`, `getMetricSummary`, `getConceptMetrics`,
  `getMultimorbidityCandidates`, `getMultimorbidityCombination`,
  `searchConcepts`, `exportConcept`, `exportDataset`, and `lookup` (a POST),
  under `/api/v1`. The admin operations are described in
  [Update data](#update-data-admin-api).
- **Local populations** (contract v1.10, CONTRACT.md §21): every read that
  depends on prevalence (catalogue, atlas, metrics, multimorbidity, search,
  exports) takes `population=<id>`, and the lookup body
  `context.population_id`. The population's tiers replace the default ones for
  that request only, through the same formulas; the response names it
  (`population: {id, name}` and `X-Population`), and its ETag and caches are
  keyed by it. Without the parameter every answer is unchanged. `/meta`
  lists the populations (`populations`); an unknown id is 404
  `unknown_population`.
- **Versions:**
  - Every successful read carries `X-Dataset-Version` (the live version number,
    `1` after the import), a strong `ETag`, and `Cache-Control: no-cache`.
  - A matching `If-None-Match` returns 304.
  - `version=live` is the default.
  - `version=staged:<upload_id>` reads the live data with one valid staged
    upload swapped in, for that request only (see
    [Staged reads](#staged-reads)). Any other value returns 422
    `invalid_version`.
- **Errors:** errors are `application/problem+json` with a stable `code`.
  Parameter errors (422) are checked before lookups (404).

  | Status | Code | When |
  |---|---|---|
  | 404 | `unknown_model`, `unknown_use_case` | model or use case not in the registry |
  | 404 | `unknown_concept` | unknown concept, a `chapter_id` that is not a chapter, or an unknown id in `selected` |
  | 403 | `local_only` | a non-loopback client, a foreign or malformed `Host`, an `Origin` other than the request's own, or a cross-site write (`Sec-Fetch-Site`) |
  | 404 | `unknown_upload` | `version=staged:<id>` or an admin call names an unknown upload |
  | 409 | `upload_not_valid` | `version=staged:<id>` names an upload that is not `valid` |
  | 404 / 405 | `not_found` / `method_not_allowed` | no such route or method |
  | 422 | `invalid_lens` | `age`, `sex`, or `ethnicity` outside the axes |
  | 422 | `invalid_version` | `version` is not `live` or `staged:<id>` |
  | 422 | `invalid_scope`, `missing_chapter_id`, `invalid_view` | map, summary, and candidate parameters |
  | 422 | `invalid_selection` | more than 12 ids or an empty id in `selected`, or fewer than two distinct conditions for a combination |
  | 422 | `invalid_query`, `invalid_limit` | empty or whitespace-only `q`, `q` over 200 characters, `limit` outside 1–200 |
  | 422 | `invalid_parameter` | any other invalid or missing parameter |
  | 503 | `store_unavailable` | no store at the configured path |
  | 500 | `internal_error` | a bug; the detail is logged, not returned |

- **Catalogue** (`GET /api/v1/catalogue`, contract v1.6, CONTRACT.md §17): one
  tile per configuration (model × use case) in registry order, with the
  entry and configuration fields, the status distribution of every view at
  the all-population lens (the same counts as `/metrics/summary`), an overall
  distribution per chapter, the per-subchapter Overview status and safety
  mark of the tile snapshot (v1.11, `snapshot_blocks` once per body and two
  aligned arrays per tile), and `last_updated` (the
  newest published version that changed the configuration's metrics,
  multimorbidity, registry entry, safety incidents, or, since 2026-10-21,
  the study records its stored rows name: a studies publish or restore that
  adds, changes, or removes such a record moves it; prevalence, population,
  and effects publishes do not). One request serves the whole landing
  page; filters and sorts run in the browser.
- **Not appraised** (2026-10-21, CONTRACT.md §22): `/metrics/map` adds
  `appraisal` (`linked`, `includes_linked`, or null per row) and
  `/metrics/summary` adds `appraisal_counts` (`{graded, linked}`), both only
  when at least one row of the answer rests on a study record, so answers
  without one keep their exact bytes; grading is unchanged.
- **Audience reads** (contract v1.14, CONTRACT.md §30): `/metrics/summary`
  with `weights=prevalence` adds `weighted_distribution` (each status's share
  of the prevalence weight of the top-level conditions); `/versions` with
  `card=<model_version>|<use_case>` lists only the versions that changed that
  card (its newest is the tile's `last_updated`); `GET /incidents`
  (`listSafetyIncidents`) is the public read of the incident list. Reads
  without the new parameters keep their exact bytes.
- **Lookup** (`POST /api/v1/lookup`, contract v1.8, CONTRACT.md §19): the
  live interaction plugin's one request. A CDS Hooks–shaped JSON body names a
  card, 1 to 12 ICD-11 codes, and a coarse population (`age_group`, `sex`,
  `ethnicity`); the answer lists, per code, what `/metrics/concepts` serves
  for that condition at that lens (statuses, warnings, safeguards, incidents,
  provenance), the safety mark, the stored combination of the codes (or
  null), and relative `atlas.html?…` links. Unknown keys anywhere are a 422,
  so no free text or identifier can be sent; the body is never stored,
  cached, or logged (`Cache-Control: no-store`). Demonstration on synthetic
  data, not for clinical use.
- **Selections:** `selected` is comma-separated (`selected=5A11,GB61`). Chapters
  and blocks in it are ignored, as in the reference. Deeper categories count as
  their depth-1 anchor.
- **Exports:**
  - The concept export is JSON with a `Content-Disposition` attachment name.
    Its millisecond timestamp is part of the body, so its ETag changes from
    one export to the next.
  - The dataset export streams about 1.3 GB per model and use case. On the
    development Mac it takes about 21 s, and the first byte arrives in a few
    milliseconds.
  - It reads through its own connection, so other requests keep working. Server
    memory stays around 200 MB.
  - `metrics_by_key` is written lens by lens. JSON key order carries no meaning.

### Speed and caching

Measured warm on the full store by `tests/test_api_budgets.py`, as in-process
round trips. Every timed request uses parameters not requested before.

| Endpoint | p50 | p95 | Target p95 (pilot spec §8.1) |
|---|---|---|---|
| `/metrics/map` (atlas) | 32 ms | 36 ms | 120 ms |
| `/metrics/map` (chapter) | 6 ms | 13 ms | 120 ms |
| `/metrics/concepts/{id}` | 3 ms | 4 ms | 50 ms |
| `/search` | 2 ms | 3 ms | 100 ms |
| `/search/interpret` (demo store with synonyms, `tests/test_interpret.py`) | 1 ms | 2 ms | 150 ms |
| `/metrics/summary` | 14 ms | 26 ms | 150 ms |
| `/multimorbidity/candidates` (atlas) | 5 ms | 7 ms | 100 ms |
| `/multimorbidity/combination` | 0.4 ms | 0.6 ms | 100 ms |
| `/catalogue` (warm) | 0.6 ms | 0.8 ms | 150 ms |
| `/lookup`, 12 codes (warm; demo store) | 0.7 ms | 1.2 ms (max) | 50 ms, < 50 KB (12 KB) |

- **Local populations** (contract v1.10; demo store, Northbridge region,
  `tests/test_api_budgets.py::test_population_reads_within_budgets`, n = 30
  uncached each): `/metrics/map` (atlas) p50 35 ms, p95 43 ms with the
  population and 37 / 42 ms without; `/metrics/summary` 20 / 30 ms with and
  20 / 31 ms without; `/metrics/concepts/{id}` 3.7 / 4.5 ms with and
  3.6 / 4.3 ms without. The first population read of a version builds its
  atlas view (about 90 ms); the last few population views are kept. Sizes are
  the default ones (map 250 KB, overview 1.0 MB, catalogue 62 KB).
- **Repeats:** a repeated request is served from a response cache (about
  0.4 ms) of encoded bodies, keyed by dataset version and parameters. It is
  bounded at 256 entries and 128 MB.
- **Derived rows:** the services keep rows (and safety marks) for the 16 most
  recent lenses of the 4 most recent model and use-case pairs, more than the
  12 lenses one Across groups read visits (`LENS_CACHE_SIZE`); every cache is
  one `app/services/lru.py` `LruCache`. Evicting only costs a re-derivation;
  results never change. Another ontology's crosswalk anchors are built once
  per ontology, its projection once per version and population (MONDO about
  70 ms).
- **Catalogue:** built once per dataset version and kept on the version (the
  startup warm-up builds the live one), so the response cache evicting it
  costs only re-encoding. Tile distributions are also cached by the content
  they derive from (metrics set, prevalence set, configuration), so after a
  metrics publish only that configuration is derived again (about 20 ms) and
  after a registry publish none. A build from scratch takes about 180 ms on
  the seed (10 tiles, 42 KB) and 270 ms on the demo store (13 tiles, 61 KB);
  the first request of a process that skipped the warm-up, about 240 and
  330 ms.
- **Response sizes:** the largest non-export response is `/atlas/overview` at
  1.0 MB, against a 2 MB budget.
- **Concurrency:** the handlers run in uvicorn's thread pool and share one
  read-only connection. All service calls go through one lock, because the
  service caches are not thread-safe. Derivations take milliseconds, so this
  costs little for a single local user.

## Update data (admin API)

A maintainer updates one data set at a time: download a template, fill it in,
upload it, fix what the check reports, review the changes, preview them on the
atlas, and publish. Every publish is a new dataset version, and any version
can be restored. The Data Library (`frontend/admin.html`) drives these operations; all of them
live under `/api/v1/admin`. Uploads must contain **aggregate synthetic data
only. Never upload patient-level or real patient data.**

| Step | Operation | Notes |
|---|---|---|
| See the data sets | `GET /admin/datasets` (`listDatasets`) | version, last update, counts, staged uploads |
| Get a template | `GET /admin/templates/{kind}.{csv,xlsx}` (`downloadTemplate`) | `?filled=true` (plus `model_version`, `use_case` for metrics and multimorbidity) gives the live data to edit |
| Upload | `POST /admin/uploads` (`createUpload`, multipart) | `kind`, `file`, `model_version` and `use_case` for metrics and multimorbidity, `replace_staged`, `mode` (`replace` or `merge`) |
| Enter records | `POST /admin/uploads/records` (`createRecordsUpload`, JSON) | `{kind, model_version?, use_case?, records: [...]}`: a merge upload written as a template-form CSV (the one-record form, the helper) |
| Follow the check | `GET /admin/uploads/{id}` (`getUpload`) | `status` `checking` → `valid` or `invalid`, `progress` 0–1, `report` |
| See problems in the file | `GET /admin/uploads/{id}/annotated.{csv,xlsx}` | the file with problems marked |
| Review changes | `GET /admin/uploads/{id}/changes` (`getUploadChanges`) | rows, AI systems, functions, status shifts |
| Preview | any read with `version=staged:{id}` | sets the upload's `previewed` flag |
| Publish | `POST /admin/uploads/{id}/publish` (`publishUpload`) | body `{"previewed": true/false, "note": "…"}` (note optional, ≤ 500 characters) |
| Discard | `DELETE /admin/uploads/{id}` (`discardUpload`) | live data is never affected |
| History | `GET /admin/versions[?kind=]` (`listVersions`) | newest first, each with its change note |
| Roll back | `POST /admin/versions/{n}/rollback[?kind=\|every_kind=true]` (`rollbackVersion`) | publishes a new version equal to version *n* for that data set, or for every data set with `every_kind=true` (v1.11; 422 `invalid_rollback` with `kind`); optional body `{"note": "…"}`; 409 `rollback_no_change` when nothing would change (v1.11) |
| List incidents | `GET /admin/safety/incidents[?model=&use_case=]` (`listIncidents`) | every stored safety incident (open, mitigated, closed), newest first, with the codes' names and the chapter number for the edit form (v1.11); edit one with a merge upload of its record |

### Data sets and staging

- **Kinds:** `models` (the registry, titled "AI systems & functions"),
  `metrics` and `multimorbidity` (per card, the upload's *target*),
  `prevalence`, `safety` (the safety incidents, contract v1.7),
  `population` (local populations, contract v1.10: one per population id,
  the upload's target), `studies` (the study records, contract v1.13), and
  `effects` (the effects on outcomes, contract v1.13, CONTRACT.md §27).
- **A replace upload (the default) replaces the data set** (or the target's
  data). Rows missing from the file are removed; the change summary says how
  many.
- **A merge upload** (`mode=merge`, contract v1.7, for `metrics`,
  `prevalence`, `safety`, `studies`, and `effects`) changes only its rows: each row adds or replaces
  its record, a row with Action `Remove` deletes it, and everything else stays.
  Rows that add or replace metrics or prevalence need Source, Study, and Source
  date; a row from a study older than the stored row's is kept out (a note:
  the newer study stays). A merge is applied to the live set when it is
  checked; if a publish or rollback replaces that set meanwhile, the upload is
  checked again on the new one (CONTRACT.md §11.2).
- **One staged upload per data set** (per target for metrics and
  multimorbidity): a staged upload is `checking`, `invalid`, or `valid`. A new
  upload for the same data set returns 409 `staged_upload_exists` unless
  `replace_staged=true`, which marks the old one `superseded`.
- **Files:** uploads are kept in `data/uploads/<upload_id>/` next to the store
  (gitignored; `--uploads-dir` or `BMC_UPLOADS_DIR` chooses another folder)
  until they are discarded or superseded. A valid upload is also
  written into the store as a staged content set, which no version lists until
  it is published. A check left running when the server stops is restarted at
  the next start.
- **Limits:** CSV (`.csv`) or Excel workbooks (`.xlsx`) only, otherwise 415
  `unsupported_file_type` (an `.xls` must be saved as `.xlsx`). At most 128 MB,
  otherwise 413 `upload_too_large`, answered before the body is read when the
  request states its length.
- **New models:** a registry upload is invalid while one of its use cases has
  no performance metrics. Add a model in this order: stage the registry upload
  (it reports `use_case_without_metrics`), upload and publish the metrics for
  the new model and use case (allowed because the staged registry names them;
  a note says so), then the staged registry upload is checked again
  automatically and can be published.

### Templates

Every template has one header row and one record per row. Header matching
ignores case, spacing, and punctuation (`CI low` = `ci_low`). Columns marked
*info* are for reading only, may be deleted, and are ignored on upload; so is a
`Problems` column, so a fixed annotated file can be uploaded as it is.

- **CSV** files start with two `#` comment lines (the data set, the
  synthetic-data notice); lines starting with `#` before the header are
  skipped, as are blank rows. UTF-8 (with or without BOM) or Windows-1252;
  comma, semicolon, or tab as the delimiter; with a semicolon or tab, decimal
  commas are accepted (German spreadsheet settings).
- **XLSX** templates have an *Instructions* sheet (what the file holds, the
  steps, every column with its allowed values, the known warning codes, and
  the notice "Aggregate synthetic data only. Never upload patient-level or real
  patient data."), the *Data* sheet with a frozen header and dropdowns for
  allowed values (a warning, not a block, for other values), and a hidden
  *Lists* sheet that feeds the dropdowns. Uploads read the sheet named *Data*,
  otherwise the first sheet.
- **Filled templates** (`?filled=true`) hold the live data in this form,
  metrics and prevalence with every row's source; uploading one unchanged
  gives a valid upload with no changes (tested for the kinds in both formats
  on the full store). Since contract v1.11 a filled metrics or
  multimorbidity template of a seed card still holds the seed's rows with
  performance and no evidence, which an upload rejects
  (`performance_without_evidence`): change such a card with a merge upload of
  the rows you change, or add their evidence first.
- **Merge columns** (contract v1.7, optional, after the template's own columns
  in metrics and prevalence; safety has Action only): *Action* (`Remove`, or
  empty / `Add or replace`), *Source* (≤ 200 characters), *Study* (≤ 64), and
  *Source date* (`YYYY-MM-DD`). Rows without a source read as the upload
  (`Upload <file name>`); seed rows read "Seed (synthetic, version 1)".
- Readable values are accepted, and so are the codes: `Clinical study
  (multisite)` or `clinical_study_multisite`, `Partially in scope` or
  `partially_in_scope`, `Very rare` or `very_rare`, `Yes`/`No` or `1`/`0`.

**AI systems & functions** (`models`): one row per AI system × function (a card).

| Column | Required value | Allowed values |
|---|---|---|
| Model version | yes | identifier, e.g. `SynGPT-2.0`, repeated on every row of the model (≤ 64 characters) |
| Display name | yes | text; the same on every row of the model |
| Model name, Release | no | text; the same on every row of the model |
| Status | yes | `ACTIVE`, `EXPERIMENTAL` |
| Function | yes | e.g. `CDSS`; needs published performance metrics (the header `Use case` is accepted too) |
| Default function | no | `Yes` on at most one row per AI system (none: the first function; the header `Default use case` is accepted too) |
| Default model | no | `Yes` on the rows of at most one model (none: the first model) |
| Kind | no | `Model` or `Product` (empty: Model); the same on every row of the entry |
| AI type | no | `Large language model`, `Imaging model`, `Tabular risk model`, `Rule-based system`, `Hybrid`; the same on every row |
| Developer | no | text (≤ 200 characters; fictional names only); the same on every row |
| Release date | no | `YYYY-MM-DD`, e.g. `2026-03-01` (an XLSX date cell also works); the same on every row |
| Description | no | text (≤ 280 characters); the same on every row |
| Built on | no | products only: model versions of other *Model* entries in the file, separated by `;`; the same on every row |
| Function category | no | `Decision support`, `Documentation`, `Image analysis`, `Triage`, and since contract v1.14 `Patient communication`, `Administrative` (per row: one model and use case) |
| Declared intended purpose | no | text (≤ 500 characters), per row |
| Declared regulatory status | no | text (≤ 200 characters), per row; never "certified" or "approved" for demonstration data |
| Declared contact | no | text (≤ 200 characters), per row |
| Declared documentation URL | no | `https://…` or `http://…` (≤ 500 characters), per row |
| Intended use stated | no | `Yes` or `No`, per row (empty: Yes); contract v1.11 |
| Replaces | no | the model version of another AI system in the file that this one supersedes (not itself, no loop); the same on every row; contract v1.14 |
| Configuration ID | no | a label of letters, digits, `.`, `_`, `-` (≤ 64 characters), e.g. `cfg-2026-09`, per row |
| Configuration date | no | `YYYY-MM-DD`, per row |
| Prompt summary | no | text (≤ 500 characters), per row; a summary, never the full prompt |
| Prompt SHA-256 | no | 64 characters `0-9`, `a-f` (upper case is accepted and stored in lower case), per row |
| Retrieval | no | text (≤ 280 characters), per row |
| Tools | no | at most 10 names separated by `;`, each ≤ 60 characters, per row |
| Sampling temperature | no | a number from 0 to 2, per row |
| Sampling top-p | no | a number from 0 to 1, per row |
| Max output tokens | no | a whole number ≥ 1, per row |
| Fine-tuning | no | text (≤ 280 characters), per row |
| Performance measure, Reference standard | no | text (≤ 200 characters each), per row: what the card's figures measure, against what |
| Declared data use | no | text (≤ 500 characters), per row |
| Declared data location, Declared retention, Declared privacy contact | no | text (≤ 200 characters each), per row |

The columns from *Kind* on were added in contract v1.5 (CONTRACT.md §11.1).
They are optional: a file with only the first eight columns is valid and
leaves the new fields empty. *Kind* to *Built on* describe the AI system (the
entry) and must be equal on every row of that model version; an empty cell
counts as a different value (`inconsistent_value`), so fill them on every row
or on none. *Function category* and the declarations belong to one row. The
declarations are the developer's own statements; the atlas shows them as
"declared by the developer", never as verified. *Intended use stated*
(contract v1.11) is `No` for a card without an intended-use statement (a broad
language model): the API then serves no intended use for the card and scores
its rows without the intended-use term (CONTRACT.md §4.4). It is stored as 0
for No and NULL otherwise, so registry files without the column stay valid and
a filled template uploads unchanged.

The columns from *Replaces* on were added in contract v1.14 (CONTRACT.md §28,
migration `0011_registry_fields.sql`); files without them stay valid.
*Replaces* is an entry field (version lineage; `listModels` also derives
`replaced_by`); the configuration record (*Configuration ID* to
*Fine-tuning*), *Performance measure*, *Reference standard*, and the four
data-protection declarations belong to one row. They are the developer's
statements, served only when given (so a store without them reads as before),
and part of the configuration's registry signature: a new *Configuration ID*
moves the card's "Updated" (§17). None of them changes a grade.

The registry fields `effects` and `capabilities` (parameters of the retired
synthetic-data generators) are not in the template; existing models keep
theirs.

**Performance metrics** (`metrics`): one row per condition × demographic lens,
for the model and use case chosen at upload. A full file has 2,400 conditions ×
90 lenses = 216,000 rows.

| Column | Required value | Allowed values |
|---|---|---|
| ICD-11 code | yes | a top-level condition (depth 1), e.g. `5A11` |
| Condition | info | the preferred term |
| Age, Sex, Ethnicity | yes | the axis labels of `/meta`, e.g. `All ages`, `Age 65+`, `Sex Female`, `Ethnicity Asian` |
| Setting | no (v1.14) | `Any setting` (or empty, or `Clinical`), or a care setting: `Emergency department`, `Intensive care`, `Inpatient ward`, `Outpatient clinic`, `Primary care` (or its code, e.g. `emergency_department`) |
| Performance, CI low, CI high | no | numbers 0–1, CI low ≤ Performance ≤ CI high |
| Evidence grade | no | `A`–`F` (the source grade; the atlas derives its own, CONTRACT.md §4.2) |
| Samples, Sites, Studies, Peer-reviewed studies | no | whole numbers ≥ 0; peer-reviewed ≤ studies |
| Validation type | with Performance | the six validation types (empty: no evidence; then Performance must be empty, contract v1.11) |
| In intended use | with Intended-use level | `Yes`, `No` |
| Intended-use coverage | no | number 0–1 |
| Intended-use level | with In intended use | `In scope`, `Partially in scope`, `Out of scope` |
| Warnings | no | warning codes separated by `;` |

These are the 13 `row_format` fields, in order, after the key and lens columns.
Since contract v1.11, *In intended use* and *Intended-use level* may both be
empty (with *Intended-use coverage*): the row states no intended use, is never
out of scope, and scores without the intended-use term. It is stored with the
empty level `''` (CONTRACT.md §4.1). A row with *Performance* needs evidence:
a *Validation type* and no `no_validation_data` warning.
Every condition must have the same lenses (usually all 90; CONTRACT.md §7
covers files with fewer). Since contract v1.14 (CONTRACT.md §29) a row may name
a care setting in *Setting*: it is then a result measured in that setting only,
read when a reader chooses the setting, and never shown for Any setting. Give
such rows only where the evidence exists: the common-lens rule covers the
Any-setting rows only. A file without the column stores every row for Any
setting, as before. Local results take the same column.

**Multimorbidity** (`multimorbidity`): one row per condition set × lens, for
the model and use case chosen at upload. Columns: `Condition codes` (2 to 12
different top-level codes joined by `+`, e.g. `5A11 + BA00`; the set is
unordered for lookups, CONTRACT.md §8), `Combination label` (optional, the same
on every row of the set), `Conditions` (info), `Age`, `Sex`, `Ethnicity`, then
the 13 metric columns as above. The current data has only the all-population
lens.

**Prevalence** (`prevalence`): one row per ICD-11 code. Columns: `ICD-11 code`
(any level-2 code, subcategories included), `Condition` (info), `Commonness`
(`Very rare`, `Rare`, `Uncommon`, `Common`, `Very common`), then the merge
columns. In a replace upload, codes missing from the file lose their tier; a
replace upload that would remove more than half of the live tiers is the error
`prevalence_incomplete` ("This file lists only N of M codes. To add a local
population, use Local populations; to change some codes, use Add or change
rows."). A merge upload changes only the codes it lists.

**Local populations** (`population`, contract v1.10, CONTRACT.md §21): the
prevalence template, for one local population (a region or a service). Give
`population_id` (1 to 40 lower-case letters, digits, or `-`, e.g.
`northbridge-region`) and `population_name` (the name every view shows, at most
80 characters; needed for a new population) when you upload. List only the
codes whose local tier you know: every other condition keeps the default tier.
An upload replaces that population's whole list (no merge, no Remove rows).
A filled template with `population_id` gives the population's rows back;
without it, the default tiers to start from. **Aggregate data only:** a
column that looks patient-level (Patient ID, Name, Date of birth, Address,
Visits per patient, …) or a code on more than one row is the error
`patient_level_data`; such a file is deleted as soon as its check ends, its
report keeps no cell of it, and no annotated copy is offered (409
`upload_not_staged`). To remove a population, use
`POST /admin/populations/{id}/remove` (`removePopulation`, optional
`{"note": "…"}`): it publishes a version without it; a rollback of kind
`population` brings it back.

**Safety incidents** (`safety`, contract v1.7, CONTRACT.md §18): one row per
incident. Safety incidents never change grades.

| Column | Required value | Allowed values |
|---|---|---|
| Incident ID | yes | letters, digits, `.`, `_`, `-` (≤ 64), e.g. `SI-2026-014` |
| Model version, Function | yes | a card of the live registry (or of a staged registry upload) |
| ICD-11 codes | yes | level-2 codes separated by `;` (a subcategory counts for its top-level condition), or one chapter as `chapter 06` |
| Age, Sex, Ethnicity | no | the axis labels; empty: `All …` |
| Incident type | yes | `Harmful or incorrect recommendation`, `Fabricated content`, `Subgroup bias`, `Performance drift`, `Developer notice or recall`, `Other` |
| Harm | yes | `Occurred`, `Possible`, `None` |
| Status | yes | `Open`, `Mitigated`, `Closed` |
| Source type | yes | `Study`, `Incident report`, `Developer notice` |
| Source reference | yes | text (≤ 200 characters) |
| Study ID | for a study | text (≤ 64 characters) |
| Reported date | yes | `YYYY-MM-DD` |
| Updated date | no | `YYYY-MM-DD`, not before Reported date |
| Summary | yes | synthetic text (≤ 280 characters), no patient details |
| Action | no | `Remove` in a merge upload |

Severity is derived: **Serious** = open with harm occurred or possible, or an
open developer notice or recall; **Caution** = any other open incident, or a
mitigated one; closed incidents are listed but not marked. An incident applies
to a lens when each of its values is `All …` or equals the requested one (or
the request is `All …`). In a merge, an incident's updated (else reported)
date plays the role of the source date.

**Studies** (`studies`, contract v1.13, CONTRACT.md §22): one row per study.
A metrics row links to a study when its Study column holds the Study ID
exactly; a linked row's evidence signal gains +0.05 when the reporting
guideline was followed and loses 0.10 (high) or 0.04 (some concerns, unclear)
for its risk of bias. Unlinked rows are graded as before.

| Column | Required value | Allowed values |
|---|---|---|
| Study ID | yes | letters, digits, `.`, `_`, `-` (≤ 64), e.g. `NBR-2026-01` |
| Title | yes | text (≤ 200 characters) |
| Design | yes | `Vignette`, `Simulation`, `Benchmark`, `Retrospective`, `Prospective`, `Real-world deployment`, `Randomized trial` |
| Setting | yes | text (≤ 280), e.g. "Emergency department, tertiary hospital" |
| Sites, Patients | yes | whole numbers (sites ≥ 1); aggregate counts only |
| Peer reviewed | yes | `Yes`, `No` |
| Conducted by | yes | `Developer`, `Independent`, `Hospital` |
| Reporting guideline | yes | `None`, `TRIPOD+AI`, `STARD-AI`, `CONSORT-AI`, `DECIDE-AI`, `Other` |
| Guideline followed | unless the guideline is None | `Yes`, `Partly`, `No`; empty when the guideline is None |
| Risk of bias | yes | `Low`, `Some concerns`, `High`, `Unclear` |
| Risk-of-bias notes | no | text (≤ 500), e.g. per PROBAST+AI domain |
| Population | yes | text (≤ 280) |
| Evaluation conditions | yes | text (≤ 500): reference standard, period, data source |
| Model version evaluated | no | an AI system of the registry |
| Publication date | yes | `YYYY-MM-DD` |
| Source URL | no | `https://` or `http://` |
| Scope, Local population | no | `Public` (default) or `Hospital` with the local population's id (v1.13, §26) |
| Applicability concerns | no | `Low`, `High`, `Unclear` (v1.14) |
| Applicability notes | no | text (≤ 500) (v1.14) |
| Appraisal tool | no | `PROBAST+AI`, `APPRAISE-AI`, `QUADAS-AI`, `Other` (v1.14) |
| Appraisal score | no | a number from 0 to 100; needs an Appraisal tool (v1.14) |
| Setting category | no | `Emergency department`, `Intensive care`, `Inpatient ward`, `Outpatient clinic`, `Primary care`, `Mixed` (v1.14) |
| Configuration evaluated | no | letters, digits, `.`, `_`, `-` (≤ 64), e.g. `cfg-2026-03`; not checked against the registry (v1.14) |
| Action | no | `Remove` in a merge upload |

A metrics upload whose Study names no study record stays valid; its check
adds the note `unknown_study` once per such Study value. The v1.14 columns
(applicability, appraisal tool and score, setting category, configuration
evaluated) are shown in Study quality and never change a grade; files without
them stay valid.

**Effects on outcomes** (`effects`, contract v1.13, CONTRACT.md §27;
`docs/intervention-effects.md`): one row per effect of using an AI system on an
outcome, from a study that compared care with and without it. Effects are
never graded: the condition card shows them beside the results.

| Column | Required value | Allowed values |
|---|---|---|
| Effect ID | yes | letters, digits, `.`, `_`, `-` (≤ 64), e.g. `EFF-2026-01` |
| Study ID | yes | a Study ID of the live Studies whose design is `Randomized trial`, `Prospective`, or `Real-world deployment` |
| Model version, Function | yes | a card of the registry (or of a staged registry upload: a note) |
| ICD-11 codes | yes | codes separated by `;` (a subcategory counts for its top-level condition), or one chapter as `chapter 11` |
| Outcome | yes | text (≤ 200) |
| Outcome type | yes | `Benefit`, `Harm`, `Process` |
| Population, Comparator | yes | text (≤ 280 each) |
| Effect measure | yes | `Risk ratio`, `Odds ratio`, `Hazard ratio`, `Risk difference`, `Mean difference`, `Standardized mean difference` |
| Estimate, CI low, CI high | yes | numbers; CI low ≤ Estimate ≤ CI high; ratios above 0 |
| Unit | no | text (≤ 40), e.g. `minutes` |
| Direction of benefit | yes | `Higher is better`, `Lower is better` |
| Follow-up | no | text (≤ 120) |
| Appraisal tool | yes | `RoB 2` for a randomized trial, `ROBINS-I` otherwise |
| Risk-of-bias judgement | yes | `Low`, `Some concerns`, `High`, `Critical` (ROBINS-I only), `Unclear` |
| Notes | no | text (≤ 500) |
| Action | no | `Remove` in a merge upload |

Publish the study under Studies first. A staged effects upload is checked
again after a registry or studies publish or rollback.

**Records upload** (`createRecordsUpload`): the same columns as JSON, one
object per row keyed by column key (`incident_id`) or header (`Incident ID`),
for `metrics` (with `model_version` and `use_case`), `prevalence`, `safety`,
`studies`, or `effects`; always a merge, 1 to 5,000 records. The backend writes them as
`<kind>-records.csv` (header in row 1, record *i* in row *i* + 2) and checks
that file; each report example also names its `record` index.

### Validation rules

A check reads every row and reports problems grouped by code, each with a
count, at most 20 examples (row, column, value, problem), and a plain-language
fix. Row numbers are the spreadsheet's (the first line of the file is 1); row
0 means the whole file. Errors make the upload `invalid`; notes do not block.

| Code | Kind | When |
|---|---|---|
| `unreadable_file` | error | the file cannot be read as CSV or XLSX |
| `empty_file` | error | no data rows (or no header) |
| `wrong_template` | error | the header is another data set's template (only this error is reported) |
| `missing_column`, `extra_column`, `duplicate_column` | error | the header differs from the template (rows are not checked while a column is missing) |
| `too_many_rows` | error | more rows than the data set can hold; checking stops |
| `unknown_target` | error | the chosen AI system or function is in neither the registry nor a staged registry upload |
| `missing_value` | error | a required cell is empty, or only one of In intended use and Intended-use level is filled (or coverage without both) |
| `performance_without_evidence` | error | a metrics or multimorbidity row has Performance but no evidence: Validation type empty, or the warning `no_validation_data` (contract v1.11; the seed import is exempt) |
| `invalid_value` | error | text over 64 characters (200 for names, labels, developers, statuses, contacts, sources, and source references; 280 for descriptions and incident summaries; 500 for intended purposes, links, and *Built on*) or with a line break; an incident ID with other characters; more than 50 codes on one incident |
| `unknown_icd_code` | error | not in the atlas, a chapter or block, a subcategory where a top-level condition is needed, or a code a spreadsheet program turned into a number (1E30) |
| `unknown_lens_value` | error | an age, sex, or ethnicity label not on the axes |
| `unknown_setting` | error | a Setting that is not Any setting or one of the five care settings (v1.14) |
| `not_a_number`, `not_a_whole_number` | error | text in a number column, or a fractional count |
| `out_of_range` | error | performance, CI bounds, or coverage outside 0–1; a negative count; peer-reviewed studies above studies |
| `ci_low_above_ci_high` | error | CI low > CI high |
| `perf_outside_ci` | error | performance outside its own interval |
| `unknown_evidence_grade` | error | not `A`–`F` |
| `unknown_validation_type` | error | not one of the six validation types (or their contract aliases) |
| `unknown_intended_use_level` | error | not in scope, partially in scope, or out of scope |
| `invalid_yes_no` | error | not Yes or No |
| `invalid_warning_code` | error | a warning that is not a `lower_snake_case` code |
| `unknown_tier` | error | not one of the five commonness tiers |
| `unknown_status` | error | a model status other than `ACTIVE` or `EXPERIMENTAL` |
| `duplicate_key` | error | the same condition × lens, condition set × lens, code, or model × use case twice |
| `incomplete_lens_coverage` | error | a condition (or set) lacks lenses other records have |
| `invalid_condition_set` | error | fewer than 2 or more than 12 conditions, or one condition twice |
| `inconsistent_value` | error | rows of one model disagree on a model column (display name, model name, release, status, an entry field from *Kind* to *Built on*, or *Replaces*), or rows of one combination on its label |
| `invalid_default` | error | two default use cases for a model, or two default models |
| `use_case_without_metrics` | error | a registry use case has no published performance metrics |
| `unknown_kind` | error | a kind other than Model or Product |
| `unknown_ai_type` | error | an AI type outside the five types |
| `unknown_function_category` | error | a function category outside the six categories |
| `invalid_date` | error | a release, source, reported, or updated date that is not a calendar date `YYYY-MM-DD`, or an updated date before the reported date |
| `invalid_url` | error | a documentation link that does not start with `https://` or `http://` |
| `built_on_for_model` | error | an entry that is not a product lists *Built on* |
| `unknown_built_on` | error | *Built on* names the product itself, a version not in the file, or another product |
| `separator_in_name` | error | a *Model version* or *Function* contains `\|` or `,` (card ids join the two with `\|`, and comparisons list cards with `,`); fix: "Use a name without \| or ," (2026-10-21) |
| `invalid_configuration_id` | error | a *Configuration ID* that is not 1–64 letters, digits, `.`, `_`, `-` (v1.14) |
| `invalid_sha256` | error | a *Prompt SHA-256* that is not 64 hex characters (v1.14) |
| `too_many_tools` | error | more than 10 *Tools* (v1.14) |
| `replaces_self` | error | *Replaces* names the AI system itself (v1.14) |
| `unknown_replaces` | error | *Replaces* names no other AI system of the file (a submission's registry part: of the file or the published registry) (v1.14) |
| `replaces_cycle` | error | following *Replaces* comes back to the AI system: every entry of the loop is named, with the loop written out (v1.14) |
| `unknown_action` | error | an Action other than Remove or Add or replace (v1.7) |
| `remove_in_replace` | error | a Remove row in a replace upload (v1.7) |
| `missing_provenance` | error | a merge row that adds or replaces a record without Source, Study, and Source date, or a Study or Source date without a Source (v1.7) |
| `unknown_configuration` | error | an incident's card is in neither the registry nor a staged registry upload (v1.7) |
| `unknown_incident_type`, `unknown_harm`, `unknown_incident_status`, `unknown_source_type` | error | a value outside the safety lists (v1.7) |
| `missing_study_id` | error | an incident from a study without a Study ID (v1.7) |
| `unknown_applicability`, `unknown_quality_tool`, `unknown_setting_category` | error | a study value outside the applicability, appraisal tool, or setting category lists (v1.14) |
| `quality_score_without_tool` | error | an Appraisal score without an Appraisal tool (v1.14) |
| `invalid_study_configuration` | error | a Configuration evaluated with other characters than letters, digits, `.`, `_`, `-`, or longer than 64 (v1.14) |
| `unknown_effect_study`, `effect_study_design` | error | an effect's Study ID is not in Studies, or names a vignette, simulation, benchmark, or retrospective study (v1.13) |
| `appraisal_tool_mismatch`, `judgement_not_in_tool` | error | RoB 2 for a non-randomized study or ROBINS-I for a trial; Critical with RoB 2 (v1.13) |
| `effect_ci_order`, `effect_ratio_not_positive` | error | the estimate outside its interval; a ratio value of 0 or below (v1.13) |
| `unknown_outcome_type`, `unknown_effect_measure`, `unknown_effect_direction`, `unknown_appraisal_tool`, `unknown_effect_judgement` | error | a value outside the effects lists (v1.13) |
| `very_wide_confidence_interval` | note | CI high − CI low > 0.25 |
| `unfamiliar_warning_code` | note | a warning code the atlas has not seen |
| `grade_without_validation_type` | note | an evidence grade without a validation type (the atlas ignores it) |
| `scope_mismatch` | note | In intended use is No but the level is not out of scope (the atlas treats it as out of scope) |
| `formula_like_text` | note | a text value starts with `=`, `+`, `-`, or `@` (not a plain number); templates and checked copies write it with a leading `'`, and uploads drop that `'` again |
| `target_not_published` | note | the target exists only in a staged registry upload |
| `configuration_not_published` | note | an incident's card exists only in a staged registry upload (v1.7) |
| `configuration_not_in_registry` | note | a study names its AI system and a Configuration evaluated that none of that system's cards lists, live or staged; often an earlier configuration, which the condition card then names (v1.14, CONTRACT.md §28.5) |
| `newer_study_kept` | note | a merge row is older than the stored row; the stored row stays (v1.7) |
| `nothing_to_remove` | note | a Remove row names a record that is not stored (v1.7) |
| `new_lens_group` | note | a metrics merge adds a demographic group the stored data does not define (v1.7) |

**Annotated files** (`annotated.csv` or `annotated.xlsx`, either for either
upload format) copy the uploaded rows with a first `Problems` column ("Row 12:
Performance: …"). The XLSX also highlights each cell with a problem (red for
errors, yellow for notes) with a comment, and adds a *Summary* sheet; the CSV
lists whole-file and header problems in `#` lines. At most 50,000 problems are
marked.

### Change summary

`getUploadChanges` compares a valid upload with the live data of the same data
set (CONTRACT.md §11):

- **Rows** are matched by key (condition × lens, condition set × lens, code,
  AI system × function, or incident id) and counted as added, changed (any
  field differs, including a metrics or prevalence row's source), removed, or
  unchanged. A merge counts only the rows it touched. Up to 50 rows of each
  kind are named (condition and lens, code, combination and lens, card, or
  incident); the counts stay exact.
- **Models and use cases** added, changed, or removed (registry uploads; use
  cases are written `model / use case`). A registry row (configuration)
  counts as changed when any field of its model or of the row changes,
  including the v1.5 entry and configuration fields.
- **Status shifts** of the 2,400 top-level conditions at the all-population
  lens, per view (overall, performance, evidence statuses, and intended-use
  level), with counts and up to 50 sample ids. Metrics compare the target's
  rows; multimorbidity the Multimorbidity atlas colors before a first click;
  prevalence every model and use case (a tier changes the evidence grade);
  a local population every model and use case, comparing the default answers
  with the answers for the population (what a reader sees when switching).
  Each shift also lists its models and use cases (`targets`), so a preview
  link can open the model where the condition actually shifted. Safety
  uploads have no status shifts (safety never changes grades). A studies
  upload (contract v1.13) compares every card whose rows link a study before
  or after it, like prevalence; its rows are matched by study id. An effects
  upload (contract v1.13) has no status shifts (effects never change grades);
  its rows are matched by effect id.

### Publish, history, and rollback

- **Publish** adds a version in one transaction: the live version's content
  sets with the upload's set swapped in. A failure part-way leaves live data as
  it was (tested by injecting one). Publishes and rollbacks are serialized: a
  second one while one runs gets 409 `publish_in_progress`. Only a `valid`
  upload can be published (409 `upload_not_valid`), and one that no longer
  fits the live data gets 409 `upload_outdated`. The version's `previewed` is
  true when the request says so or a staged read previewed the upload. The
  optional change note (≤ 500 characters, whitespace collapsed) is stored on
  the version; the summary describes the change.
- **History** (`listVersions`) is newest first; with `kind`, it lists that data
  set's versions plus the initial import. Versions are never deleted.
- **Rollback** of version *n* publishes a new version whose sets for that data
  set equal version *n*'s: the registry, prevalence, or safety set, or the
  metrics (or multimorbidity) sets of every model and use case. It takes an
  optional change note. `kind` chooses the data
  set; without it, the one version *n* changed, or every data set for the
  initial import. `every_kind=true` (contract v1.11) restores every data set
  in one new version (its `kind` is null); the Data Library's Restore uses it
  for "Everything", its default. To undo the latest publish of a data set, roll back to the
  version before it in that data set's history. A rollback that would leave a
  registry use case without metrics returns 409 `rollback_conflict`. A
  rollback that would change nothing (the chosen data sets already equal
  version *n*'s) returns 409 `rollback_no_change` and adds no version
  (contract v1.11).
- After a publish or rollback, the next read uses the new version; response
  caches are keyed by version, so nothing stale is served.

### Staged reads

`version=staged:<upload_id>` works on every read endpoint. It serves the live
version with the valid upload's content set swapped in, for that request only,
and never changes live data. Responses carry `X-Dataset-Version:
staged:<upload_id>`; ETags and caches are keyed by the upload, its staged
content set (a check run again writes a new one), and the live version. The first staged read sets the upload's `previewed` flag. An unknown
upload is 404 `unknown_upload`; one that is not `valid` (checking, invalid,
published, discarded, superseded) is 409 `upload_not_valid`. A staged
population upload is previewed with `version=staged:<upload_id>&population=<its
id>`; `population` combines with any staged read (contract v1.10).

### Speed

Measured on the development Mac by `tests/test_admin_gate.py`, on the full
store, for a full metrics file (216,000 rows), in a fresh process:

| File | Size | Check (incl. writing the staged set) | Peak memory (RSS) | Target |
|---|---|---|---|---|
| CSV | 43.6 MB | 2.8 s | 322 MB | < 30 s with progress |
| XLSX | 15.8 MB | 14.8 s | 308 MB | < 30 s with progress |

Progress comes from the file position (CSV, workbooks that record their size)
or from the row count (workbooks written by openpyxl). A filled metrics XLSX
template takes about 13 s to generate; the CSV about 1 s. A change summary
takes about 0.3 s for a full metrics upload and 0.4 s for prevalence (which
compares every model and use case); a publish takes a few milliseconds.

Contract v1.7, on the demo store (`tests/measure_merge.py`): one safety
incident as a records upload is checked in under 0.1 s and published in a few
milliseconds (the change summary is cached from the review); a one-study
metrics merge (5 rows of a 216,000-row set) is checked in about 0.4 s (the
copy of the live set runs in SQL) and summarised in about 0.5 s.

## Dashboard demo store

`npm run demo:build` (from the repository root) builds a separate store,
`data/dashboard-demo.sqlite` (gitignored): the seed import, then every file of
the demo pack in [`demo/`](demo/README.md) published through the update
workflow above, each publish with a change note naming its pack file. Pack v1
adds the registry fields of contract v1.5 to the 7 seed models and 3 fictional
products with their metrics; pack v2 adds 16 fictional safety incidents and a
one-study metrics merge; pack v3 adds the fictional local population
Northbridge region (`northbridge-region`, 310 codes); pack v4, the demo
revision of contract v1.11, marks the three broad language models as having no
intended-use statement and gives every row with performance and no evidence
synthetic evidence, generated at build time (one merge upload per card); pack
v5 (contract v1.13) adds seven fictional study records and three metrics
merges that link rows of ICU_GPT-1.0, radAIology-1, and SkinAI-1.0 to them;
pack v8 (contract v1.14) adds configuration records, performance measures,
data-protection declarations, and lineage (with the fictional earlier release
Vantrel Triage 2.0); pack v12 imports one evaluation results file (a fictional
independent benchmark of MediCore-2.5 decision support) and publishes its
proposed benchmark study and metrics merge. `npm run demo` starts the app on that store (API
on 127.0.0.1:8010, uploads in `data/dashboard-demo-uploads/`). The builder is
`python -m app.demo build` (about 50 s: 15–20 s seed import, 30 s pack; a
fresh build ends at dataset version 38 with two submissions waiting); it never
touches the live store or its uploads folder, and it refuses a store that a
running backend has open (stop `npm run demo` first). Its last step imports
ICD-10-CM and MONDO (next section) when their releases are downloaded, and
otherwise says the demo serves ICD-11 only.

## Other classifications (ICD-10-CM, MONDO)

Contract v1.13 (CONTRACT.md §23): the atlas can be read in ICD-10-CM or MONDO,
projected over ICD-11, which stays the storage key of every result.

```bash
npm run ontologies:fetch                          # download the pinned releases (scripts/ontologies/sources.json) into data/ontology-sources/
npm run ontologies:fetch -- --check               # verify what is there, download nothing
BMC_DB=data/x.sqlite npm run ontologies:import    # write them into a store (default: the live store)
```

The importer (`app.ontologies.importer`, run with `python -I`) checks every
file's size and SHA-256 against the manifest first, parses the files with the
standard library only, and replaces each ontology's rows in one transaction
(idempotent). A store without them lists ICD-11 alone in `/meta.ontologies`. A
backend loads the ontologies once, at its start, so **restart a backend that
is already running on the store** (`npm run dev`, `npm run demo`, `npm run
api`) to read the imported classifications; the command ends with that line.
`npm run demo:build` needs no restart notice: it refuses to build a store that
a running backend has open. No source
file and nothing derived from the WHO mapping tables (CC BY-ND 3.0 IGO) is
committed; see `THIRD_PARTY_NOTICES.md`. Pinned releases: ICD-10-CM 18
chapters, 233 blocks, 1,467 conditions (984 exact, 9 stem, 155 block, 319 no
mapping); MONDO 27 chapters, 285 blocks, 3,039 conditions (407 exact, 5 stem,
20 block, 1,311 through a parent, 1,296 no mapping).

### Synonyms and plain-language search

Contract v1.14 (CONTRACT.md §31). The same import writes **synonyms of ICD-11
concepts** (`concept_synonyms`, migration `0014`) from the files it already
reads: MONDO labels and EXACT synonyms of terms mapped directly (exact or
stem), and the ICD-10-CM index's main terms (`icd10cm-index-<year>.xml` in the
pinned archive) whose code maps the same way. No new download. Pinned
releases: 11,174 from MONDO and 3,231 from the index, 14,405 over 2,976 ICD-11
concepts; the import takes about 0.6 s longer. Each ontology's report line
names its count.

- `GET /api/v1/search` (ICD-11) lists concepts found by a synonym only after
  every other match, with `match: "synonym"` and `matched_term`; a store
  without synonyms answers exactly as before.
- `GET /api/v1/search/interpret?q=…` reads a query as chips (AI system,
  function, up to three conditions, age, sex, ethnicity, care setting) with
  deterministic rules (`app/services/interpret.py`); nothing is applied.
- `POST /api/v1/assist/interpret` asks the configured helper (below) for the
  same chips, sending only the query and the vocabularies, and checks each
  chip. Off while the helper is off (409).

The rules are tested with shared cases that the static port runs too
(`tests/fixtures/interpret_rule_cases.json`) and a fixed set of 30 synthetic
queries on the demo store with the pinned files (`tests/fixtures/interpret_queries.json`,
at least 27 exactly right; 30 measured).

## Interoperability: card record, evaluation results, CDS Hooks

Contract v1.14 (CONTRACT.md §32, §33). All local, all synthetic; nothing is sent to another service.

- **Card record.** `GET /api/v1/cards/record?model=&use_case=` returns one card as a compact JSON for operational systems (`bmc-card-record/1`: the AI system, the card, its linked public studies, effects, public incidents, per-chapter statuses at all patients, the Overview counts, links), under 300 KB, with ETag and `X-Dataset-Version`. `&format=jsonld` serves the same content as JSON-LD with Model Card Report Ontology terms (`app/services/card_record.py`, written by hand). The atlas's Summary offers it as *Card record (JSON)*.
- **Evaluation results.** `POST /api/v1/admin/uploads/evaluation-results` takes the JSON of a benchmark or harness run (`docs/evaluation-results.md`, `bmc-evaluation-results/1`, at most 1 MB) as an upload of kind `evaluation_results`, checked in the background (`app/publishing/evaluations.py`). It never publishes: `GET /api/v1/admin/uploads/{upload_id}/evaluation-proposals` proposes a benchmark study and one metrics merge record per result, which the Data Library stages with the records upload. Store migration `0015` adds the upload kind.
- **CDS Hooks.** `GET /api/v1/cds-services` (discovery) and `POST /api/v1/cds-services/bmc-condition-status` take a CDS Hooks 2.0 `patient-view` request with a FHIR Patient and a Bundle of Conditions in ICD-11 or ICD-10-CM (mapped through the imported crosswalk), parsed by hand, and answer one CDS card per condition (`app/api/routes/cds_hooks.py`). Behind the local-only guard, with no CORS: a host application must run on this machine. The live interaction page has a *CDS Hooks request* mode.

## Assisted data entry (LLM helper)

Contract v1.9, CONTRACT.md §20. An optional helper reads one study (a PDF, a
text, or a CSV/XLSX table) and **proposes** records for the performance
metrics or the safety incidents, each value with the quote and location it
comes from and a flag when the mapping is uncertain. It never publishes and
never stages anything by itself: the maintainer sends the records they keep
to `createRecordsUpload`, which stages a merge upload, and the normal check →
change summary → preview → publish flow follows. Codes and cards come from
the store; a code the atlas does not have is dropped and listed, never
guessed. With the helper off, everything else works as before.

**Turn it on** (the Data Library does this; or with the API):

- *Hosted model, your own API key* (Anthropic Messages API; PDFs supported):

  ```bash
  curl -X PUT http://127.0.0.1:8000/api/v1/admin/assist \
    -H 'Content-Type: application/json' \
    -d '{"provider": "hosted", "api_key": "<your key>"}'
  ```

  The default model is `claude-sonnet-5-5`; pass `"model"` for another one.
  `"base_url"` points at a gateway (https, or http on this machine).
- *Local model* on this computer with an OpenAI-compatible API (text and
  tables only; paste the text of a PDF). Its base URL must name `127.0.0.1`,
  `::1`, or `localhost`; any other host is refused (422), so studies and keys
  stay on this machine unless you choose the hosted provider:

  ```bash
  curl -X PUT http://127.0.0.1:8000/api/v1/admin/assist \
    -H 'Content-Type: application/json' \
    -d '{"provider": "local", "model": "llama3.1:8b", "base_url": "http://127.0.0.1:11434/v1"}'
  ```

- A request without `"api_key"` keeps the stored key only for the same
  provider at the same address (scheme, host, and port of `base_url`). A
  stored key is never sent to another address: change the host, port, or
  scheme and a hosted model needs `"api_key"` again (422), while a local
  model is saved without one.
- `GET /api/v1/admin/assist` shows the status (never the key);
  `DELETE /api/v1/admin/assist` turns it off and deletes the configuration.

**Where the key lives.** In one JSON file on this machine, mode 600, ignored
by git: `data/assist.json` for the live store, `<store name>.assist.json`
next to any other store (the demo store uses `data/dashboard-demo.assist.json`),
or the path in `BMC_ASSIST_CONFIG`. The API never returns it, the logs never
contain it, and it never enters the store, uploads, templates, or exports.

**What is sent, and when.** Only when you ask for a proposal, and only to the
provider you configured: the study you submit, the helper's instructions, the
list of cards (model version, function, display name), the lens values, and
for a hosted model the results of its condition searches (atlas codes and
names). Nothing else leaves the machine. Submit synthetic or published study
text only, never patient data.

**Propose** (multipart): `POST /api/v1/admin/assist/proposals` with `kind`
(`metrics` or `safety`), `file` or `text`, and optionally a card
(`model_version`, `use_case`). The answer lists `batches` (per card for
metrics), each record's `record` (exactly what `createRecordsUpload` takes)
and per-field `origin`, `source`, `confidence`, `uncertain`, and `reason`,
plus `dropped` items with their reason. Metrics fields the study does not
state keep the stored row's values (a merge row replaces the whole row); such
a row has its Source flagged, because staging credits the whole row to this
study. A file is read row by row and capped at 2,000 rows, 100 columns, and
20 sheets per table, and 200,000 characters of text (as for pasted text);
`input.truncated` then says that only part of it was read. The helper reads
one study at a time (a second request meanwhile is 409 `assist_busy`, also
while a cancelled one is still running), and one proposal has 180 seconds in
total across all its requests to the provider.

**Measure accuracy** on the fixed synthetic study set
([`assist_eval/`](assist_eval/README.md), seven excerpts with expected
records) against a store with the demo pack:

```bash
npm run demo:build                       # once: the demo store
.venv/bin/python -m app.assist.evaluate --db data/dashboard-demo.sqlite --provider fake
.venv/bin/python -m app.assist.evaluate --db data/dashboard-demo.sqlite --provider hosted   # uses data/dashboard-demo.assist.json
.venv/bin/python -m app.assist.evaluate --db data/dashboard-demo.sqlite --provider local --json
```

It reports field accuracy (expected fields proposed correctly), record recall
and precision, expected drops, uncertainty flags, codes found in the store,
and sourced fields. The fake provider (canned answers, used by the tests)
scores 193 of 194 fields (99.5%): its one miss is the deliberately vague
group of excerpt E5, which it flags as uncertain. A hosted or local run sends
the seven synthetic excerpts to that provider; its accuracy was not
measured while building the helper (no key).

## Tests

```bash
cd backend
.venv/bin/python -m pytest
```

The suite imports the full seed into a temporary store (about 15 s), then runs
the parity tests of gates A1 and A2, the API tests, and the update-workflow
tests of gate A3 (pilot spec §8.2), and the dashboard tests below. It takes
about 3 minutes in total.

- To reuse a persistent store between runs, run
  `BMC_TEST_DB=data/broad_modelcard.sqlite .venv/bin/python -m pytest`.
- The latency test and the full-store A3 gate are marked `slow` and run by
  default. Skip them with `-m "not slow"`, or scale the latency targets on
  slower machines with `BMC_PERF_FACTOR=2`.
- Tests that publish work on their own copy of a store (`copy_store` in
  `conftest.py`); the shared stores stay at version 1.

- `test_storage_parity.py`: every stored value equals the JSON. Strings and
  integers must match exactly and floats within 1e-9. This covers 2.16 M metric
  tuples, the multimorbidity tuples, prevalence tiers, the registry, and the
  concepts.
- `test_derivation_parity.py`: service output equals the reference client.
  It covers every chapter and block, a seeded sample of 3,000 concept/lens
  cases, multimorbidity candidates and display rows, and a reduced table set
  that exercises the demographic fallback.
- `test_import.py`: import behavior on a tiny synthetic table set: seed-root
  path resolution, idempotency, `--check`, and one rejected case per
  validation rule.
- `test_rules.py`: JavaScript numerics, statuses, warnings, and safeguards.
- `test_safeguards_v14.py`: the v1.4 rules on the whole seed. No "stable"
  safeguard on a row that is not Strong or Moderate overall (all 10 targets,
  every condition and rollup), and a warning share on every aggregated row.
  The parity tests apply the deviations of CONTRACT.md §12.1 to the reference
  output and fail on any other difference.
- `test_contract_drift.py`: the running app against `openapi.json`, for all 30
  operations. It covers operations, paths, methods, operation ids, parameter
  names and required flags, request bodies (the multipart upload and the
  publish, records, and rollback bodies), declared response statuses, and the success content types and
  schemas generated from the Pydantic models. It also validates sample
  responses for every read operation and a pass through every admin operation
  against the committed schemas. It runs the in-repo validator in
  `contract_schema.py`, whose own tests are in `test_contract_schema.py`.
- `test_api_endpoints.py`: every read endpoint. It covers success, unknown
  model or use case (404), invalid lens (422), empty results, problem details,
  ETags and 304, and staged versions.
- `test_api_parity.py`: API responses equal the services and the reference
  client. It covers 4,340 concept rows, metric maps, multimorbidity
  candidates, rows, and display cells, 12 search queries, and the
  dataset-export summary. It also checks that the batched multimorbidity
  display path equals `display_row()` cell for cell.
- `test_api_budgets.py`: the 2 MB response cap and the latency targets,
  including the catalogue's 300 KB and warm 150 ms budget on the seed and the
  demo store (cold, build, and warm timings are printed).
- `test_catalogue.py`: the catalogue. Tile counts equal `/metrics/summary` for
  every view and configuration on the seed and the demo pack, every tile
  lists all chapters and they add up, `last_updated` follows metrics,
  registry, prevalence, rollback, safety, and linked-study publishes, a build after new
  publishes reads only the new versions (no earlier registry set is loaded
  again), the demo tiles count safety incidents, staged reads show the staged
  change, and ETags answer 304.
- `test_card_names.py` (2026-10-21): registry uploads, records, and
  submissions refuse `|` and `,` in a model version or function
  (`separator_in_name`); the seed and demo names have neither.
- `test_appraisal_marks.py` (2026-10-21): the map's `appraisal` and the
  summary's `appraisal_counts` appear only when a row is linked, agree with
  each other, follow lens fallbacks, local results, and other ontologies.
- `test_audience_reads.py` (contract v1.14, §30): the weighted distribution
  (hand-checked on the tiny store, rebuilt from the map and the overview's
  prevalence, local population and setting), the version feed's card filter
  against every tile's `last_updated`, the public incident list against the
  admin one, and pinned digests of reads without the new parameters.
- `test_api_runtime.py`: loopback-only startup, concurrent requests over real
  HTTP, export streaming, and the cache bounds.
- `test_api_guard.py`: the local-only guard (403 for non-loopback clients,
  foreign or malformed `Host` headers, `Origin`s other than the request's own,
  and cross-site writes; admin reads and writes and the lookup from another
  localhost page; the app's own same-origin requests still pass).
- `test_spreadsheets.py`: reading CSV and XLSX uploads (encodings, delimiters,
  comments, blank rows, row numbers, format detection).
- `test_admin_service.py`: the workflow without HTTP on the tiny store: round
  trips of every template, one staged upload per data set, discard, atomic
  publish under an injected failure, serialized publishes, rollback, and
  resuming checks after a restart.
- `test_admin_rules.py`: every validation rule through the API, each with its
  row, column, and reason, nothing published, and the cells marked in both
  annotated formats.
- `test_registry_entries.py`: the v1.5 registry fields. Old-format registry
  files stay valid, filled templates round-trip without changes (CSV and
  XLSX), a product built on a model joins the registry metrics first, each
  new rule rejects with row, column, and fix, entry fields must agree on
  every row, and migration 0003 leaves existing registry rows as models
  without the new fields.
- `test_admin_workflow.py`: data sets, templates, staged reads on all 13 read
  endpoints (live reads unchanged byte for byte), change summaries, publish and
  rollback compared row for row, the new-model flow, rollback conflicts, and
  the 413 limits.
- `test_safety_merge.py` (contract v1.7): severity and the lens rule, one
  incident entered with the records upload, checked, previewed, and published
  with a note, incident rules with record indexes, codes and chapters,
  safety merges (replace in place, removal, the newer report stays), a
  metrics merge that changes only its rows (every other row byte-identical),
  removal only with the marker, required sources, the older-study rule, a
  merge adding a lens group, a prevalence merge, a staged merge checked again
  when its base changes, change notes, and migration 0004 on a schema-3 store
  with published versions and staged uploads.
- `test_demo_pack.py`: the demo pack builds into a copy of the seed import
  (every file publishes, registry last), the products and entry fields are
  served, the safety incidents and the one-study merge are served, the
  publishes appear in the history with their notes, the pack names nothing real,
  a broken manifest or file fails loudly, the live store and its uploads
  folder are refused, and `BMC_UPLOADS_DIR` moves the uploads folder.
- `test_lookup.py` (contract v1.8): the lookup serves exactly what
  `/metrics/concepts`, `/multimorbidity/combination`, and `/metrics/map` serve
  for the same cards, codes, lenses, and version (live and staged); closed
  inputs; nothing of a request body in logs or problems; the 50 KB and 50 ms
  budget.
- `test_populations.py` (contract v1.10): local populations through the
  existing formulas, default reads unchanged byte for byte, keyed caches and
  ETags, staged population previews, removal and restore, the patient-level
  check, and the `prevalence_incomplete` block.
- `test_merge_rechecks.py`: a staged merge is checked again when its base
  moves (also during its own check), and the catalogue never serves a
  re-checked set's old counts.
- `test_migrations_concurrent.py`: several processes migrating one fresh
  store apply each migration once.
- `test_assist.py` (contract v1.9): the LLM helper, offline. Off by default
  with how-to-enable text; configuration rules (write-only key, mode 600, path
  per store, no value echoed in problems); proposals from the fixed study set
  with sources, flags, stored values, and drops (unknown code, unknown or
  other card, subcategory, lens); proposing stages and publishes nothing, and
  accepted records become a valid staged merge upload; the hosted tool loop and
  PDF document block, the local two-pass resolution, and provider errors
  (401, 429, 500, redirect, refusal, cut-off, non-JSON, unreachable) against a
  stub HTTP server on 127.0.0.1 (`assist_stub.py`); input limits; the fake
  evaluation's numbers; and a canary key that never appears in a response, a
  log record, the SQLite files, or the uploads folder.
- `test_admin_gate.py` (slow): gate A3 on the full store. Round trips, the
  216,000-row metrics check measured in a fresh process
  (`measure_upload_check.py`), status shifts and removals, staged reads, and
  publish and rollback compared row for row.

**Reference implementation.** The derivations reproduce the client code at tag
`v0.2.0-alpha.1`, not the working tree, because the frontend is being
restructured. On first run, `tests/conftest.py` takes these steps:

1. It extracts `src/` at that tag with `git archive` into `backend/.reference/`
   (gitignored).
2. It runs `tests/reference/generate_reference.mjs` with Node to write the
   expected outputs. For search, which lives inside the reference's `App`
   component, the generator holds a copy of the code. It fails if the tagged
   `src/App.jsx` no longer contains the copied lines.

It passes the seed directory, so the reference client reads the same bytes it
once fetched. The fixtures are regenerated only when the generator, the tag,
or the seed change.

## Layout

```text
app/
  main.py              FastAPI app factory (create_app) and module-level app
  serve.py             python -m app.serve: uvicorn on 127.0.0.1
  api/                 HTTP layer
    schemas.py         Pydantic response models mirroring openapi.json
    params.py          shared query and path parameters
    problems.py        problem+json errors and their codes
    store.py           connection, lock, version resolution, response cache
    responses.py       JSON encoding, ETag, If-None-Match
    guard.py           local-only guard (403 local_only)
    limits.py          body size limits (413 before the body is read)
    routes/            one router per contract tag (meta, catalogue, atlas,
                       metrics, multimorbidity, search, export, lookup, admin;
                       assist.py: the helper's admin operations, v1.9)
    assist_schemas.py  Pydantic models of the helper's operations
  db.py                connection settings and migration runner
  migrations/          versioned SQL (0001_initial.sql, 0002_uploads.sql,
                       0003_registry_entries.sql, 0004_safety_merge_provenance.sql,
                       0005_populations.sql, 0006_intended_use_statement.sql,
                       ... 0013_care_settings.sql: the care settings of the Context axis, v1.14)
  schema/contract.py   contract constants (row format, tiers, statuses, ...)
  schema/templates.py  upload template columns, allowed values, instructions
  repository.py        read-side SQL
  services/            derivations ported from the reference client
    jsnum.py           JavaScript-compatible rounding, means, collation
    grading.py         evidence/performance/overall grades, tiers, statuses (§4.2–§4.5)
    decode.py          stored tuple → normalized row (§4.1)
    aggregation.py     rollups (§6), demographic fallback (§7), weakest row (§8)
    safety.py          warning relevance and safeguards (§4.6)
    incidents.py       safety incidents: severity, lens rule, marks (§18)
    atlas.py           concepts, anchors, prevalence (§5)
    metrics.py         single-disease rows per model/use case
    multimorbidity.py  combinations, candidates, display rows (§8)
    presentation.py    MetricRow / MetricMap shapes from openapi.json
    dataset.py         entry point: Dataset(conn).metrics(model, use_case).row(...)
    catalog.py         Concept records, paths, and map scopes per version
    summary.py         status counts (/metrics/summary)
    catalogue.py       catalogue tiles, distributions, last update (/catalogue)
    search.py          concept search (§9) with synonym matches (§31)
    interpret.py       the plain-language interpreter (§31)
    exports.py         concept export and the streamed dataset export
    links.py           atlas.html links in the atlas URL vocabulary (lookup, §19)
  importers/legacy_json.py   seed import and --check (python -m ...)
  importers/spreadsheets.py  read uploaded CSV/XLSX files
  validation/legacy_tables.py contract checks of the seed
  validation/issues.py       problem codes, messages, fixes, and grouping
  validation/uploads.py      upload checks per data set → content
  publishing/          the update workflow
    uploads.py         AdminService: upload lifecycle, background checks,
                       publish, rollback, templates, annotated files
    content.py         content of one data set: read, write, delete sets
    versions.py        version swaps, consistency, history, data set counts
    changes.py         change summaries and status shifts
    files.py           template and annotated CSV/XLSX writers
  demo/builder.py      python -m app.demo build: the demo store from the pack
  assist/              LLM-assisted data entry (contract v1.9, CONTRACT.md §20)
    config.py          provider configuration file (mode 600), key redaction
    inputs.py          the study: PDF, text, CSV/XLSX rendered with row numbers
    prompting.py       system prompt, field lists, search tool, JSON answers
    providers.py       hosted (Anthropic Messages) and local (OpenAI-compatible)
                       over urllib, and the fake provider
    proposals.py       checks against the store, code resolution, records
    service.py         status, configure, propose (AssistService)
    studyset.py        the fixed synthetic study set
    evaluate.py        python -m app.assist.evaluate: field-level accuracy
    interpret.py       the search rewrite: prompt and chip checks (contract v1.14, §31)
seed/                  the official seed (see seed/README.md)
demo/                  the dashboard demo pack (see demo/README.md)
assist_eval/           the helper's synthetic study set (see assist_eval/README.md)
tests/
```

Example:

```python
from app import db
from app.services.dataset import Dataset
from app.services.types import Lens
from app.services import presentation

dataset = Dataset(db.connect(db.DEFAULT_DB_PATH, read_only=True))
metrics = dataset.metrics("SynGPT-2.0", "Clinician Facing CDSS")
row = metrics.row("CH-05", Lens(age="Age 65+"))
presentation.metric_row(row, model_version="SynGPT-2.0", use_case="Clinician Facing CDSS")
```

## Store design

- **Static atlas.** `concepts` keeps the source order, which the derivations
  iterate. The atlas also includes `axis_values` and `lens_combos`, where
  `combo_idx = age_idx×18 + sex_idx×6 + eth_idx`. Since migration 0013
  (contract v1.14, CONTRACT.md §29) the context axis holds `Clinical` (Any
  setting) and five care settings, and a combination of a specific setting adds
  `setting_idx×90`, so every Any-setting index is unchanged; the seed import
  adds the same values after the seed's own.
- **Content sets.** Updatable data lives in immutable sets of six kinds:
  `models`, `prevalence`, `metrics` (per model and use case),
  `multimorbidity` (per model and use case), `safety` (migration 0004;
  `safety_incidents` and `safety_incident_conditions`), and `population`
  (migration 0005; per `content_sets.population_id`, tiers in the prevalence
  tables, the name in `population_sets`). A store has no safety set until the
  first safety publish, and no population until the first population publish.
- **Row sources** (migration 0004). `provenance_sources` interns
  (source, study, source date); `set_provenance` gives each set its default
  source (none: the seed's, id 1), and `metric_row_provenance` and
  `prevalence_provenance` hold the rows whose source differs from it.
- **Merges.** A merge upload's set is a copy of the live set (`INSERT …
  SELECT`) with its rows removed, replaced, or added; `content_sets.meta_json`
  records the base set and the number of touched rows.
- **Migration options.** A migration whose first line is
  `-- bmc: foreign-keys-off` runs with foreign keys off and a
  `PRAGMA foreign_key_check` before it commits (0004 rebuilds
  `dataset_versions`, `content_sets`, and `uploads` to add `safety` to their
  kind CHECK constraints, and adds `dataset_versions.note`, `uploads.mode`,
  and `uploads.origin`; 0005 rebuilds the same three tables to add
  `population`, and adds `content_sets.population_id`,
  `uploads.population_id`, `uploads.population_name`, and `population_sets`).
  0006 (contract v1.11) only adds `use_case_variants.intended_use_defined`
  (NULL: the card states its intended use; 0: it has no statement); a row
  without an intended-use value is stored with the empty level `''`.
- **Dataset versions.** A version (`dataset_versions`) lists its sets in
  `version_content_sets`. The live version is the highest `version_id`.
  The import is version 1, with `kind` NULL because it covers every kind.
- **Publishing and staged reads.** Publishing or rolling back adds a version
  that points at new or earlier sets. A staged read swaps one set id.
  Neither copies or overwrites rows.
- **Uploads.** `uploads` (migration 0002) records each upload: kind, target,
  file, status, progress, report, staged set, `previewed`, and the version it
  was published as. A partial unique index allows one staged upload per data
  set. A discarded or superseded upload's set is deleted; a set that a version
  lists never is.
- **Metric storage.** `metric_rows` stores the 13 source fields as given, without
  normalization. It is a `WITHOUT ROWID` table keyed by
  `(set_id, combo_idx, concept_id)`, so an atlas map for one lens is a single
  range scan. Warning lists are interned in `warning_sets` (96 distinct lists),
  and their stored order is kept.
- **Multimorbidity storage.** Combinations keep their stored condition order,
  plus the canonical unordered `combination_key`.

## Implementation notes

- `Dataset` caches decoded rows per model/use case. Keep one instance per
  dataset version, not one per request.
- `presentation.metric_row()` and `presentation.map_row()` already return the
  `MetricRow` and `MetricMap` row shapes of `openapi.json`. `evidence_signal` is
  the derived evidence score with penalties applied, and it is null when the
  stored grade is served.
- Within one relevance level, warnings are ordered by code. The reference
  ordered them by display title, which is frontend copy (CONTRACT.md §4.6).
- `collation`: `localeCompare` is approximated by an ICU-root sort key. It
  matches Node's order for all 13,675 preferred terms and all concept ids. A
  browser in a different locale could order differently, so the backend fixes
  the English/root order.
