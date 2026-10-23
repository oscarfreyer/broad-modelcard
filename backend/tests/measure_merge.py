"""Measure the contract v1.7 update paths on a copy of a store.

Usage: python tests/measure_merge.py STORE

STORE is used as given; pass a copy (for example of the demo store). Prints one
JSON object with the timings (seconds) of:

* one safety incident entered as a records upload: check, change summary,
  staged concept read (preview), and publish, and the total (target: well
  under a minute);
* a one-study metrics merge (5 rows of the SynGPT-2.0 / Clinician Facing CDSS
  set): check, change summary, publish;
* the size of the atlas metric map (budget: under 2 MB).
"""

from __future__ import annotations

import json
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import API_PREFIX, create_app  # noqa: E402

CARD = {"model": "SynGPT-2.0", "use_case": "Clinician Facing CDSS"}
INCIDENT = {
    "incident_id": "SI-MEASURE-1", "model_version": CARD["model"], "use_case": CARD["use_case"], "codes": "CA40",
    "incident_type": "Harmful or incorrect recommendation", "harm": "Possible", "status": "Open",
    "source_type": "Incident report", "source_reference": "Fictional report (synthetic)",
    "reported_date": "2026-10-10", "summary": "Synthetic measurement incident.",
}
STUDY = {"source": "Fictional measurement study (synthetic)", "study": "MEAS-1", "source_date": "2026-10-11"}
ROW = {
    "age": "All ages", "sex": "All sexes", "ethnicity": "All ethnicities", "perf": 0.8, "ci_low": 0.77, "ci_high": 0.83,
    "evidence_grade": "B", "n_samples": 2500, "n_sites": 8, "n_studies": 7, "peer_reviewed_studies": 6,
    "validation_type": "Clinical study (multisite)", "in_intended_use": True, "intended_use_coverage": 1,
    "intended_use_level": "In scope", "warnings": "clinician_review_required", **STUDY,
}


def main(store: str) -> None:
    uploads = Path(tempfile.mkdtemp(prefix="bmc-measure-"))
    app = create_app(store, uploads_dir=uploads)
    admin_path = f"{API_PREFIX}/admin"
    result: dict = {}
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as client:
        admin = app.state.api.admin

        def timed(name: str, call):
            started = time.perf_counter()
            value = call()
            result[name] = round(time.perf_counter() - started, 3)
            return value

        def checked(response) -> dict:
            assert response.status_code == 202, response.text
            admin.wait_for_checks()
            upload = client.get(f"{admin_path}/uploads/{response.json()['upload_id']}").json()
            assert upload["status"] == "valid", upload["report"]
            return upload

        started = time.perf_counter()
        upload = timed("incident_check", lambda: checked(client.post(f"{admin_path}/uploads/records", json={"kind": "safety", "records": [INCIDENT]})))
        timed("incident_changes", lambda: client.get(f"{admin_path}/uploads/{upload['upload_id']}/changes").json())
        timed("incident_preview", lambda: client.get(f"{API_PREFIX}/metrics/concepts/CA40", params={**CARD, "version": f"staged:{upload['upload_id']}"}).json())
        timed("incident_publish", lambda: client.post(f"{admin_path}/uploads/{upload['upload_id']}/publish", json={"previewed": True, "note": "Measured."}).json())
        result["incident_total"] = round(time.perf_counter() - started, 3)

        rows = [{"code": code, **ROW} for code in ("5A11", "BA00", "CA40", "CA22", "BD10")]
        merge = timed(
            "merge_check",
            lambda: checked(client.post(f"{admin_path}/uploads/records", json={"kind": "metrics", "model_version": CARD["model"], "use_case": CARD["use_case"], "records": rows})),
        )
        changes = timed("merge_changes", lambda: client.get(f"{admin_path}/uploads/{merge['upload_id']}/changes").json())
        result["merge_rows"] = {name: changes["rows"][name] for name in ("added", "changed", "removed", "unchanged")}
        timed("merge_publish", lambda: client.post(f"{admin_path}/uploads/{merge['upload_id']}/publish", json={"previewed": False, "note": "Measured."}).json())

        body = client.get(f"{API_PREFIX}/metrics/map", params={**CARD, "scope": "atlas"}).content
        result["map_atlas_kb"] = round(len(body) / 1024, 1)
    print(json.dumps(result))


if __name__ == "__main__":
    main(*sys.argv[1:])
