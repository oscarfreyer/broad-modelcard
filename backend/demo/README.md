# Dashboard demo pack

A small, versioned set of update files that turns the seed into the data the
dashboard is demonstrated with. The files
are published **through the normal update workflow** (upload → check →
publish, the same code as the Data Library) into a separate demo store, after
the seed import. The seed (`backend/seed/`) and the live store
(`backend/data/broad_modelcard.sqlite`) are never touched.

All data is **synthetic demonstration data**. Every developer, product,
contact, and link is fictional (links use the reserved `.example` domain).
No real vendor or model family is named, nothing is clinical evidence, and no
declaration claims that anything is certified or approved.

## Commands

From the repository root:

```bash
npm run demo:build   # rebuild backend/data/dashboard-demo.sqlite (about 50 s)
npm run demo         # the app (backend + Vite dev server) on the demo store
```

- `npm run demo:build` imports the seed into
  `backend/data/dashboard-demo.sqlite` (rebuilt every time, so earlier demo
  publishes are discarded), then publishes every pack file in manifest order.
  It prints one line per published version. Any invalid file stops the build
  with its problems and fixes. Extra arguments are passed on, e.g.
  `npm run demo:build -- --db /tmp/demo.sqlite` builds elsewhere.
- `npm run demo` starts the app like `npm run dev`, but on the demo store. Its
  uploads go to `backend/data/dashboard-demo-uploads/`, never to the live
  store's `backend/data/uploads/`, and its backend listens on 127.0.0.1:8010
  (set `BMC_API_PORT` to change it), so it can run next to `npm run dev`.
- Both files are gitignored. The History page of the Data Library shows each
  pack publish with its change note ("Demo pack v3, <file>: <note>"; contract
  v1.7 stores it as the version's `note`, next to the summary of what changed).

The builder is `python -m app.demo build` (from `backend/`; options `--db`,
`--uploads-dir`, `--pack`, `--seed`, `--no-import`, `--quiet`). It refuses to
build into the live store or to use the live store's uploads folder, and to
rebuild a store that a running backend has open (a live
`backend/data/dev-api-<port>.json` marker naming the store, or an open SQLite
connection): stop `npm run demo` first.

## Contents (pack version 13)

`manifest.json` lists the files in order; each has its data set `kind`, its
`target` (model version and use case, for metrics and multimorbidity;
`population_id` and `population_name` for a local population, contract
v1.10), its
`mode` (`replace`, or `merge` for metrics, prevalence, safety, and, since
contract v1.13, studies and effects; contract v1.7), and a change `note` (with the pack and file name at most 500
characters). An entry may instead be **generated** from the store at build
time (pack v4): `{"generate": "evidence", "note", "source", "study",
"source_date"}`. Since pack v7 (contract v1.13, CONTRACT.md §26) a file may be
local results (`kind` `local_metrics`, `target` with `model_version`,
`use_case`, and `population_id`), a narrow model card (`kind` `model_cards`,
`target` `model_version`, `format` `json` or `markdown`), and an entry may be a
**developer submission**: `{"submission": {"developer_name", "model_version",
"note"}, "parts": [...]}`. Its parts are staged in the submission and never
published; they wait in the custodian's queue (Data Library, Custodian
review). Publishes record the role `hospital` for local results and for
entries marked `"role": "hospital"`, otherwise `maintainer`, and the name
"Demo pack".

| File | Data set | What it does |
|---|---|---|
| `v1/registry.csv` | AI systems & functions | Adds the contract v1.5 fields (kind, AI type, developer, release date, description, function category, developer declarations) to the 7 seed models and adds 3 fictional products built on them. Names, statuses, and defaults of the seed models are unchanged. |
| `v1/metrics/quillary-scribe-1-0.discharge-letter-generation.csv` | Performance metrics | Quillary Scribe 1.0 (product, documentation), built on MediCore-2.5. |
| `v1/metrics/vantrel-triage-2-1.emergency-department-triage.csv` | Performance metrics | Vantrel Triage 2.1 (product, triage, experimental), built on SynGPT-2.0. |
| `v1/metrics/corvessa-skin-review-1-2.skin-lesion-cdss.csv` | Performance metrics | Corvessa Skin Review 1.2 (product, image analysis), derived from SkinAI-1.0 and built on it in v1 (v4 clears Built on, since SkinAI-1.0 becomes a product). |
| `v2/safety/incidents.csv` | Safety incidents (replace) | 16 fictional incidents on 13 cards: 7 serious (open with harm occurred or possible, or an open recall), 7 caution (4 open without harm, 3 mitigated), and 2 closed; codes (one pair given as subcategories of pneumonia), two whole chapters (`chapter 06`, `chapter 11`), and incidents for one age group, one sex, or one ethnicity. Every summary starts with "Synthetic example". |
| `v2/metrics/syngpt-2-0.clinician-facing-cdss.northbridge-study.csv` | Performance metrics (merge) | The results of one fictional study (Northbridge multisite validation, `NBR-2026-01`, 2026-09-15) for type 2 diabetes, essential hypertension, and pneumonia, at the all-population lens and Age 65+: 5 rows with Source, Study, and Source date, and the study's counts (1 study, peer reviewed, 9 sites; the all-patients samples add up to its 6,595 patients). Every other row of the card stays as it was and keeps the seed's source. |
| `v4/registry.csv` | AI systems & functions (demo revision, contract v1.11) | The v1 registry with the new column **Intended use stated**: `No` for the broad language models SynGPT-1.0, SynGPT-2.0, and MediCore-2.5 (all their functions), `Yes` for ICU_GPT-1.0, radAIology-1, SkinAI-1.0, DoAIHaveCancer-1.0, and the three products. Since 2026-10-21 it also relabels the task-specific **radAIology-1, SkinAI-1.0, and DoAIHaveCancer-1.0 as products** (Kind Product, packaged for one clinical purpose; descriptions say "product"; Built on empty, since no model of the registry is their base), so Corvessa Skin Review 1.2 no longer lists SkinAI-1.0 under Built on (a product is built on models only). The demo then holds **4 models** (SynGPT-1.0, SynGPT-2.0, MediCore-2.5, ICU_GPT-1.0) and **6 products**. Nothing else changes. |
| generated `evidence` | Performance metrics, merge (demo revision, contract v1.11) | Every stored metrics row (and multimorbidity row) with a performance value and no evidence gets deterministic synthetic evidence (`app/demo/evidence.py`, a fixed seed: an internal test 50 %, a benchmark 40 %, a simulation study 10 %; 1–3 studies; one peer-reviewed study in about one row in five; 1–3 sites; the stored sample count). One merge upload per card, with the source "Demo revision (synthetic)", study `DEMO-REV-2026-10`, 2026-10-13, so every other row keeps its source. On the seed: 421,866 rows of 10 cards; the rows are made from the store when the pack is built, never committed. |
| `v5/studies/studies.csv` | Studies (contract v1.13) | Seven fictional study records: every design (vignette, simulation, benchmark, retrospective, prospective, real-world deployment, randomized trial), conducted by the developer, an independent group, or a hospital, each reporting guideline (none, TRIPOD+AI, STARD-AI, CONSORT-AI, DECIDE-AI, other) with Yes, Partly, or No, and every risk-of-bias level. `NBR-2026-01` (Northbridge multisite validation: TRIPOD+AI followed, low risk of bias) links the five rows of the pack v2 merge, whose Study column already names it (+0.05 to their evidence signal). Links use `https://studies.example/`. |
| `v5/metrics/icu-gpt-1-0.cdss.study-links.csv` | Performance metrics (merge) | 238 rows of ICU_GPT-1.0 / CDSS (8 conditions: sepsis, pneumonia, COPD, asthma, lung abscess, meningitis, hypertension; every group with evidence) get the source of `ICU-RETRO-2025` (developer, no guideline, high risk of bias: −0.10) and its validation type, Clinical study (single site) (pack v7 fix), and its counts (1 study, not peer reviewed, 1 site, at most 2,140 samples). Other values unchanged. |
| `v5/metrics/radaiology-1.radiology-image-analysis.study-links.csv` | Performance metrics (merge) | 630 rows of radAIology-1 (7 chest and head conditions) linked to `RAD-RCT-2026` (independent randomized trial, CONSORT-AI followed, low risk: +0.05), validation type Clinical study (multisite), and its counts (1 study, peer reviewed, 6 sites, at most 4,820 samples). |
| `v5/metrics/skinai-1-0.skin-lesion-cdss.study-links.csv` | Performance metrics (merge) | 450 rows of SkinAI-1.0 (5 skin conditions with evidence) linked to `DERM-VIG-2025` (developer vignette study, other guideline not followed, some concerns: −0.04), validation type Vignette study, and its counts (1 study, peer reviewed, 4 sites, at most 4,800 samples). Since 2026-10-21 the vignette study reads 4,800 image vignettes from 4 clinics and is peer reviewed (before: 600 vignettes, 1 site, not peer reviewed, which sent every linked row to grade E); its design, guideline answer, and risk of bias are unchanged, so the linked rows drop moderately: 75 C, 371 D, 4 E (before the link 106 A, 117 B, 138 C, 65 D, 24 E), 53 overall status changes (43 Strong → Moderate, 10 Moderate → Strong; with 600 vignettes 257). |
| `v6/studies/effect-studies.csv` | Studies (merge, contract v1.13) | Two more fictional studies that compared care with and without an AI system, so they can carry effects on outcomes: the independent randomized trial `VANTREL-RCT-2026` (Vantrel Triage 2.1, CONSORT-AI followed, low risk of bias) and the hospital's prospective before-and-after study `QUILL-PROS-2026` (Quillary Scribe 1.0, DECIDE-AI partly followed, some concerns). No metric row names them, so no grade changes. |
| `v6/effects/effects.csv` | Effects on outcomes (contract v1.13, CONTRACT.md §27) | Three fictional effects on product cards: time from arrival to first treatment (mean difference −14 minutes, 95 % CI −21 to −7; RoB 2 low) and under-triage of patients who needed immediate care (a harm; risk ratio 1.18, 0.94 to 1.48, on the whole circulatory chapter; RoB 2 some concerns) from `VANTREL-RCT-2026`, and clinician time on the discharge letter (mean difference −6.2 minutes, −8.1 to −4.3; ROBINS-I some concerns) from `QUILL-PROS-2026`. Effects are never graded: every grade, status, and summary stays as it was. |
| `v7/studies/northbridge-icu-evaluation.csv` | Studies (merge, contract v1.13 §26) | The hospital study `NBR-ICU-LOCAL-2026` (scope Hospital, local population `northbridge-region`): the fictional Northbridge General ICU evaluation of ICU_GPT-1.0 (retrospective, one site, TRIPOD+AI partly followed, some concerns). Published in the role Hospital administration. |
| `v7/local/icu-gpt-1-0.cdss.northbridge-region.csv` | Local results (contract v1.13 §26) | ICU_GPT-1.0 / CDSS for Northbridge region: 12 conditions inside the card's intended use for all patients and 3 of them for Age 65+, each naming `NBR-ICU-LOCAL-2026`. With the population chosen they replace the public results (11 overall status changes for its readers, for example toxic shock syndrome Strong → Weak); without it every answer is unchanged. |
| `v7/safety/northbridge-hospital-incident.csv` | Safety incidents (merge) | One hospital incident (`NBR-SI-2026-001`, scope Hospital): later septic shock alerts for older patients after a local software update. A public release import keeps it. |
| `v9/studies/study-fields.csv` | Studies (merge, contract v1.14 §22) | Every published study record again, unchanged, plus the optional v1.14 fields: applicability concerns (low: NBR-2026-01, RAD-RCT-2026, CORV-BENCH-2026, VANTREL-RCT-2026, NBR-ICU-LOCAL-2026; high: ICU-RETRO-2025, TRIAGE-SIM-2026; unclear: DERM-VIG-2025, NBR-DEPLOY-2026, QUILL-PROS-2026) with notes on some, the appraisal tool (APPRAISE-AI with scores 81 for RAD-RCT-2026 and 72 for VANTREL-RCT-2026; PROBAST+AI without a score for NBR-2026-01, ICU-RETRO-2025, NBR-ICU-LOCAL-2026; QUADAS-AI; Other), the setting category (emergency department, intensive care, inpatient ward, outpatient clinic, primary care, mixed), and the configuration evaluated (`cfg-2025-09`, `cfg-2026-01` … `cfg-2026-08`; DERM-VIG-2025 names none). Not graded: the version summary names no status change. Published before the submissions. Pack v8 is phase Q1's registry fields. |
| `v10/studies/setting-studies.csv` | Studies (merge, contract v1.14 §29) | Two fictional studies of SynGPT-2.0 in one care setting each: `SYN-ED-2026` (Harrowgate emergency department validation, prospective, 3 sites, independent, TRIPOD+AI followed, low risk; setting category emergency department) and `SYN-PC-2026` (Linmoor primary care record review, retrospective, 12 practices, developer, TRIPOD+AI not followed, some concerns; primary care). |
| `v10/metrics/*.csv` (four files) | Performance metrics (merge, contract v1.14 §29) | Results **at one care setting** (the Setting column), each row linked to a study of the same setting category: Vantrel Triage 2.1 in the emergency department (120 conditions × all patients, Age 65+, Age 18-39, female, male; `VANTREL-RCT-2026`, and 12 conditions from the earlier triage simulation `TRIAGE-SIM-2026`, so the demo shows results measured on an earlier configuration), ICU_GPT-1.0 in intensive care (80 × all patients, Age 65+, Age 40-64; `ICU-RETRO-2025`), and SynGPT-2.0 decision support in the emergency department (150 × all patients, Age 65+, female, male; `SYN-ED-2026`) and in primary care (200; `SYN-PC-2026`). Any setting is unchanged. Written by `tools/make_setting_metrics.py` (below). Published before the submissions. |
| `v11/safety/syngpt-2-0-cdss-incident-history.csv` | Safety incidents (merge, contract v1.14 §30) | Four more fictional incidents of SynGPT-2.0 decision support, so its Regulator summary shows incidents over several months (December 2025 to October 2026): two closed (`SI-2026-017`, a heart failure dose suggestion for an older patient with reduced kidney function; `SI-2026-018`, a developer notice after a search index update), one mitigated (`SI-2026-019`, stroke signs in women, Sex Female only), and one open (`SI-2026-020`, a cited value not in the record; serious, harm possible). The card then has 3 open (2 serious), 2 mitigated, and 2 closed incidents. Every summary starts with "Synthetic example". The instance profile (and its data-protection note) is not a pack data set, so pack v11 leaves it unset, and the registry is not changed: five cards already carry data-protection declarations (pack v8), the others none. |
| evaluation: `v12/evaluations/medicore-2-5.clinician-facing-cdss.harbourline-vignettes.json` | Evaluation results import (contract v1.14, CONTRACT.md §32.2) | An independent run of the fictional **Harbourline Clinical Vignette Benchmark 3.0** on MediCore-2.5 / Clinician Facing CDSS (its current configuration `cfg-medicore-cdss-2025-03`, run date 2026-10-18, setting mixed): top-3 diagnostic accuracy for 32 conditions at all patients and 4 of them at Age 65+, each with its interval, cases, and sites. The builder checks the file, takes its **proposed records**, and publishes them through the normal path: the benchmark study `EVAL-HARBOURLINE-CLINICAL-VIGNETTE-BENCHMARK-3-0-20261018` (studies merge; risk of bias unclear), then the metrics merge whose rows name it (36 rows); the checked file is then discarded. 5A11 and CA22 are left out on purpose: the study helper's evaluation (`assist_eval` E1) merges those rows with an older source date, which a newer benchmark row would keep out. Written by `tools/make_pack_v12.py` (deterministic). Published after the v8 registry (the import compares with the card's configuration) and before the submissions. |
| `v13/registry.csv` | AI systems & functions (contract v1.14, CONTRACT.md §11.1, §28) | Every line of `v8/registry.csv` unchanged (a registry upload replaces the whole list) plus two fictional products for the function categories added in v1.14: **Parlowe Answers 1.0** (Parlowe Health Communication; function "Patient question answering", category Patient communication; built on SynGPT-2.0; intended use stated) and **Tallyfern Coding 1.4** (Tallyfern Health Records; function "Clinical coding support", category Administrative; built on MediCore-2.5, with fixed coding rules; no intended-use statement, since coding covers every diagnosis of a stay). Each has a configuration record, a performance measure and reference standard ("Answer accuracy rated by clinicians"; "Agreement with coded discharge diagnoses"), and the developer's declarations with data protection. It waits for the products' metrics, like v8's. |
| `v13/studies/function-studies.csv` | Studies (merge, contract v1.14 §22) | One fictional study per product: `PARL-QA-2026` (Ashcombe patient question evaluation: independent, prospective, 3 practices and 3 outpatient clinics, 26,000 questions, peer reviewed, other guideline partly followed, some concerns; applicability unclear; APPRAISE-AI 68; setting category mixed) and `TALLY-CODE-2026` (Brennick inpatient coding audit: hospital, retrospective, 4 hospitals, 18,600 stays, peer reviewed, other guideline followed, low risk; applicability low; appraisal tool Other, without a score; mixed). Each names its product's current configuration. |
| `v13/metrics/*.csv` (two files) | Performance metrics (replace, contract v1.14 §29) | All-population results, every row with performance and the evidence of its product's study (1 study, the study's sites and peer review, samples within its patients): **Parlowe Answers 1.0** for 51 common conditions a patient asks about (diabetes, hypertension, asthma, COPD, migraine, depression, eczema, …; heart failure, chronic kidney disease, and alcohol use partly in scope; myocardial infarction, stroke, and sepsis out of scope, measured on whether the answer sent the patient to emergency services), plus 30 rows in Primary care and 16 in Outpatient clinic; **Tallyfern Coding 1.4** for 792 conditions from every chapter (about one in three, by a SHA-256 selector), plus 132 rows in Inpatient ward. Other conditions read No data. |
| `v13/safety/parlowe-answers-incident.csv` | Safety incidents (merge) | One fictional incident, `SI-2026-021`: a Parlowe answer about a reliever inhaler without warning signs (asthma; no harm; mitigated). |
| submission: `v7/submissions/tidewell-*` | Developer submission (waiting) | Tidewell Analytics (fictional) submits the new AI system Tidewell Sepsis 1.0 (function "Sepsis early warning"): its registry entry (a merge), metrics for 20 conditions, the prospective study `TIDE-VAL-2026`, and a narrow model card (JSON with a `model-index`; AUROC results for sepsis with ICD-11 codes, which the custodian can stage as proposed metric records). |
| submission: `v7/submissions/corvessa-*` | Developer submission (waiting) | Corvessa Diagnostics (fictional) submits the prospective study `CORV-PROSP-2026` and a metrics merge for 4 skin conditions of Corvessa Skin Review 1.2. |
| `v8/registry.csv` | AI systems & functions (contract v1.14, CONTRACT.md §28) | The pack v4 registry with the v1.14 columns, every other value unchanged (no grade changes). A fictional **configuration record** on 13 of 14 cards: the language-model cards (and the hybrid triage products) a configuration ID and date, a prompt summary with a SHA-256 (a digest of a fictional label, not of any prompt), retrieval, tools, and sampling; the imaging products fine-tuning; DoAIHaveCancer-1.0 none, so the absence can be seen. A **performance measure** and **reference standard** on every card. **Data-protection declarations** on 5 cards (SynGPT-2.0 decision support, radAIology-1, Quillary Scribe 1.0, Vantrel Triage 2.1, Corvessa Skin Review 1.2; contacts on `.example` domains). **Lineage:** SynGPT-2.0 replaces SynGPT-1.0, and the new fictional **Vantrel Triage 2.0** (the earlier release of Vantrel Triage, built on SynGPT-1.0) is replaced by Vantrel Triage 2.1. Every card's "Updated" moves to version 30 (each gained a measure). |
| `v8/metrics/vantrel-triage-2-0.emergency-department-triage.csv` | Performance metrics | Vantrel Triage 2.0 at the all-population lens for 255 emergency conditions (circulatory, respiratory, sepsis, injuries), lower than 2.1 by 0.035 plus a small fixed jitter, samples ×0.6, every row with its evidence; source `DEMO-VANTREL-2-0-2025`, 2025-06-30. Other conditions read No data. |
| `v3/populations/northbridge-region.csv` | Local populations (contract v1.10) | The fictional local population **Northbridge region (fictional)** (`northbridge-region`): synthetic commonness tiers for 310 top-level conditions, one tier more common for some endocrine, circulatory, and respiratory conditions (chapters 05, 11, 12) and one tier rarer for some infections and neoplasms (01, 02). Every row carries the source "Synthetic regional prevalence estimate (fictional)", study `NBR-POP-2026`, 2026-09-30. Reads with `population=northbridge-region` use it; default answers are unchanged. |

Fictional developers: Synthetica Health Labs (SynGPT-1.0, SynGPT-2.0), Meridel
Clinical AI (MediCore-2.5), Kelvane Critical Care Lab (ICU_GPT-1.0),
Tessellate Imaging (radAIology-1), Dermova Research (SkinAI-1.0), Open Mole
Collective (DoAIHaveCancer-1.0), Quillary Health Software, Vantrel Clinical
Systems (Vantrel Triage 2.0 and 2.1), Corvessa Imaging, Parlowe Health
Communication (Parlowe Answers 1.0), and Tallyfern Health Records (Tallyfern
Coding 1.4). Every declared
regulatory status reads "Not assessed (demonstration)".

**Order.** A registry upload is invalid while one of its use cases has no
metrics, and a metrics upload needs its target in the live registry or in a
staged registry upload (CONTRACT.md §11). So the builder stages
`registry.csv` first (it reports only `use_case_without_metrics`), publishes
the three metrics files, the safety incidents (the products' incidents are
accepted with the note `configuration_not_published`), the merge, and the
local population, lets the workflow check the staged registry again, and
publishes it before the next registry file. The demo store then has versions 1
(seed), 2–4 (product metrics), 5 (safety incidents), 6 (the one-study merge),
7 (the local population), 8 (registry), 9 (the revised registry, pack v4),
10–19 (the generated evidence, one version per card that had rows without
evidence), 20 (the study records, pack v5), 21–23 (the three study-link
merges), 24 (the two effect studies, pack v6), 25 (the effects), 26 (the
hospital study, pack v7), 27 (the local results), 28 (the hospital
incident), 29 (Vantrel Triage 2.0's metrics, pack v8; the v8 registry waits
for them), 30 (the study fields, pack v9), 31 (the two setting studies, pack
v10), 32–35 (the setting-specific results of Vantrel Triage 2.1, ICU_GPT-1.0,
and SynGPT-2.0 twice), 36 (the incident history of SynGPT-2.0 decision support,
pack v11), 37 (the v8 registry, published when the files are done, here
because the evaluation import of pack v12 needs it live; it changes every
card's registry signature, so every earlier tile reads "Updated" at 37, §17),
38 (pack v12's benchmark study) and 39 (its metrics merge for MediCore-2.5 /
Clinician Facing CDSS, whose tile reads "Updated" at 39), 40 (the two
function-category studies, pack v13; the v13 registry waits for its products'
metrics in turn), 41–42 (Parlowe Answers 1.0's and Tallyfern Coding 1.4's
metrics), 43 (Parlowe's incident), and 44 (the v13 registry, published before
the submissions; it adds two entries and changes no other card, so only the two
new tiles read 44), with two developer
submissions waiting. The instance stays a
public service. After the build no card has a row with performance and no
evidence (`tests/test_demo_pack.py`).

**Setting-specific results (pack v10).** `tools/make_setting_metrics.py`
writes the four files from a demo store built up to pack v9 or later (only
read): from each card's filled metrics template it takes conditions with an
all-patients Performance value and evidence in Any setting, a few named ones
first (sepsis, stroke, myocardial infarction, pneumonia, …) and then in turn
from the chosen ICD-11 chapters, and writes rows at the setting for all
patients and a few groups. Performance is the Any-setting value moved by a
fixed amount per card, setting, condition, and group (a hash, never random)
within the setting's range; the CI follows the samples; the evidence (validation
type from the design, 1 study, sites, peer review, samples a share of the
study's patients) is the study's; intended use and warnings are copied. Running
it twice gives byte-identical files.

**Study links (pack v5).** `tools/make_study_links.py` writes the three link
files from a demo store built up to pack v4 or later: it takes each card's filled
metrics template, keeps every row with evidence of the chosen conditions (at
every demographic group the card stores), copies the values, and sets Source,
Study, and Source date (2026-10-18, newer than the demo revision's 2026-10-13,
so the merge replaces those rows). Since pack v7 it also sets the **validation
type that matches the study's design** (before, ICU rows could read "Simulation
study" while their study is a retrospective cohort): retrospective,
prospective, real-world deployment, and randomized trial → Clinical study
(multisite) with more than one site, else (single site); benchmark →
Benchmark; vignette → Vignette study; simulation → Simulation study. The
evidence counts follow the study record as well, so the condition card's
evidence never contradicts the linked study: Studies 1, Peer-reviewed studies
1 or 0, Sites the study's sites, and Samples at most the study's patients (a
smaller count, for one condition or group, is kept). Running it twice gives
the same files:
`.venv/bin/python demo/tools/make_study_links.py --db <a demo store>`.
A built store already holds the capped counts, so after **raising** a study's
patients run it on a copy whose metrics are restored to version 22, before the
SkinAI-1.0 link (Data Library → History → Restore, or
`POST /admin/versions/22/rollback?kind=metrics` on the copy): that is how the
2026-10-21 SkinAI-1.0 file was written; the other two files came out
byte-identical.

**Pack v7.** `tools/make_pack_v7.py` writes the local results and the two
submissions' metrics files from a demo store built up to pack v5 or later
(fixed steps from the public values; validation types by the same mapping):
`.venv/bin/python demo/tools/make_pack_v7.py --db <a demo store>`. The study,
incident, registry, and model card files are written by hand.
The studies and their names are fictional and describe no real study.

**Pack v8.** `tools/make_pack_v8.py` writes `v8/registry.csv` from
`v4/registry.csv` (the v1.14 cells per card are listed in the tool) and Vantrel
Triage 2.0's metrics from Vantrel Triage 2.1's pack v1 file; it reads no store
and running it twice gives the same files:
`.venv/bin/python demo/tools/make_pack_v8.py`.

**Pack v13.** `tools/make_pack_v13.py` writes `v13/registry.csv` (every
line of `v8/registry.csv` as it is, then the two products), the two studies,
the two metrics files, and the incident; it reads no store and running it
twice gives the same files: `.venv/bin/python demo/tools/make_pack_v13.py`.
Performance starts from the built-on model's result in the pack's earlier
product files (Vantrel Triage 2.1's pack v1 rows come from SynGPT-2.0,
Quillary Scribe 1.0's from MediCore-2.5), moved by a fixed offset and a
SHA-256 jitter (a setting reads a little lower, mostly); the CI follows the
samples. A later registry change must start from `v13/registry.csv`, since a
registry upload replaces the whole list.

**Local population.** `tools/make_population.py` derives the Northbridge file
deterministically from the seed's default tiers (a SHA-256 selector per code;
running it twice gives the same file):
`.venv/bin/python demo/tools/make_population.py --db <a seed import>`. The tiers
say nothing about any real place.

**Product metrics.** Each product file holds the all-population lens only
(All ages, All sexes, All ethnicities) for the 2,400 top-level conditions.
A specific demographic group therefore reads **No data** on a product's card:
CONTRACT.md §7 falls back only from "All …" requests to specific groups, not
the other way round. The files are derived deterministically from the base
model's filled metrics template by `tools/make_product_metrics.py`
(demo pack only; the retired seed generators stay retired): performance and
confidence bounds move by a fixed offset per product plus a small fixed
per-condition jitter, samples are scaled, every row gets the fixed Source
"Demo pack product metrics (synthetic, derived from <base model>)", Study
`DEMO-PRODUCT-2026-09`, and Source date 2026-09-01 (without one a replace
upload dates its rows on the build day, so the Corvessa submission's merge,
dated 2026-10-17, would be kept out as an older study on any later build),
and everything else is copied,
except that a row with performance and no evidence gets the same synthetic
evidence as the generated step (pack v4; the products' 3, 168, and 688 such
rows). To reproduce them:

```bash
cd backend
.venv/bin/python demo/tools/make_product_metrics.py --db <a fresh seed import>
```

## Adding to the pack

Later steps add files. Add the CSV under a new `v<n>/` folder, append it to `files` in `manifest.json` with a
change note, raise `version`, and run `npm run demo:build`; the backend test
`tests/test_demo_pack.py` builds the pack and checks that every file
publishes. Use fictional names only.
