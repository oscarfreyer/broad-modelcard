# Assisted data entry: the fixed synthetic study set

Synthetic demonstration data. Every study, report, number, and the condition
"Grevell syndrome" are fictional; the systems are the demo pack's fictional
cards, plus one fictional system that is deliberately not in the catalogue.
Nothing here is clinical evidence.

The set measures the LLM helper (contract v1.9, CONTRACT.md §20) with `python -m app.assist.evaluate` (backend/README.md,
"Assisted data entry"). It runs against a store with the demo pack
(`npm run demo:build`), whose cards and ICD-11 codes the excerpts name.

| Case | File | Data set | What it tests |
|---|---|---|---|
| E1 | `excerpts/e1-harrowgate-medicore.txt` | metrics | three records for one card, one at a specific age group |
| E2 | `excerpts/e2-quillary-audit.csv` | metrics | a CSV table for a product card, cited by row and column |
| E3 | `excerpts/e3-vantrel-incident.txt` | safety | one incident for a product at one age group |
| E4 | `excerpts/e4-ostwick-pilot.txt` | metrics | one valid record, one code the atlas lacks (dropped, never guessed) |
| E5 | `excerpts/e5-kestrel-review.txt` | metrics | vague wording: an approximate value and an unclear group must be flagged |
| E6 | `excerpts/e6-letter-incidents.txt` | safety | two incidents, one for a system that is not a card (dropped) |
| E7 | `excerpts/e7-fernbrook-letters.txt` | metrics | conditions named without codes, resolved by name in the store |

- `cases.json`: each case's file, data set, and the **expected** records: only
  the fields the excerpt states (fields a proposal keeps from the stored row
  are not scored), the dropped items it must report, and the fields it must
  flag as uncertain.
- `fake_answers.json`: the canned model answers of the fake provider, used by
  the tests and `--provider fake`. E5's answer picks the wrong group on
  purpose and flags it, so the fake run scores 193 of 194 fields.

Change the set together with its expectations; `tests/test_assist.py` checks
the fake run's numbers.
