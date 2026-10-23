# Project Broad Modelcard

A safety and performance dashboard for healthcare AI, built around an interactive model card. A **catalogue** lists fictional AI systems (models and products), one tile per **card** (one AI system with one function). Each card opens an **ICD-11 atlas**: a risk and coverage map that shows where the system's performance, evidence strength, intended-use fit, and reported safety incidents are strong, weak, missing, or out of scope, per condition, disease combination, demographic group, and (optionally) local population. The atlas can also be drawn in **ICD-10-CM** or **MONDO**, which show the ICD-11 result each condition maps to.

Around the atlas: a **condition card** with the study behind each result (risk of bias, reporting guideline), results across population groups, effects on outcomes, and a hospital's local results beside the public ones; a **comparison** of 2–4 cards; a **live interaction panel** that shows where a synthetic case falls on a card; a **model card** that summarises a card on one page (never a certification); a per-browser **profile** ("My systems", an audience preset for clinicians, patients, procurement and governance, regulators, or payers, each with a short audience summary); and the **Data Library**, where developers submit, custodians review, hospital administrators add local data, and maintainers update every data set, in workspaces without login, through validated uploads, one-record forms, or an optional study helper.

Since release 0.5 a card also states its **configuration** (prompt summary, retrieval, tools, sampling), its **version lineage**, and what its figures measure; results can be read per **care setting**; a result says whether it was measured on the current configuration; a product's condition card shows the model it is **built on**; **plain-language search** turns a query such as "heart attack in older women in the emergency department" into visible filters; and operational systems on this machine can read a compact **card record** (JSON or JSON-LD) or call a local **CDS Hooks** service. Evaluation results run elsewhere can be imported as proposals for review.

**All data is synthetic demonstration data with fictional names.** This is a research prototype, not a clinical or governance tool, and not for clinical use. Never add real or patient data.

The app has two parts: a React frontend that only renders and interacts, and a local Python backend that owns the data, its validation, and its updates. The frontend reads everything from the backend API.

## Try It

1. **Hosted read-only demo** (GitHub Pages; deployed by `.github/workflows/pages.yml` from `main`): the catalogue, the atlas, and the comparison, recorded from the demo store and served as plain files with no backend. It holds all patients or one population group at a time in ICD-11, all patients in MONDO and ICD-10-CM, the care settings each card stores (all patients, ICD-11), the default prevalence, the five audience summaries, plain-language search with synonyms, and each card's record. It leaves out the Data Library and every update, combined population groups, condition details at a group, local populations, exports, the live interaction panel, and the CDS Hooks service. See [The Static Demo](#the-static-demo-github-pages).
2. **The full app on your computer**: the separate backend and frontend, local only (the backend listens on 127.0.0.1, without authentication). See [Getting Started](#getting-started-from-a-clean-clone), [Trying the Demo](#trying-the-demo), and [Commands](#commands).

## Tech Stack

- Frontend: React 18, Vite 5, plain JavaScript, jsPDF for PDFs (`frontend/`)
- Backend: Python 3.14 (3.12+ expected to work), FastAPI, uvicorn, pydantic, python-multipart, openpyxl, and the standard library (`sqlite3`; `urllib` for the optional helper) (`backend/`)
- API contract: [`backend/openapi.json`](backend/openapi.json) (shapes) and [`backend/CONTRACT.md`](backend/CONTRACT.md) (semantics), v1.14

## Getting Started (from a clean clone)

Prerequisites: Node.js 20+ with npm, and Python 3.12+ (3.14 is used in development). Run every command from the repository root.

```bash
# 1. JavaScript dependencies (exact versions from package-lock.json)
npm ci

# 2. Backend environment, once (pinned versions from requirements-dev.txt)
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements-dev.txt

# 3. Data store, once: imports the seed into backend/data/broad_modelcard.sqlite (about 15 s),
#    or into $BMC_DB when that is set
(cd backend && .venv/bin/python -m app.importers.legacy_json)

# 4. Run the app: starts the backend on 127.0.0.1:8000, then Vite, which proxies /api to it
npm run dev
```

On Windows, use `backend\.venv\Scripts\python` and `backend\.venv\Scripts\pip` in place of the `bin` paths.

The seed alone has 7 models and 10 cards, without safety incidents, products, or local populations; every seed card states an intended use, and its results without validation evidence read No data. To see the whole dashboard, use the demo store (next section).

`npm run dev` waits for the backend before starting Vite, prints the import command if the store is missing, and stops both processes on Ctrl+C. Set `BMC_API_PORT` to use another backend port and `BMC_DB` to use another store. If a backend already answers on the port, `npm run dev` reuses it only when this checkout started it (recorded in the gitignored `backend/data/dev-api-<port>.json`) on the same store. A backend from another checkout or git worktree may serve another database, so it is refused: stop it, or give each checkout its own port, for example `BMC_API_PORT=8020 npm run dev`.

## Trying the Demo

The demo store is a separate store with the seed plus the **demo pack** ([`backend/demo/`](backend/demo/README.md), pack v13), published through the normal update workflow: 4 models and 9 products (the 7 seed systems, three of them task-specific products, and 6 fictional products; 16 cards), 22 fictional safety incidents, the fictional local population "Northbridge region (fictional)" with a hospital's local results for ICU_GPT-1.0, the demo revision (the three broad language models have no intended-use statement; every result with a performance value has synthetic evidence), 15 study records with some rows linked to them, 3 effects on outcomes, configuration records and lineage (SynGPT-2.0 replaces SynGPT-1.0; Vantrel Triage 2.1 replaces 2.0), setting-specific results for five cards, one imported evaluation run (MediCore-2.5 decision support), two products for patient communication and clinical coding, and two developer submissions waiting for a custodian. A fresh build ends at dataset version 44. It never touches the live store.

```bash
npm run ontologies:fetch   # once, optional: the pinned ICD-10-CM, MONDO, and WHO mapping releases (about 80 MB)
npm run demo:build         # (re)build backend/data/dashboard-demo.sqlite: seed + demo pack (+ ontologies), about a minute
npm run demo               # backend on 127.0.0.1:8010 + Vite on the demo store
```

Then open (Vite's default port is 5173; it picks the next free one if that is taken):

| Page | URL | What it is |
|---|---|---|
| Catalogue | <http://localhost:5173/> | Every card as a tile led by its atlas in miniature; tabs All – Performance, All – Safety, My systems; filters and sorts; Track and Model card |
| Atlas | <http://localhost:5173/atlas.html> | One card's atlas: views Overview, Performance, Evidence, Intended use, Safety; population and care setting; classification (ICD-11, ICD-10-CM, MONDO); modes Conditions and Multimorbidity; plain-language search |
| Compare | <http://localhost:5173/compare.html> | 2–4 cards side by side by chapter and condition, with "Not directly comparable" reasons |
| Data Library | <http://localhost:5173/admin.html> | Workspaces (developer submission, custodian review, hospital administration, maintainer), nine data sets, History, the instance, public releases |
| Live interaction | <http://localhost:5173/plugin.html> | The live panel beside a simulated host application, with synthetic cases, and a CDS Hooks request mode |
| Embed test | <http://localhost:5173/embed-test.html> | A plain host page that loads the panel with one script tag |

Rebuilding the demo store discards everything published into it.

## Commands

```bash
npm run dev              # backend + Vite dev server (scripts/dev.mjs), live store
npm run build            # production build into frontend/dist, incl. dist/embed/bmc-live-panel.js
npm run preview          # backend + the production build (run npm run build first)
npm run api              # backend only (python -m app.serve)
npm run demo:build       # rebuild the demo store backend/data/dashboard-demo.sqlite (seed + demo pack)
npm run demo             # backend (port 8010) + Vite on the demo store
npm run static:record    # record the static snapshot from the demo store into frontend/static-data/
npm run build:static     # record, then build the read-only static site into frontend/dist-static/
                         #   (-- --ontologies <list>; default icd11,mondo,icd10cm or $BMC_STATIC_ONTOLOGIES)
npm run ontologies:fetch # download the pinned ICD-10-CM, MONDO, and WHO mapping releases (checksums verified)
npm run ontologies:import # import them into $BMC_DB (npm run demo:build does it when they are downloaded);
                         #   then restart a backend already running on that store, which keeps what it loaded
npm test                 # frontend tests (node --test), then backend tests (pytest)
npm run test:frontend    # node --test; some tests start the real backend on the store
npm run test:backend     # pytest in backend/.venv (or the interpreter in BMC_PYTHON)
npm run validate-seed    # check backend/seed against the data contract; no store is touched
```

Environment variables: `BMC_DB` (store file), `BMC_API_PORT` (backend port; default 8000, demo 8010), `BMC_VITE_PORT` (Vite port, strict; for parallel runs, for example `BMC_API_PORT=8061 BMC_VITE_PORT=5211 npm run dev`), `BMC_UPLOADS_DIR` (folder for upload files), `BMC_PYTHON` (Python interpreter), `BMC_ASSIST_CONFIG` (the helper's configuration file). Extra arguments after `--` go to Vite (`npm run dev -- --port 5180 --strictPort`) or to the demo builder (`npm run demo:build -- --db /path/to/store.sqlite`).

## The Atlas URL

The atlas keeps what is on screen in its URL, so a copied URL reopens the same state for every reader. All parameters are optional; unknown or malformed values are ignored ([`frontend/src/app/startupParams.js`](frontend/src/app/startupParams.js)).

| Parameter | Values |
|---|---|
| `model` | AI system (registry `model_version`), e.g. `SynGPT-2.0` |
| `use_case` | function of that AI system, e.g. `Clinician Facing CDSS` |
| `view` | `overall` (the Overview), `performance`, `evidence`, `intended_use`, `safety`; `intended_use` on a card without an intended-use statement opens the Overview |
| `age`, `sex`, `ethnicity` | demographic lens as labelled, e.g. `Age 65+`, `Sex Female`, `Ethnicity Asian`; absent means "All …" |
| `population` | a local population id, e.g. `northbridge-region`; absent means the default prevalence |
| `setting` | a care setting code: `emergency_department`, `intensive_care`, `inpatient_ward`, `outpatient_clinic`, `primary_care`; absent means Any setting |
| `ontology` | `icd10cm`, `mondo`; absent means ICD-11 |
| `mode` | `focused` (Conditions), `multimorbidity`; `detailed` from older links opens `focused` |
| `depth` | `plain`, `expert` (only when it is not `plain`) |
| `chapter` | the open ICD-11 chapter (absent at atlas level) |
| `concept` | the selected chapter, subchapter, or condition |
| `selected` | the multimorbidity selection, comma-separated condition ids |
| `version` | `staged:<upload_id>` to preview an unpublished update; absent for live data |

Example: `atlas.html?model=SynGPT-2.0&use_case=Clinician+Facing+CDSS&view=safety&age=Age+65%2B`. A link that names only the card (`model`, `use_case`) opens with the reader's own defaults (Settings); any other parameter makes the link open exactly what it names. The comparison keeps its state the same way (`cards`, `chapter`, the lens, `population`, `ontology`, `show`, `sort`, `depth`, and the `view` its links back to the atlas open; [`frontend/src/features/compare/compareState.js`](frontend/src/features/compare/compareState.js)); a comparison link that names only `cards` takes the reader's default lens, population, classification, and depth. The catalogue keeps its own state in its URL (`tab`, `sort`, `system`, `function`, `category`, `kind`, `ai_type`, `developer`, `status`, `newest=1` for newest versions only); a catalogue URL that carries atlas parameters forwards to `atlas.html`, so links from before the catalogue keep working.

## The Seed

[`backend/seed/`](backend/seed) holds the official seed: synthetic JSON tables (about 350 MB) that a fresh clone imports into the store as **dataset version 1**. It is the only source of that import.

- `atlas-base.json`: the ICD-11 atlas (21 chapters, 225 blocks, 13,442 categories) and the demographic axes
- `prevalence_by_code.json`: one commonness tier per ICD-11 code
- `model-registry.json`: 7 models and their 10 functions
- `models/*.metrics.json` and `models/*.multimorbidity.metrics.json`: metrics per card, and for disease combinations

The seed is never edited by hand: data changes go through the Data Library. `npm run validate-seed` runs the import's checks without building a store. To start over from the seed, discarding every published update, run `(cd backend && .venv/bin/python -m app.importers.legacy_json --rebuild)`; without `--db` the import builds `$BMC_DB` when it is set, else `backend/data/broad_modelcard.sqlite`. See [`backend/seed/README.md`](backend/seed/README.md).

## Updating Data (maintainers)

Start the app and open the **Data Library** (`/admin.html`). It first asks for a **workspace**: Developer submission, Custodian review, Hospital administration, or Maintainer. There is no login: the choice decides which pages you see and is recorded with every publish, together with the name you enter. A developer's submission (an AI system entry, performance metrics, studies, a narrow model card) never publishes on its own; a custodian reviews each part's check and change summary, previews it, and accepts or returns it with a note. The Maintainer workspace lists every data set with its current version and last update, plus **History**:

- **AI systems & functions**: the registry. Each AI system is a model or a product, with optional kind, AI type, developer, release date, description, "built on", **Replaces** (the earlier version it supersedes), function category, the developer's declarations including how patient data is handled (shown as "Declared by the developer", never as checked), **Intended use stated** (No for a card without an intended-use statement, such as a broad language model), and per card a **configuration record** (ID and date, prompt summary and checksum, retrieval, tools, sampling, fine-tuning) and what the figures measure (performance measure, reference standard). A new configuration ID moves the card's "Updated" date.
- **Performance metrics** and **Multimorbidity**: per card (choose the AI system and function first). Rows may name a care setting (an empty Setting means Any setting). **Import evaluation results** reads the JSON output of a benchmark or evaluation run done elsewhere ([`docs/evaluation-results.md`](docs/evaluation-results.md)) and proposes a benchmark study and its results; you tick what to stage, and it goes through the same check, review, and publish.
- **Prevalence**: the default commonness tier per ICD-11 code.
- **Safety incidents**: reported safety events per card, marked Caution or Serious. The page lists the chosen card's stored incidents (open, mitigated, and closed); **Edit** fills the form with one, so it can be changed, closed, or reopened.
- **Local populations**: named local prevalence sets (aggregate only; files that look patient-level are rejected and deleted).
- **Studies**: one record per study (design, setting and setting category, sites, patients, peer review, who conducted it, reporting guideline, risk of bias, applicability concerns, appraisal tool and score, configuration evaluated); a metrics row links to one through its Study column, and a followed guideline or a risk of bias moves its evidence grade. Applicability, the appraisal score, and the setting category are shown, never graded.
- **Effects on outcomes**: what using an AI system changed for patients or care, from a trial or prospective study; never graded.
- **Local results**: a hospital's own evaluation results for a card and local population, each naming a hospital study; with the population chosen they replace the public results.
- **Narrow model cards**, **Instance** (Public service or Hospital version, who maintains it), and **Public release** (export the public layers; a hospital version imports them and keeps its local data).

Each data set page walks through the update as steps:

1. **Get the spreadsheet.** Download the current data (recommended) or an empty template, as Excel or CSV. The Excel file explains every column and offers the allowed values as dropdowns.
2. **Choose how the file changes the data.** *Replace* makes the file the whole data set: rows missing from it are removed on publish, and the page says so. *Add or change rows* (Performance metrics, Prevalence, Safety incidents) changes only the rows in the file; a row is removed only when its Action column says Remove, every added or changed row needs its Source, Study, and Source date, and a row from an older study than the stored one is kept out. A metrics row with a Performance value needs its evidence (a Validation type); a row without it is rejected. For one incident or one metrics row, use the form on the page instead of a file.
3. **Upload and check.** **Never upload patient data**: files hold aggregate, synthetic demonstration results only. Every row is checked against the atlas's rules (a full 216,000-row metrics file takes a few seconds as CSV, up to about 30 s as Excel). Problems are grouped, each with how to fix it and the spreadsheet row numbers; download your file with every problem marked, fix it, and upload it again.
4. **Review the changes.** Rows added, changed, and removed, and how conditions move on the atlas ("Moderate → Strong").
5. **Preview on atlas.** Opens the atlas on the update before it is live, marked as an unpublished preview, with every changed condition ringed. Recommended, not required.
6. **Publish** with a short change note that says why. Open catalogue, atlas, and panel pages pick up the new version within 5 minutes, or at once when their window regains focus; the page offers **Restore** of the previous version.

Only one update per data set (per card for metrics and multimorbidity, per population) can wait at a time; a new file asks whether to replace it, and **Discard** removes it. Nothing reaches live data until you publish. **History** lists every version with its change note; **Restore** publishes an older version's data again as a new version, and nothing is ever deleted. By default it restores **Everything** (it undoes every later change, in one new version) and lists the versions it takes back; it can be narrowed to one data set. A restore that would change nothing is explained and cannot be sent.

To add a new AI system or function: upload the AI systems list first (it will say the new function has no metrics yet), upload and publish its performance metrics, then publish the list.

The templates, every validation rule, and the change summary are documented in [`backend/README.md`](backend/README.md) ("Update data").

## The Study Helper (optional, off by default)

On the Performance metrics and Safety incidents pages, a helper can read one study (PDF, text, or a CSV/XLSX table) and **propose** records, each value with the quote and location it comes from, and uncertain fields flagged. It uses only ICD-11 codes and cards that exist in the store, lists what it left out and why, and stages only the records you tick, as an *Add or change rows* update that goes through the same check, review, preview, and publish. It never publishes anything by itself. Without it, the Data Library works fully.

- **Turn it on:** "Set up the helper" on either page. Choose a **hosted model with your own API key** (Anthropic Messages API; PDFs supported) or a **local model** on this computer with an OpenAI-compatible API (its address must be `127.0.0.1`, `::1`, or `localhost`; text and tables only). The same settings are available through the API (`PUT /api/v1/admin/assist`, see `backend/README.md`).
- **The key** is write-only: it is kept in one file on this machine (`backend/data/assist.json` for the live store, `<store name>.assist.json` next to any other store; mode 600, gitignored) and never reaches the browser, logs, store, uploads, or exports.
- **What leaves the machine:** only when you press Propose, and only to the provider you configured: the study you submit, the helper's instructions, the list of cards (AI system, function, display name), the lens values, and for a hosted model the results of its condition searches (atlas codes and names). With a local model nothing leaves the machine. Submit synthetic or published text only, never patient data.
- **Plain-language search:** while the helper is on, the atlas search offers "Ask with the helper": only the query text and the vocabularies (lens values, settings, system and function names) are sent, and every chip it returns is checked against them.
- **Accuracy:** measured on a fixed synthetic study set with `(cd backend && .venv/bin/python -m app.assist.evaluate --db data/dashboard-demo.sqlite --provider fake|hosted|local)`. The offline fake provider scores 193 of 194 fields; a real model's accuracy has not been measured yet.

## The Live Panel and Embedding

`<bmc-live-panel>` is a dependency-free web component ([`frontend/src/embed/`](frontend/src/embed)) that a host application places next to its AI output:

```html
<script type="module" src="/embed/bmc-live-panel.js"></script>
<bmc-live-panel model="SynGPT-2.0" use-case="Clinician Facing CDSS"
  codes="5A11, GB61" age-group="65+" sex="female"></bmc-live-panel>
```

- Attributes: `model` and `use-case` (the card), `codes` (up to 8 comma-separated ICD-11 codes), `age-group` (`0-17`, `18-39`, `40-64`, `65+`), `sex` (`female`, `male`), `ethnicity` (`white`, `black`, `hispanic`, `asian`, `other`), and optionally `population` (a local population id from `/meta`, e.g. `northbridge-region`; the panel then reads that local prevalence and its local results), `version` (`staged:<upload_id>`), `depth` (`plain`, `expert`), and `api-base` (default `/api/v1`). Other values are ignored. There is no free text and nothing is stored.
- It shows the statuses, top warnings and safeguards, open safety incidents, and the stored combination for the case on that card, with links into the atlas, from one `POST /api/v1/lookup`, and always states "Demonstration on synthetic data, not for clinical use". It checks for a new version every 5 minutes and on focus.
- `npm run build` writes the script to `frontend/dist/embed/bmc-live-panel.js`; in development, `plugin.html` and `embed-test.html` load it from source.
- **Limits:** the host page must be served from this machine through the app's dev or preview server (same origin as the API). The API sends no CORS headers and refuses foreign origins, so embedding in another application needs CORS and authentication first. The panel does not take a local population yet. There is no EHR integration, and the panel is not for clinical use.

## Card Record and CDS Hooks (local, synthetic)

- **Card record:** `GET /api/v1/cards/record?model=<AI system>&use_case=<function>` returns one card as compact JSON (`bmc-card-record/1`: the AI system and card, configuration, declarations, linked studies, effects, public incidents, per-chapter statuses for every view at all patients, the Overview counts, links), about 11–18 KB; `&format=jsonld` returns the same as JSON-LD, with Model Card Report Ontology terms for the model card sections (CONTRACT.md §32). The atlas Summary offers it as "Card record (JSON)".
- **CDS Hooks:** `GET /api/v1/cds-services` lists one service, `bmc-condition-status` (hook `patient-view`). `POST /api/v1/cds-services/bmc-condition-status` takes a CDS Hooks request whose prefetch holds a FHIR `Patient` and `Condition` resources coded in ICD-11 or ICD-10-CM (mapped to ICD-11), and an optional `extension.broad-modelcard` naming the card, setting, and population; it answers one card per condition with its status, warnings, safeguards, open incidents, and an atlas link (CONTRACT.md §33). `plugin.html` has a "Send as CDS Hooks request" mode. Like every route it answers this machine only, with no CORS: it is a demonstration on synthetic data, not an EHR integration and not for clinical use.

## The Static Demo (GitHub Pages)

A read-only copy of the catalogue, the atlas, and the comparison that runs on any static file server, at any path, with no backend: for a GitHub Pages project site. It serves answers recorded from the demo store; nothing graded is computed in the browser.

```bash
npm run ontologies:fetch   # once, optional: the pinned MONDO, ICD-10-CM, and WHO mapping releases
npm run demo:build         # once: the demo store (about a minute)
npm run build:static       # record the snapshot (about 7 minutes), then build frontend/dist-static/
python3 -m http.server 4180 --directory frontend/dist-static   # try it: http://localhost:4180/
```

- **What it holds:** the 13 demo cards at the demo store's dataset version, the default prevalence, and a band naming the release, the dataset version, and the recording date. In **ICD-11**: all patients and each population group alone (each age group, each sex, each ethnicity) for the rings, Summary, and comparison; condition cards (with study quality, effects on outcomes, and safety incidents), Across groups for every condition, multimorbidity, and search for all patients. In **MONDO** and **ICD-10-CM**: rings, Summary, condition cards with their ICD-11 mapping, comparison, and search, for all patients only. Choosing a group on one population axis resets the others to "All"; in another classification the population choice is fixed to all patients and says so.
- **Since release 0.5** it also holds the group summary per card, the safety incidents and each card's change history (the Regulator summary), the weighted shares (Procurement's population fit), each card's record (JSON and JSON-LD), the synonyms for search and the plain-language interpreter, and the care settings each card stores, at all patients in ICD-11 (rings, Summary, condition cards, Across groups). A setting fixes the population to all patients; a setting a card does not store is disabled and marked "not in the static demo"; the comparison and multimorbidity stay at Any setting.
- **Size** (measured 2026-10-22, all three classifications): 714.3 MB in 9,013 files, 41.3 MB gzipped (GitHub Pages serves gzip; its limit is 1 GB, and `npm run build:static` fails above it). A reader downloads only what they open.
- **What it leaves out:** the Data Library, the live interaction page and panel, the CDS Hooks service, the evaluation import and the helper, exports, local populations, staged previews, combined population groups, condition details and multimorbidity at a group, settings combined with a group or another classification, the comparison at a setting, the whole version feed, and Across groups for chapters, subchapters, deeper categories, and other classifications. Each says "Not in the static demo" in words where a reader would reach it; navigation links to the left-out pages are hidden.
- **Classifications and licences.** ICD-10-CM is public domain and MONDO is CC BY 4.0; both are projected onto ICD-11 through WHO's ICD-10 → ICD-11 mapping tables (CC BY-ND 3.0 IGO), used unmodified at import and attributed in `THIRD_PARTY_NOTICES.md`. The public demo shows all three. `npm run build:static -- --ontologies icd11,mondo`, or `BMC_STATIC_ONTOLOGIES` (in the Pages workflow: the repository variable of that name), records fewer.
- **How it works:** `scripts/static/record.mjs` starts the backend on a private copy of the demo store, calls the contract's read operations, and writes the answers under request-derived names (`frontend/src/api/staticPaths.js`; other classifications under `ontologies/<id>/`). Condition cards are bundled per chapter with each distinct row stored once, Across groups per chapter. The comparison of 2 to 4 cards cannot be recorded for every card set, so each card's facts and cells are recorded per lens and classification, and `frontend/src/api/staticComparison.js`, a port of `backend/app/services/comparison.py`, applies the rule (CONTRACT.md §25). The recorder compares every rebuilt answer with the API (every condition card, every Across groups answer, every recorded pair of cards, a sample of 3- and 4-card sets, the study and effect filters, and the search for fixed queries) and fails on any difference. `vite build --mode static` builds `index.html`, `atlas.html`, and `compare.html` with `frontend/src/api/staticAdapter.js` instead of `apiAdapter.js`, and copies the snapshot to `dist-static/static-data/`. The normal `npm run build` contains none of this.
- **Deployment:** `.github/workflows/pages.yml` downloads the pinned ontology releases (checksums verified), builds the demo store, records, builds, and deploys to GitHub Pages on every push to `main` and on demand. Set it up once in the repository settings (Pages → Source: GitHub Actions). Nothing of the snapshot is committed (`frontend/static-data/` and `frontend/dist-static/` are gitignored).

## Releasing

For a release (the version in `package.json`): tag it on `main` and push `main` and the tag. The Pages workflow then deploys the read-only demo.

## Security Model: Local Only

The app runs on one maintainer's computer. The backend has **no authentication**, so it must never be reachable from a network:

- `python -m app.serve` (which `npm run dev`, `npm run preview`, `npm run api`, and `npm run demo` use) binds 127.0.0.1 only, has no host option, and logs a "LOCAL ONLY, NO AUTHENTICATION" warning at startup.
- An in-app guard answers 403 to any client that is not loopback, to a `Host` header other than `localhost`, `127.0.0.1`, or `[::1]` (DNS rebinding), to an `Origin` that is not the app's own (another site, or another page on localhost), and to a cross-site state-changing request, so a web page open in the same browser cannot read admin settings, publish, or restore. The dev and preview servers send no CORS headers (`backend/CONTRACT.md` §16).
- There are no user accounts. Workspaces are a choice, not access control: a publish records the chosen role and whatever name was typed. Hosting the tool anywhere else needs authentication first.
- The backend's only outbound requests are the study helper's, to the provider the maintainer configured, and only on Propose.

## Runtime Data

The backend's SQLite store (`backend/data/broad_modelcard.sqlite`, not in git; `BMC_DB` selects another) is the source of truth at runtime. It starts as the seed import (version 1); every publish or restore adds a version, and staged uploads live next to it in `backend/data/uploads/` (`<store name>-uploads/` for other stores). The frontend never reads data files: it reaches data only through `frontend/src/api/dataClient.js`, which calls the API under `/api/v1` (a test enforces this boundary).

## Testing

```bash
npm test                                   # everything: frontend, then backend (several minutes)
npm run test:frontend                      # node --test: all frontend tests
node --test tests/catalogue.test.js        # one frontend test file
npm run test:backend                       # pytest: parity, API, contract drift, budgets, workflow
npm run test:backend -- -m "not slow"      # skip the latency and full-store gate tests
npm run build && npm run validate-seed     # build and seed validation
```

- Some frontend tests start a real backend on the store (`backend/data/broad_modelcard.sqlite`, or `BMC_DB`); tests that publish work on a private copy. The backend suite imports the full seed into a temporary store.
- The parity tests compare the backend with the pre-refactor reference client (tag `v0.2.0-alpha.1`), which is not part of the public repository; without it they skip.
- Set `BMC_DB` to a scratch store (for example one built with `npm run demo:build -- --db <file>`) to keep test runs away from your own data.

## Project Structure

```text
frontend/
  index.html                   catalogue
  atlas.html                   the atlas of one card
  compare.html                 2–4 cards side by side
  admin.html                   Data Library
  plugin.html, embed-test.html live interaction demo and plain embed test page
  vite.config.js, apiProxy.js  the /api proxy to the backend (dev and preview); build inputs,
                               incl. the static build (--mode static → dist-static/)
  src/
    api/            data client boundary (dataClient.js), API adapter (apiAdapter.js),
                    static adapter for the GitHub Pages build (staticAdapter.js, staticPaths.js,
                    staticRebuild.js, staticSearch.js, staticComparison.js, staticInterpret.js),
                    query cache and hooks
    app/            atlas shell, URL state, lens selection, profile defaults, version watch
    features/       catalogue, label (the model card and the card snapshot), profile,
                    atlas (+ layout), toolbar, summary, details (+ copy), search,
                    navigation, multimorbidity, preview, plugin, admin
    embed/          <bmc-live-panel>, the embeddable panel
    design/         status and absence marks, status vocabulary, range chart, brand mark,
                    chapter icons (Healthicons), controls
    shared/         version watch, local population, care setting, AI system names, formatting
    styles/         tokens and stylesheets, one entry stylesheet per page
backend/
  openapi.json, CONTRACT.md   API contract v1.14
  app/              FastAPI app, store and migrations, derivations, safety incidents, lookup,
                    catalogue, populations, studies, ontologies/ (ICD-10-CM, MONDO, crosswalk),
                    comparison, subgroups, effects, workspaces and submissions, release bundles,
                    care settings, synonyms and the plain-language interpreter, card records,
                    evaluation imports, the CDS Hooks service, seed import and validation,
                    publishing, assist/ (study helper), demo/
  seed/             the official seed: synthetic JSON tables imported as version 1
  demo/             the demo pack (versioned CSV files and manifest)
  assist_eval/      the study helper's fixed synthetic study set
  tests/            parity, API, drift, budget, and update-workflow tests
scripts/            dev runner (dev.mjs, backendServer.mjs), demo.mjs, validate-seed.mjs,
                    backend test runner, static/ (record.mjs, build.mjs: the static demo),
                    ontologies/ (fetch, import)
docs/               intervention-effects.md (the concept behind effect records),
                    evaluation-results.md and its example (the evaluation import format)
.github/workflows/  pages.yml: builds and deploys the static demo to GitHub Pages
tests/              frontend tests: API adapter, end-to-end against the backend, boundary,
                    contract, catalogue, label, profile, safety, panel, helper, populations,
                    layout, wording, presentation
```
