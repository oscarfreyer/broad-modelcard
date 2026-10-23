"""Field-level accuracy of the helper on the fixed synthetic study set.

    python -m app.assist.evaluate --db <store> --provider fake
    python -m app.assist.evaluate --db <store> --provider hosted   # uses the store's helper configuration
    python -m app.assist.evaluate --db <store> --provider local --json

Runs every excerpt of ``backend/assist_eval`` through the same pipeline as
``proposeRecords`` (provider, code resolution, checks against the store) and
compares the proposals with the expected records:

* **field accuracy**: expected fields (only those the excerpt states) whose
  proposed value is right, over all expected fields; a record that was not
  proposed counts all its fields wrong;
* **record recall and precision**: expected records found, proposed records
  that were expected;
* **drops**: expected dropped items (unknown code, unknown card) reported;
* **uncertainty flags**: fields the set marks as ambiguous that the proposal
  flags uncertain;
* **codes in the store** and **sourced fields** (study fields with a quote).

The store must hold the demo pack (``npm run demo:build``), whose cards the
excerpts name. A hosted or local run sends the seven synthetic excerpts to the
configured provider. Nothing is written to the store.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

from .. import db
from ..schema.templates import normalize_header
from ..services.dataset import Dataset
from ..services.search import SearchIndex
from . import config as configuration
from .proposals import DatasetView
from .providers import Provider, provider_for
from .service import AssistError, propose_with
from .studyset import Case, fake_provider, load_cases


def _same(expected, proposed) -> bool:
    if expected is None or proposed is None:
        return expected is None and (proposed is None or proposed == "")
    if isinstance(expected, (int, float)) and not isinstance(expected, bool):
        return isinstance(proposed, (int, float)) and not isinstance(proposed, bool) and abs(float(expected) - float(proposed)) <= 1e-6
    return normalize_header(expected) == normalize_header(proposed)


def flatten(proposals: dict) -> list[dict]:
    """Proposed records with their card, and their per-field details."""
    flat = []
    for batch in proposals["batches"]:
        for item in batch["records"]:
            values = dict(item["record"])
            if batch["model_version"] is not None:
                values.setdefault("model_version", batch["model_version"])
                values.setdefault("use_case", batch["use_case"])
            flat.append({"values": values, "fields": item["fields"]})
    return flat


def _key(kind: str, values: dict) -> tuple:
    code = values.get("code") if kind == "metrics" else values.get("codes")
    return (values.get("model_version"), values.get("use_case"), normalize_header(code))


@dataclass
class CaseScore:
    id: str
    kind: str
    fields_total: int = 0
    fields_correct: int = 0
    expected_records: int = 0
    proposed_records: int = 0
    matched_records: int = 0
    drops_expected: int = 0
    drops_found: int = 0
    flags_expected: int = 0
    flags_found: int = 0
    codes_proposed: int = 0
    codes_in_store: int = 0
    study_fields: int = 0
    sourced_fields: int = 0
    wrong: list[str] = field(default_factory=list)
    error: str | None = None


def score(case: Case, proposals: dict, view: DatasetView) -> CaseScore:
    result = CaseScore(case.id, case.kind)
    proposed = flatten(proposals)
    expected = case.expected["records"]
    result.expected_records, result.proposed_records = len(expected), len(proposed)
    free = list(range(len(proposed)))
    for want in expected:
        result.fields_total += len(want)
        candidates = [index for index in free if _key(case.kind, proposed[index]["values"]) == _key(case.kind, want)]
        if not candidates:
            result.wrong.append(f"{case.id}: no proposal for {_key(case.kind, want)}")
            continue
        best = max(candidates, key=lambda index: sum(_same(v, proposed[index]["values"].get(k)) for k, v in want.items()))
        free.remove(best)
        result.matched_records += 1
        got = proposed[best]
        for name, value in want.items():
            if _same(value, got["values"].get(name)):
                result.fields_correct += 1
            else:
                result.wrong.append(f"{case.id} {_key(case.kind, want)[2]} {name}: expected {value!r}, got {got['values'].get(name)!r}")
        for name in case.expected.get("uncertain", []):
            result.flags_expected += 1
            flagged = got["fields"].get(name, {}).get("uncertain")
            # A lens field the model flagged keeps its flag on the record even when the value is wrong.
            result.flags_found += bool(flagged)
    reasons = [item["reason"] for item in proposals["dropped"]]
    for reason in case.expected.get("dropped", []):
        result.drops_expected += 1
        if reason in reasons:
            reasons.remove(reason)
            result.drops_found += 1
    for item in proposed:
        values = item["values"]
        codes = [values.get("code")] if case.kind == "metrics" else str(values.get("codes") or "").split(";")
        for code in (c.strip() for c in codes if c and c.strip()):
            result.codes_proposed += 1
            result.codes_in_store += code.startswith("chapter ") or view.concept(code) is not None
        for detail in item["fields"].values():
            if detail["origin"] == "study":
                result.study_fields += 1
                result.sourced_fields += bool(detail["source"] and detail["source"].get("quote"))
    return result


def _share(part: int, whole: int) -> str:
    return f"{100 * part / whole:.1f}% ({part}/{whole})" if whole else "n/a"


def summarize(scores: list[CaseScore]) -> dict:
    def total(name: str) -> int:
        return sum(getattr(item, name) for item in scores)

    return {
        "cases": len(scores),
        "errors": sum(item.error is not None for item in scores),
        "field_accuracy": total("fields_correct") / total("fields_total") if total("fields_total") else None,
        "fields_correct": total("fields_correct"),
        "fields_total": total("fields_total"),
        "record_recall": total("matched_records") / total("expected_records") if total("expected_records") else None,
        "record_precision": total("matched_records") / total("proposed_records") if total("proposed_records") else None,
        "drops_found": total("drops_found"),
        "drops_expected": total("drops_expected"),
        "flags_found": total("flags_found"),
        "flags_expected": total("flags_expected"),
        "codes_in_store": total("codes_in_store"),
        "codes_proposed": total("codes_proposed"),
        "sourced_fields": total("sourced_fields"),
        "study_fields": total("study_fields"),
    }


def evaluate(view: DatasetView, provider: Provider, cases: list[Case], *, provider_kind: str, secrets: tuple[str, ...] = ()) -> tuple[list[CaseScore], dict]:
    scores = []
    for case in cases:
        try:
            proposals = propose_with(provider, view, kind=case.kind, study=case.study(), card=case.card, provider_kind=provider_kind, secrets=secrets)
        except AssistError as error:
            failed = CaseScore(case.id, case.kind, error=f"{error.code}: {error.detail}")
            failed.expected_records = len(case.expected["records"])
            failed.fields_total = sum(len(record) for record in case.expected["records"])
            failed.drops_expected = len(case.expected.get("dropped", []))
            scores.append(failed)
            continue
        scores.append(score(case, proposals, view))
    return scores, summarize(scores)


def report(scores: list[CaseScore], summary: dict, *, provider: str, model: str) -> str:
    lines = [
        f"Assisted data entry evaluation: provider {provider}, model {model}, {summary['cases']} synthetic excerpts",
        "",
        f"{'case':<5} {'kind':<8} {'fields':>9} {'records':>9} {'drops':>6} {'flags':>6}",
    ]
    for item in scores:
        if item.error:
            lines.append(f"{item.id:<5} {item.kind:<8} failed: {item.error}")
            continue
        lines.append(
            f"{item.id:<5} {item.kind:<8} {item.fields_correct:>4}/{item.fields_total:<4} {item.matched_records:>4}/{item.expected_records:<4}"
            f" {item.drops_found:>2}/{item.drops_expected:<3} {item.flags_found:>2}/{item.flags_expected:<3}"
        )
    lines += [
        "",
        f"Field accuracy:      {_share(summary['fields_correct'], summary['fields_total'])}",
        f"Record recall:       {_share(sum(s.matched_records for s in scores), sum(s.expected_records for s in scores))}",
        f"Record precision:    {_share(sum(s.matched_records for s in scores), sum(s.proposed_records for s in scores))}",
        f"Expected drops:      {_share(summary['drops_found'], summary['drops_expected'])}",
        f"Uncertainty flags:   {_share(summary['flags_found'], summary['flags_expected'])}",
        f"Codes in the store:  {_share(summary['codes_in_store'], summary['codes_proposed'])}",
        f"Sourced study fields:{_share(summary['sourced_fields'], summary['study_fields']):>1}",
    ]
    wrong = [line for item in scores for line in item.wrong]
    if wrong:
        lines += ["", "Differences:", *(f"  {line}" for line in wrong)]
    lines += ["", "All excerpts and numbers are synthetic demonstration data."]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.assist.evaluate", description=__doc__.split("\n\n")[0])
    parser.add_argument("--db", default=os.environ.get("BMC_DB"), help="The store (default: $BMC_DB). It must hold the demo pack.")
    parser.add_argument("--provider", choices=("fake", "hosted", "local"), default="fake")
    parser.add_argument("--config", type=Path, help="The helper configuration (default: the one next to the store).")
    parser.add_argument("--cases", help="Comma-separated case ids (default: all).")
    parser.add_argument("--json", action="store_true", help="Print the result as JSON.")
    args = parser.parse_args(argv)
    if not args.db:
        parser.error("give --db or set BMC_DB (a store with the demo pack)")
    cases = load_cases()
    if args.cases:
        wanted = {item.strip() for item in args.cases.split(",")}
        cases = [case for case in cases if case.id in wanted]
    secrets: tuple[str, ...] = ()
    if args.provider == "fake":
        provider: Provider = fake_provider()
        model = provider.model
    else:
        path = args.config or configuration.config_path(args.db)
        current = configuration.load(path)
        if current is None or current.provider != args.provider:
            print(f"No {args.provider} helper configuration at {path}. Configure it in the Data Library or with PUT /api/v1/admin/assist.", file=sys.stderr)
            return 2
        provider, model, secrets = provider_for(current), current.model, current.secrets
    conn = db.connect(args.db, read_only=True)
    try:
        dataset = Dataset(conn)
        view = DatasetView(dataset, SearchIndex(dataset.atlas))
        scores, summary = evaluate(view, provider, cases, provider_kind=args.provider, secrets=secrets)
    finally:
        conn.close()
    if args.json:
        print(json.dumps({"provider": args.provider, "model": model, "summary": summary,
                          "cases": [{**vars(item)} for item in scores]}, indent=1))
    else:
        print(report(scores, summary, provider=args.provider, model=model))
    return 0 if summary["errors"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
