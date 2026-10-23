"""Measure the check of one upload in a fresh process (000 rows, in < 30 s with progress).

Usage: python tests/measure_upload_check.py STORE FILE MODEL USE_CASE

Prints one JSON line: check time, progress values seen, peak memory of the
process (resident set size) before and after the check, and the result. The
store is used as given; pass a copy.
"""

from __future__ import annotations

import json
import resource
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.publishing.uploads import AdminService  # noqa: E402


def peak_rss_mb() -> float:
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return peak / 1e6 if sys.platform == "darwin" else peak / 1e3  # bytes on macOS, KiB on Linux


def main(store: str, file: str, model_version: str, use_case: str) -> None:
    work = Path(tempfile.mkdtemp(prefix="bmc-measure-"))
    admin = AdminService(store, uploads_dir=work / "uploads")
    admin.open()
    source = work / Path(file).name
    source.write_bytes(Path(file).read_bytes())
    baseline = peak_rss_mb()
    started = time.perf_counter()
    upload = admin.create_upload(
        kind="metrics", filename=source.name, source=source, model_version=model_version, use_case=use_case
    )
    progress: list[float] = []
    while True:
        current = admin.get_upload(upload["upload_id"])
        if current["status"] != "checking":
            break
        if not progress or current["progress"] != progress[-1]:
            progress.append(current["progress"])
        time.sleep(0.05)
    check_s = time.perf_counter() - started
    changes = admin.changes(upload["upload_id"]) if current["status"] == "valid" else None
    admin.close()
    print(
        json.dumps(
            {
                "status": current["status"],
                "row_count": current["report"]["row_count"],
                "errors": [group["code"] for group in current["report"]["errors"]],
                "check_s": round(check_s, 2),
                "progress": progress,
                "baseline_rss_mb": round(baseline, 1),
                "peak_rss_mb": round(peak_rss_mb(), 1),
                "rows": changes["rows"] if changes else None,
            }
        )
    )


if __name__ == "__main__":
    main(*sys.argv[1:5])
