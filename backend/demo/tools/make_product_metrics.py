"""DEMO PACK ONLY: derive the fictional products' metrics files from their base models.

Not a data generator for the atlas: the seed generators stay retired
(Phase D), and nothing here writes to a store. This script only rebuilds the
committed CSV files under ``backend/demo/v1/metrics/`` so that they can be
reviewed and reproduced.

For each product configuration below it downloads the **filled metrics
template** of the base model's configuration (the same file the Data Library
offers), keeps the all-population lens rows (All ages, All sexes, All
ethnicities: 2,400 depth-1 conditions), and applies small fixed changes:

* Performance, CI low, and CI high move by the product's ``offset`` plus a
  deterministic per-condition jitter in [-0.01, +0.01] (from SHA-256 of the
  product and the ICD-11 code), are clamped to 0–1, rounded to 3 decimals,
  and kept in order (CI low ≤ Performance ≤ CI high).
* Samples are scaled by ``sample_factor`` (rounded, at least 24 as in
  CONTRACT.md §4.1 decoding).
* Every row gets a fixed Source, Study, and Source date (``PRODUCT_SOURCE``,
  2026-09-01). Without them a replace upload dates its rows on the day the
  demo is built, so a later merge with an earlier source date, such as the
  Corvessa submission of pack v7 (2026-10-17), would be kept out as an older
  study on any build after that date.
* Every other column (evidence, studies, validation type, intended use,
  warnings) is copied as it is, except that a row with a performance value
  and no evidence gets deterministic synthetic evidence (``app.demo.evidence``,
  demo pack v4): since contract v1.11 an upload rejects performance without
  evidence.

Other lenses are left out on purpose, to keep the pack small: the products
have data for the whole population only, and a specific demographic group reads
No data (CONTRACT.md §7 expands only "All …" axes, so an all-population file has
no rows for, say, "Age 65+"). The output is deterministic; running the script
twice gives byte-identical files.

Usage (from backend/, on a fresh seed import; the store is only read):

    .venv/bin/python demo/tools/make_product_metrics.py --db <seed store> [--out demo/v1/metrics]
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import shutil
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BACKEND_DIR))

from app.demo.evidence import needs_evidence, with_evidence  # noqa: E402
from app.publishing.uploads import AdminService  # noqa: E402
from app.schema.contract import AGE_ALL, ETHNICITY_ALL, METRIC_ROW_FORMAT, SEX_ALL  # noqa: E402
from app.schema.templates import VALIDATION_TYPE_LABELS  # noqa: E402

DEFAULT_OUT = BACKEND_DIR / "demo" / "v1" / "metrics"
MIN_SAMPLES = 24
# The fixed source of every product row (Source, Study, Source date): earlier than every later
# merge of the pack, so the outcome of a merge never depends on the day the demo is built.
PRODUCT_STUDY = "DEMO-PRODUCT-2026-09"
PRODUCT_SOURCE_DATE = "2026-09-01"
SOURCE_HEADERS = ["Source", "Study", "Source date"]


@dataclass(frozen=True)
class Product:
    model_version: str
    use_case: str
    base_model: str
    base_use_case: str
    offset: float
    sample_factor: float

    @property
    def filename(self) -> str:
        slug = lambda text: "".join(char if char.isalnum() else "-" for char in text.lower()).strip("-")  # noqa: E731
        return f"{slug(self.model_version)}.{slug(self.use_case)}.csv"


# The fictional products of demo pack v1 (backend/demo/v1/registry.csv).
PRODUCTS = (
    Product("Quillary-Scribe-1.0", "Discharge letter generation", "MediCore-2.5", "Discharge letter generation", 0.015, 0.55),
    Product("Vantrel-Triage-2.1", "Emergency department triage", "SynGPT-2.0", "Clinician Facing CDSS", -0.02, 0.40),
    Product("Corvessa-Skin-Review-1.2", "Skin lesion CDSS", "SkinAI-1.0", "Skin lesion CDSS", 0.01, 0.70),
)


def jitter(product: Product, code: str) -> float:
    digest = hashlib.sha256(f"{product.model_version}|{code}".encode()).digest()
    return (int.from_bytes(digest[:4], "big") / 0xFFFFFFFF - 0.5) * 0.02


def _number(text: str) -> float | None:
    return float(text) if text.strip() else None


def _unescaped(cell: str) -> str:
    return cell[1:] if cell[:1] == "'" and cell[1:2] in ("=", "+", "-", "@", "\t", "\r") else cell


def _clamp(value: float) -> float:
    return round(min(1.0, max(0.0, value)), 3)


def _format(value: float | None) -> str:
    return "" if value is None else repr(value)


def transform(product: Product, header: list[str], row: list[str]) -> list[str]:
    column = {name: index for index, name in enumerate(header)}
    out = list(row)
    shift = product.offset + jitter(product, row[column["ICD-11 code"]])
    perf, low, high = (_number(row[column[name]]) for name in ("Performance", "CI low", "CI high"))
    perf, low, high = (None if value is None else _clamp(value + shift) for value in (perf, low, high))
    if perf is not None:
        low = None if low is None else min(low, perf)
        high = None if high is None else max(high, perf)
    out[column["Performance"]], out[column["CI low"]], out[column["CI high"]] = _format(perf), _format(low), _format(high)
    samples = row[column["Samples"]].strip()
    if samples:
        out[column["Samples"]] = str(max(MIN_SAMPLES, round(int(samples) * product.sample_factor)))
    return add_evidence(product, header, out)


# Template header of each evidence field of METRIC_ROW_FORMAT.
_EVIDENCE_HEADERS = {
    "evidence_grade": "Evidence grade",
    "n_samples": "Samples",
    "n_sites": "Sites",
    "n_studies": "Studies",
    "peer_reviewed_studies": "Peer-reviewed studies",
}


def add_evidence(product: Product, header: list[str], row: list[str]) -> list[str]:
    """Synthetic evidence (demo pack v4) for a row with Performance and no evidence."""
    column = {name: index for index, name in enumerate(header)}
    warnings = tuple(code.strip() for code in row[column["Warnings"]].split(";") if code.strip())
    values = dict.fromkeys(METRIC_ROW_FORMAT)
    values.update(
        perf=_number(row[column["Performance"]]),
        validation_type=row[column["Validation type"]].strip() or None,
        n_samples=int(row[column["Samples"]]) if row[column["Samples"]].strip() else None,
        warnings=warnings,
    )
    stored = tuple(values[name] for name in METRIC_ROW_FORMAT)
    if not needs_evidence(stored):
        return row
    key = "|".join((product.model_version, product.use_case, *(row[column[name]] for name in ("ICD-11 code", "Age", "Sex", "Ethnicity"))))
    fixed = dict(zip(METRIC_ROW_FORMAT, with_evidence(stored, key)))
    out = list(row)
    for name, title in _EVIDENCE_HEADERS.items():
        out[column[title]] = "" if fixed[name] is None else str(fixed[name])
    out[column["Validation type"]] = VALIDATION_TYPE_LABELS[fixed["validation_type"]]
    out[column["Warnings"]] = "; ".join(fixed["warnings"])
    return out


def write_product(admin: AdminService, product: Product, out_dir: Path) -> Path:
    with tempfile.TemporaryDirectory(prefix="bmc-demo-tool-") as scratch:
        path, _ = admin.template(
            "metrics", "csv", Path(scratch), filled=True, model_version=product.base_model, use_case=product.base_use_case
        )
        with open(path, newline="", encoding="utf-8") as handle:
            lines = list(csv.reader(handle))
    body = [line for line in lines if line and not line[0].startswith("#")]
    # The pack files have no Action column; Source, Study, and Source date are
    # fixed (PRODUCT_SOURCE_DATE), never the day of the build (contract v1.7).
    # Condition names that start with "-" come escaped with an apostrophe
    # (CONTRACT.md §16); the pack keeps them as they were (uploads ignore it).
    width = body[0].index("Warnings") + 1
    header, rows = body[0][:width], [[_unescaped(cell) for cell in row[:width]] for row in body[1:]]
    column = {name: index for index, name in enumerate(header)}
    population = [
        row for row in rows
        if (row[column["Age"]], row[column["Sex"]], row[column["Ethnicity"]]) == (AGE_ALL, SEX_ALL, ETHNICITY_ALL)
    ]
    target = out_dir / product.filename
    with open(target, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow([
            f"# Broad Modelcard demo pack v1: Performance metrics of the fictional product {product.model_version} / {product.use_case}. "
            "Synthetic demonstration data. All-population lens only (specific groups have no data)."
        ])
        writer.writerow([
            f"# Derived by demo/tools/make_product_metrics.py from the filled template of {product.base_model} / {product.base_use_case} "
            f"(offset {product.offset:+.3f} and samples x{product.sample_factor:g}). Not clinical evidence."
        ])
        writer.writerow([*header, *SOURCE_HEADERS])
        source = [f"Demo pack product metrics (synthetic, derived from {product.base_model})", PRODUCT_STUDY, PRODUCT_SOURCE_DATE]
        writer.writerows([*transform(product, header, row), *source] for row in population)
    return target


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", type=Path, required=True, help="a store with the seed import (only read)")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output folder (default demo/v1/metrics)")
    args = parser.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="bmc-demo-tool-uploads-") as uploads:
        admin = AdminService(args.db, uploads_dir=Path(uploads))
        try:
            for product in PRODUCTS:
                print(write_product(admin, product, args.out))
        finally:
            admin.close()
            shutil.rmtree(uploads, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
