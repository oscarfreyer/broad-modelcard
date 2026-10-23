# Intervention effects in Broad Modelcard

Concept for intervention effects (contract v1.13, `backend/CONTRACT.md` §27). All effect records in this prototype are synthetic demonstration data with fictional studies and numbers.

## 1. Two kinds of evidence

Broad Modelcard grades **predictive performance**: how well an AI system's output agrees with a reference standard for a condition and population (for example sensitivity, accuracy, or agreement), with a confidence interval, the evidence behind it, and whether the condition is in the intended use. That answers "is the output right?".

An **intervention effect** answers a different question: "does using the AI system change what happens to patients or to care, compared with care without it?". An accurate system can leave outcomes unchanged (nobody acts on it, or the decision was easy anyway), and a modest one can help when it reaches the right person at the right time. The two are measured by different studies, with different designs and different risks of bias, so the prototype keeps them apart: in the data, on the condition card, and in the grades.

## 2. What an effect record holds

One record per effect, in the data set **Effects on outcomes** (kind `effects`), keyed by an Effect ID:

| Field | Meaning |
|---|---|
| Study | A record of the Studies data set (§22). Its design must be a randomized trial, a prospective study, or a real-world deployment: a study that compared care with and without the system. Vignettes, simulations, benchmarks, and retrospective accuracy studies cannot show an effect on outcomes and are refused. |
| Card | The AI system and function that was used (model version and function). |
| Conditions | ICD-11 codes (a subcategory counts for its top-level condition) or one whole chapter, as for safety incidents (§18). |
| Outcome, outcome type | What was measured, and whether it is a **benefit** for patients, a **harm**, or a **process** measure (for example a waiting time). |
| Population | Who was studied, in words (the study's population, not a demographic lens). |
| Comparator | What care with the system was compared with, for example "usual care without the AI system". |
| Effect measure | Risk ratio, odds ratio, hazard ratio (ratios; no effect is 1), or risk difference, mean difference, standardized mean difference (differences; no effect is 0). |
| Estimate, 95% CI | The effect of the AI system against the comparator. Ratios are above 0; the estimate lies inside its interval. |
| Unit | Optional, for differences ("minutes", "percentage points"). Added beyond the field list of D13 so that a mean difference can be read. |
| Direction of benefit | Whether a higher or a lower value favours the system. |
| Follow-up | How long outcomes were followed (optional). |
| Appraisal tool, judgement | The design-specific risk-of-bias appraisal (section 3) and its overall judgement. |
| Notes | Optional, for example per-domain judgements. |

## 3. Design-specific appraisal

Risk of bias is judged with the tool made for the design, not with the predictive-model tool used for accuracy studies (PROBAST+AI, §22):

- **Randomized trials: RoB 2** (Cochrane risk-of-bias tool for randomized trials), with the judgements low, some concerns, and high.
- **Non-randomized studies of interventions** (prospective cohorts, before-and-after studies, real-world deployments): **ROBINS-I**, with the judgements low, moderate, serious, and critical. The prototype stores one shared scale: low, some concerns, high, critical (ROBINS-I only), and unclear; a ROBINS-I moderate is entered as some concerns and serious as high, and the notes can keep the tool's own words.

The upload check enforces the pairing: a randomized trial is appraised with RoB 2, any other allowed design with ROBINS-I, and Critical only with ROBINS-I.

Reporting guidelines are recorded on the study record (§22): **CONSORT-AI** (and **SPIRIT-AI** for the trial protocol) for randomized trials of AI interventions, and **DECIDE-AI** for early-stage clinical evaluation of AI decision support. The prototype stores CONSORT-AI and DECIDE-AI as guideline choices; SPIRIT-AI applies to protocols, which the prototype does not hold.

## 4. How effects are shown

On the condition card, after "Study quality", a section **Effects on outcomes** appears only when the card has effects for the condition (or, for a chapter or subchapter, for any of its conditions; in ICD-10-CM or MONDO, for the ICD-11 conditions a concept maps to). Each effect shows:

- the outcome, its type, and one plain sentence against the comparator: better with the AI system, worse, or no clear difference (the interval includes no effect), with the amount where it reads plainly ("about 14 minutes less", "about 18% higher risk");
- a small effect plot: no effect in the middle, the interval as a line with caps and the estimate as a square (the forest-plot convention), a log scale for ratios so that 0.5 and 2 sit equally far from 1, and the better side shaded and named. It deliberately has no Strong, Moderate, or Weak zones and no status colour, so it cannot be read as a predictive result;
- the design and the risk-of-bias judgement, and the study;
- at expert depth, the measure with its interval, the direction, population, follow-up, appraisal, study details, and notes;
- the fixed line: "Not part of any grade. Grades on this card cover predictive performance only."

The Summary panel says once that grades cover predictive performance only. The Data Library lists the data set next to Studies, with a template, file uploads, a one-effect form, and history and restore like every data set.

## 5. Why effects enter no grade

Effects change no grade, status, Overview mark, comparison flag, summary, or catalogue tile in this prototype (tested). Turning effects into a grade needs decisions that have not been taken:

- **Outcome importance.** Which outcomes matter for which function and condition (mortality against waiting time against documentation time), and how benefits weigh against harms.
- **Certainty of the body of evidence.** A grade would rate the certainty of effects across studies, for example with **GRADE** (risk of bias, inconsistency, indirectness, imprecision, publication bias), rather than score one study at a time.
- **Effect thresholds.** What size of effect counts as important or trivial for each outcome (minimal important differences), so that "better with the AI system" becomes "meaningfully better".
- **Pooling.** How several studies of the same outcome combine (meta-analysis), which the prototype does not do for performance either.

Until then the grades of the demonstration describe predictive performance only, and every effect is shown as reported, beside them and never inside them.

## 6. In the demonstration

Demo pack v6 adds two fictional studies that compared care with and without a system (the randomized trial VANTREL-RCT-2026 for Vantrel Triage 2.1 and the prospective before-and-after study QUILL-PROS-2026 for Quillary Scribe 1.0) and three effects: time to first treatment (mean difference), under-triage of patients who needed immediate care (a harm, risk ratio, on the circulatory chapter), and clinician time on the discharge letter (mean difference). They are synthetic and say nothing about any real system.
