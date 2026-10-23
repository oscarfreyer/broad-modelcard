"""The fixed synthetic study set in ``backend/assist_eval/``.

``cases.json`` lists each excerpt with its data set kind and the records a
correct proposal contains (only the fields the excerpt states), plus the
dropped items it must report. ``fake_answers.json`` holds the canned model
answers of the fake provider, which the tests and the offline evaluation use.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .. import db
from .inputs import StudyInput, from_file, from_text
from .providers import FakeProvider

STUDY_SET_DIR = db.BACKEND_DIR / "assist_eval"


@dataclass(frozen=True)
class Case:
    id: str
    path: Path
    kind: str
    card: tuple[str, str] | None
    about: str
    expected: dict

    def content(self) -> bytes:
        return self.path.read_bytes()

    def study(self) -> StudyInput:
        return from_file(self.path.name, self.content())


def load_cases(directory: Path = STUDY_SET_DIR) -> list[Case]:
    manifest = json.loads((directory / "cases.json").read_text(encoding="utf-8"))
    return [
        Case(
            id=item["id"],
            path=directory / item["file"],
            kind=item["kind"],
            card=tuple(item["card"]) if item.get("card") else None,
            about=item.get("about", ""),
            expected=item["expected"],
        )
        for item in manifest["cases"]
    ]


def fake_answers(directory: Path = STUDY_SET_DIR) -> dict[str, dict]:
    """Canned answers keyed by the sha256 of each excerpt, as a file and as pasted text."""
    answers = json.loads((directory / "fake_answers.json").read_text(encoding="utf-8"))["answers"]
    keyed: dict[str, dict] = {}
    for case in load_cases(directory):
        answer = answers.get(case.id)
        if answer is None:
            continue
        keyed[case.study().sha256] = answer
        keyed[from_text(case.content().decode("utf-8")).sha256] = answer
    return keyed


def fake_provider(directory: Path = STUDY_SET_DIR, *, kind: str = "hosted") -> FakeProvider:
    return FakeProvider.for_study_set(fake_answers(directory), kind=kind)
