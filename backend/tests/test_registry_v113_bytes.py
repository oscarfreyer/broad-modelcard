"""Contract v1.14 is additive (CONTRACT.md §1, §28): a store without
the v1.14 registry and instance fields reads byte for byte as it did under v1.13.

The digests below were recorded with the v1.13 code (commit 702acdc) on the
demo pack built up to pack v7, the last pack without configuration records,
lineage, comparison groundwork, or data-protection declarations. The reads are
every read that serves registry or instance fields: /meta, /models, the
catalogue (default and a local population), the comparison's card facts, and
the lookup's card. Publication times differ per build, so they are blanked
before hashing; nothing else is. Synthetic data only.

Phase Q4 (contract v1.14, CONTRACT.md §25) publishes three more comparison
reason codes in ``/meta.comparison.reasons`` and adds two card facts that every
card has (``narrow_model_card``, ``conductors``, derived from v1.13 data). Those
two reads are hashed with exactly these additions taken out and re-encoded the
way the API encodes (``app.api.responses.encode``), so the test still proves
every other byte unchanged; the Q4 additions are tested in test_comparison_q4.py.

Phase Q3 (contract v1.14, CONTRACT.md §29) lists the five specific care settings in
``/meta.axes.context`` after ``Clinical``; ``/meta`` is hashed with them taken out the
same way (the settings are tested in test_care_settings.py).
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
from pathlib import Path

import pytest
from conftest import copy_store, local_client

from app.api.responses import encode
from app.demo.builder import PACK_DIR, build, default_uploads_dir
from app.main import API_PREFIX, create_app
from app.schema.contract import ANY_SETTING, CONTEXTS
from app.services.comparison import REASONS

TIMESTAMP = re.compile(rb'"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?"')
LAST_V113_PACK = 7

SYN = "SynGPT-2.0|Clinician Facing CDSS"
VANTREL = "Vantrel-Triage-2.1|Emergency department triage"
QUILLARY = "Quillary-Scribe-1.0|Discharge letter generation"
LOOKUP_BODY = {
    "hook": "broad-modelcard-lookup",
    "context": {
        "card": {"model_version": "Vantrel-Triage-2.1", "use_case": "Emergency department triage"},
        "conditions": [{"system": "http://id.who.int/icd/release/11/mms", "code": "BA41"}],
    },
}

READS: list[tuple[str, str, dict]] = [
    ("GET", "/meta", {}),
    ("GET", "/models", {}),
    ("GET", "/catalogue", {}),
    ("GET", "/catalogue", {"population": "northbridge-region"}),
    ("GET", "/compare", {"cards": f"{SYN},{VANTREL},{QUILLARY}"}),
    ("POST", "/lookup", {}),
]

def key(method: str, path: str, params: dict) -> str:
    return f"{method} {path} {json.dumps(params, sort_keys=True)}"


# sha256 of each normalized body under contract v1.13 (commit 702acdc).
V113_DIGESTS: dict[str, str] = {
    key("GET", "/meta", {}): "294f2eda462faa0c030f2f62980e91427e10ce60c814b17540ee088e2652dfa2",
    key("GET", "/models", {}): "e4c30de4bd2a473eb96f07f6827df784d539fd13c03a67e41ef44aecb503b612",
    key("GET", "/catalogue", {}): "462257a55cefa01596aa473d0ce65e821911010324cb3fcc9c51aa6f672d972c",
    key("GET", "/catalogue", {"population": "northbridge-region"}): "b57719853d176b8f923e6c36e130a6d412d9fe2ef154a0bb4f1017fdbe139895",
    key("GET", "/compare", {"cards": f"{SYN},{VANTREL},{QUILLARY}"}): "66f1d709aac7950dee92f134e4904241949ec810a34753a1ae763eeea8fab2e9",
    key("POST", "/lookup", {}): "b99c6bc6ee790177dadf718fadcad3980d863e75d213de3fd5e5d0a3d6bd3613",
}


def pack_through(version: int, target: Path) -> Path:
    """A copy of the demo pack directory whose manifest stops at pack ``version``."""
    manifest = json.loads((PACK_DIR / "manifest.json").read_text(encoding="utf-8"))
    later = tuple(f"v{number}/" for number in range(version + 1, 100))

    def keep(entry: dict) -> bool:
        if "file" in entry or "evaluation" in entry:
            return not entry.get("file", entry.get("evaluation", "")).startswith(later)
        if "parts" in entry:
            return not any(part["file"].startswith(later) for part in entry["parts"])
        return True

    target.mkdir(parents=True)
    for child in PACK_DIR.iterdir():
        if child.is_dir() and re.fullmatch(r"v\d+", child.name) and int(child.name[1:]) <= version:
            shutil.copytree(child, target / child.name)
    manifest["files"] = [entry for entry in manifest["files"] if keep(entry)]
    manifest["version"] = version
    (target / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return target


@pytest.fixture(scope="module")
def v113_client(legacy_db, tmp_path_factory):
    root = tmp_path_factory.mktemp("v113")
    store = copy_store(legacy_db, root / "dashboard-demo.sqlite")
    build(store, pack_dir=pack_through(LAST_V113_PACK, root / "pack"), import_seed=False)
    with local_client(create_app(store, validate_responses=True, uploads_dir=default_uploads_dir(store))) as client:
        yield client


def digest(client, method: str, path: str, params: dict) -> str:
    if method == "POST":
        response = client.post(API_PREFIX + path, json=LOOKUP_BODY, params=params)
    else:
        response = client.get(API_PREFIX + path, params=params)
    assert response.status_code == 200, f"{path}: {response.text[:300]}"
    return hashlib.sha256(TIMESTAMP.sub(b'"*"', without_q4(path, response.content))).hexdigest()


# The comparison reasons and card facts phase Q4 adds to every /meta and /compare answer (see the module notes).
Q4_REASONS = frozenset({"measure_differs", "measure_unknown", "setting_differs"})
Q4_CARD_FACTS = ("narrow_model_card", "conductors")


def without_q4(path: str, content: bytes) -> bytes:
    if path not in ("/meta", "/compare"):
        return content
    body = json.loads(content)
    if path == "/meta":
        assert Q4_REASONS <= set(body["comparison"]["reasons"]) and body["comparison"]["reasons"] == list(REASONS)
        body["comparison"]["reasons"] = [code for code in body["comparison"]["reasons"] if code not in Q4_REASONS]
        assert body["axes"]["context"] == list(CONTEXTS)
        body["axes"]["context"] = [ANY_SETTING]
    else:
        for card in body["cards"]:
            for name in Q4_CARD_FACTS:
                card.pop(name)
    return encode(body)


def test_reads_without_v114_fields_are_v113_bytes(v113_client):
    found = {key(*read): digest(v113_client, *read) for read in READS}
    assert found == V113_DIGESTS
