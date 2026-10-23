"""Response-size and latency budgets on the full store (§8.2 A2).

Latency is the server time seen by an in-process client (FastAPI TestClient,
no network), measured warm: the store, atlas, and search index are loaded, but
every timed request uses parameters not requested before, so neither the
response cache nor the per-lens row cache can answer it. Set BMC_PERF_FACTOR
(default 1) to scale the targets on slower machines.
"""

from __future__ import annotations

import math
import os
import random
import time

import pytest
from conftest import local_client, record_budget

from app.main import API_PREFIX, create_app
from app.services.catalog import Catalog
from app.services.catalogue import DistributionCache, build_catalogue

MAX_BYTES = 2_000_000  # "no single API response > 2 MB" (exports excepted)
CATALOGUE_MAX_BYTES = 300_000
CATALOGUE_WARM_MS = 150  # a warm catalogue request
SAMPLES = 60
PERF_FACTOR = float(os.environ.get("BMC_PERF_FACTOR", "1"))
TARGETS_MS = {
    "metrics/map (atlas)": 120,
    "metrics/map (chapter)": 120,
    "metrics/concepts/{id}": 50,
    # Contract v1.13 (CONTRACT.md §24): twelve lenses of one concept in one read.
    "metrics/concepts/{id}/subgroups": 150,
    "search": 100,
    "metrics/summary": 150,
    "multimorbidity/candidates": 100,
    "multimorbidity/combination": 100,
}
VIEWS = ("overall", "performance", "evidence", "intended_use")


def percentile(values: list[float], p: float) -> float:
    ordered = sorted(values)
    return ordered[max(0, math.ceil(p * len(ordered)) - 1)]


@pytest.fixture(scope="module")
def variants(production_client) -> list[dict]:
    models = production_client.get(f"{API_PREFIX}/models").json()["models"]
    return [
        {"model": model["model_version"], "use_case": use_case["use_case"], "has_multimorbidity": use_case["has_multimorbidity"]}
        for model in models
        for use_case in model["use_cases"]
    ]


@pytest.fixture(scope="module")
def lenses(production_client) -> list[dict]:
    axes = production_client.get(f"{API_PREFIX}/meta").json()["axes"]
    return [{"age": a, "sex": s, "ethnicity": e} for a in axes["age"] for s in axes["sex"] for e in axes["ethnicity"]]


def scoped(variant: dict) -> dict:
    return {"model": variant["model"], "use_case": variant["use_case"]}


# ------------------------------------------------------------------- sizes

def test_responses_stay_under_2_mb(client, variants, lenses):
    largest: dict[str, tuple[int, str]] = {}

    def check(name: str, path: str, **params) -> None:
        response = client.get(API_PREFIX + path, params=params)
        assert response.status_code == 200, response.text[:200]
        size = len(response.content)
        assert size <= MAX_BYTES, f"{name} {params}: {size:,} bytes"
        if size > largest.get(name, (0, ""))[0]:
            largest[name] = (size, f"{path} {params}")

    chapters = [chapter["concept_id"] for chapter in client.get(f"{API_PREFIX}/meta").json()["chapters"]]
    check("meta", "/meta")
    check("models", "/models")
    check("catalogue", "/catalogue")
    assert largest["catalogue"][0] <= CATALOGUE_MAX_BYTES
    check("atlas/overview", "/atlas/overview")
    for chapter in chapters:
        check("atlas/chapters/{id}", f"/atlas/chapters/{chapter}")
    for variant in variants:
        check("metrics/map (atlas)", "/metrics/map", **scoped(variant), scope="atlas", **lenses[-1])
        check("metrics/summary", "/metrics/summary", **scoped(variant), view="intended_use")
        check("multimorbidity/candidates", "/multimorbidity/candidates", **scoped(variant), scope="atlas")
    for chapter in chapters:
        check("metrics/map (chapter)", "/metrics/map", **scoped(variants[0]), scope="chapter", chapter_id=chapter)
        check("multimorbidity/candidates", "/multimorbidity/candidates", model="SynGPT-2.0", use_case="Clinician Facing CDSS", scope="chapter", chapter_id=chapter, selected="5A11")
    check("metrics/concepts/{id}", "/metrics/concepts/CH-22", **scoped(variants[0]))
    check("metrics/concepts/{id}/subgroups", "/metrics/concepts/CH-22/subgroups", **scoped(variants[0]))
    check("multimorbidity/combination", "/multimorbidity/combination", model="SynGPT-2.0", use_case="Clinician Facing CDSS", selected="5A11,GB61")
    check("search", "/search", q="e", limit=200)
    check("export/concepts/{id}", "/export/concepts/CH-22", **scoped(variants[0]))
    for name, (size, where) in sorted(largest.items(), key=lambda item: -item[1][0]):
        record_budget(f"size  {name:<28} max {size / 1_000_000:6.3f} MB  ({where[:90]})")


# ----------------------------------------------------------------- latency

def _timed(client, path: str, params: dict) -> float:
    started = time.perf_counter()
    response = client.get(API_PREFIX + path, params=params)
    elapsed = (time.perf_counter() - started) * 1000
    assert response.status_code == 200, response.text[:200]
    return elapsed


def _distinct(rng: random.Random, make, count: int = SAMPLES) -> list[tuple[str, dict]]:
    seen, requests = set(), []
    while len(requests) < count:
        path, params = make(rng)
        key = (path, tuple(sorted(params.items())))
        if key not in seen:
            seen.add(key)
            requests.append((path, params))
    return requests


@pytest.mark.slow
def test_latency_budgets(production_client, live_dataset, variants, lenses):
    rng = random.Random(20261008)
    catalog = Catalog(live_dataset.atlas)
    chapters = [chapter.concept_id for chapter in catalog.chapters]
    concepts = [concept.concept_id for concept in live_dataset.atlas.concepts]
    terms = [concept.pt for concept in catalog.conditions]
    mm_variants = [variant for variant in variants if variant["has_multimorbidity"]]
    combinations = {
        (variant["model"], variant["use_case"]): [
            list(combination.condition_ids)
            for combination in live_dataset.multimorbidity(variant["model"], variant["use_case"]).combinations.values()
        ]
        for variant in mm_variants
    }

    def selection(variant: dict, r: random.Random) -> list[str]:
        combination = r.choice(combinations[(variant["model"], variant["use_case"])])
        return combination[: r.randint(0, len(combination))]

    def search_term(r: random.Random) -> str:
        if r.random() < 0.3:
            return r.choice(concepts)[: r.randint(2, 4)]
        term = r.choice(terms)
        start = r.randint(0, max(0, len(term) - 3))
        return term[start : start + r.randint(3, 8)].strip() or term

    plans = {
        "metrics/map (atlas)": lambda r: ("/metrics/map", {**scoped(r.choice(variants)), **r.choice(lenses), "scope": "atlas"}),
        "metrics/map (chapter)": lambda r: (
            "/metrics/map",
            {**scoped(r.choice(variants)), **r.choice(lenses), "scope": "chapter", "chapter_id": r.choice(chapters)},
        ),
        "metrics/concepts/{id}": lambda r: (f"/metrics/concepts/{r.choice(concepts)}", {**scoped(r.choice(variants)), **r.choice(lenses)}),
        "metrics/concepts/{id}/subgroups": lambda r: (f"/metrics/concepts/{r.choice(concepts)}/subgroups", scoped(r.choice(variants))),
        "search": lambda r: ("/search", {"q": search_term(r)}),
        "metrics/summary": lambda r: ("/metrics/summary", {**scoped(r.choice(variants)), **r.choice(lenses), "view": r.choice(VIEWS)}),
        "multimorbidity/candidates": lambda r: (
            "/multimorbidity/candidates",
            {**scoped(v := r.choice(mm_variants)), **r.choice(lenses), "scope": "atlas", "selected": ",".join(selection(v, r))},
        ),
        "multimorbidity/combination": lambda r: (
            "/multimorbidity/combination",
            {**scoped(v := r.choice(mm_variants)), **r.choice(lenses), "selected": ",".join(r.choice(combinations[(v["model"], v["use_case"])]))},
        ),
    }

    # Warm the process: the store, the atlas, and one request per endpoint.
    for make in plans.values():
        path, params = make(random.Random(1))
        _timed(production_client, path, params)

    misses = []
    for name, make in plans.items():
        timings = [_timed(production_client, path, params) for path, params in _distinct(rng, make)]
        p50, p95 = percentile(timings, 0.5), percentile(timings, 0.95)
        target = TARGETS_MS[name] * PERF_FACTOR
        record_budget(f"time  {name:<28} p50 {p50:6.1f} ms  p95 {p95:6.1f} ms  max {max(timings):6.1f} ms  target p95 ≤ {target:.0f} ms  (n={len(timings)}, uncached)")
        if p95 > target:
            misses.append(f"{name}: p95 {p95:.1f} ms > {target:.0f} ms")

    # A repeated request is answered from the response cache.
    path, params = plans["metrics/map (atlas)"](random.Random(2))
    _timed(production_client, path, params)
    repeats = [_timed(production_client, path, params) for _ in range(SAMPLES)]
    record_budget(f"time  metrics/map (atlas), repeated   p50 {percentile(repeats, 0.5):6.1f} ms  p95 {percentile(repeats, 0.95):6.1f} ms  (response cache)")
    assert not misses, "; ".join(misses)


# --------------------------------------------------------------- catalogue

@pytest.mark.slow
@pytest.mark.parametrize("store", ["seed", "demo"])
def test_catalogue_budget(store, legacy_db, demo_db):
    """Cold: the first request of a fresh app that skipped the startup warm-up
    (loads the version, derives every tile). Build: the tiles of a loaded
    version with an empty distribution cache (what startup and a prevalence
    publish cost). Warm: repeated requests, the normal case after startup."""
    path = legacy_db if store == "seed" else demo_db[0]
    client = local_client(create_app(path))  # no `with`: the lifespan warm-up does not run
    started = time.perf_counter()
    response = client.get(f"{API_PREFIX}/catalogue")
    cold = (time.perf_counter() - started) * 1000
    assert response.status_code == 200, response.text[:200]
    size = len(response.content)
    assert size <= CATALOGUE_MAX_BYTES, f"{size:,} bytes"

    store_ = client.app.state.api.store
    context = store_.resolve("live")
    builds = []
    for _ in range(3):
        started = time.perf_counter()
        with store_.lock:
            build_catalogue(context.dataset, context.catalog, label=context.label, cache=DistributionCache())
        builds.append((time.perf_counter() - started) * 1000)

    warm = [_timed(client, "/catalogue", {}) for _ in range(SAMPLES)]
    p50, p95 = percentile(warm, 0.5), percentile(warm, 0.95)
    tiles = len(response.json()["tiles"])
    record_budget(
        f"time  catalogue ({store}, {tiles} tiles, {size / 1000:.0f} KB)  cold {cold:6.1f} ms  build {min(builds):6.1f} ms  "
        f"warm p50 {p50:5.1f} ms  p95 {p95:5.1f} ms  target warm p95 ≤ {CATALOGUE_WARM_MS * PERF_FACTOR:.0f} ms"
    )
    assert p95 <= CATALOGUE_WARM_MS * PERF_FACTOR, f"warm p95 {p95:.1f} ms"


# -------------------------------------------------------------- populations

POPULATION = "northbridge-region"  # the demo pack's local population (contract v1.10)
POPULATION_PLANS = ("metrics/map (atlas)", "metrics/summary", "metrics/concepts/{id}")


@pytest.mark.slow
def test_population_reads_within_budgets(demo_db, lenses):
    """Contract v1.10 (CONTRACT.md §21): reads for a local population stay under
    2 MB and within the interaction budgets. Measures the first population
    request of a version (builds the population's atlas view), then warm
    uncached map, summary, and concept reads with and without the population."""
    with local_client(create_app(demo_db[0], uploads_dir=demo_db[1].uploads_dir)) as client:
        syn = {"model": "SynGPT-2.0", "use_case": "Clinician Facing CDSS"}
        started = time.perf_counter()
        first = client.get(f"{API_PREFIX}/metrics/map", params={**syn, "scope": "atlas", "population": POPULATION})
        first_ms = (time.perf_counter() - started) * 1000
        assert first.status_code == 200 and first.headers["x-population"] == POPULATION
        sizes = {
            name: len(client.get(API_PREFIX + path, params={**params, "population": POPULATION}).content)
            for name, path, params in (
                ("metrics/map (atlas)", "/metrics/map", {**syn, "scope": "atlas"}),
                ("atlas/overview", "/atlas/overview", {}),
                ("catalogue", "/catalogue", {}),
            )
        }
        assert all(size <= MAX_BYTES for size in sizes.values()), sizes
        assert sizes["catalogue"] <= CATALOGUE_MAX_BYTES, sizes

        concepts = [concept["concept_id"] for concept in client.get(f"{API_PREFIX}/atlas/overview").json()["conditions"]]
        variants = [
            {"model": model["model_version"], "use_case": use_case["use_case"]}
            for model in client.get(f"{API_PREFIX}/models").json()["models"]
            for use_case in model["use_cases"]
        ]
        plans = {
            "metrics/map (atlas)": lambda r: ("/metrics/map", {**r.choice(variants), **r.choice(lenses), "scope": "atlas"}),
            "metrics/summary": lambda r: ("/metrics/summary", {**r.choice(variants), **r.choice(lenses), "view": r.choice(VIEWS)}),
            "metrics/concepts/{id}": lambda r: (f"/metrics/concepts/{r.choice(concepts)}", {**r.choice(variants), **r.choice(lenses)}),
        }
        for name in POPULATION_PLANS:  # warm both views of every endpoint
            path, params = plans[name](random.Random(1))
            _timed(client, path, params)
            _timed(client, path, {**params, "population": POPULATION})
        misses = []
        for name in POPULATION_PLANS:
            for label, extra in (("default", {}), ("population", {"population": POPULATION})):
                requests = _distinct(random.Random(20261012), plans[name], count=30)
                timings = [_timed(client, path, {**params, **extra}) for path, params in requests]
                p50, p95 = percentile(timings, 0.5), percentile(timings, 0.95)
                target = TARGETS_MS[name] * PERF_FACTOR
                record_budget(f"time  {name:<22} {label:<10} p50 {p50:6.1f} ms  p95 {p95:6.1f} ms  target p95 ≤ {target:.0f} ms  (demo store, n={len(timings)}, uncached)")
                if p95 > target:
                    misses.append(f"{name} ({label}): p95 {p95:.1f} ms > {target:.0f} ms")
        record_budget(
            f"time  first population read of a version {first_ms:6.1f} ms; sizes "
            + ", ".join(f"{name} {size / 1000:.0f} KB" for name, size in sizes.items())
        )
        assert not misses, "; ".join(misses)
