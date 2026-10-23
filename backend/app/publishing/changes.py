"""What publishing a staged upload would change (openapi.json ``ChangeSummary``).

Rows compare the staged content set with the live one of the same data set
(and target): added, changed, removed, unchanged. Registry uploads also list
models and use cases added, changed, or removed. Status shifts compare the
depth-1 conditions at the all-population lens (CONTRACT.md §11):

* metrics: the conditions' rows for the uploaded model and use case;
* multimorbidity: the conditions' display rows with nothing selected (how the
  Multimorbidity atlas colors them before a first click);
* prevalence: every model and use case, because tiers feed the evidence
  grade; a condition counts once per shift even if several models shift;
* models and safety: none (neither holds metrics, and safety incidents never
  change grades);
* population (contract v1.10): every model and use case, comparing the
  default answers with the answers for the staged population, as a reader
  sees them when switching to it. Rows compare the staged population with
  the live set of the same population (none for a new one).

Since contract v1.7 a row also counts as changed when only its source
(provenance) changes, safety uploads compare incidents by incident id, and a
merge upload's ``unchanged`` counts only the rows it touched (its other rows
are copies of the live ones).

Since contract v1.4 every shift also lists its ``targets`` (the same shift per
model and use case), and ``rows.samples`` names up to 50 added, changed, and
removed rows per kind.
"""

from __future__ import annotations

import json
import sqlite3
from collections import OrderedDict

from .. import repository
from ..repository import DatasetState
from ..services import grading
from ..services.catalog import is_top_level_condition
from ..services.dataset import Dataset
from ..services.metrics import MetricsService
from ..services.multimorbidity import MultimorbidityService
from ..services.presentation import statuses
from ..services.atlas import Atlas
from ..services.types import ALL_POPULATIONS, MetricValues
from . import content as contents

MAX_SAMPLES = 50
VIEWS = ("overall", "performance", "evidence", "intended_use")

# Columns that make a metric row "changed".
_COMPARED = (
    "perf", "ci_low", "ci_high", "evidence_grade", "n_samples", "n_sites", "n_studies", "peer_reviewed_studies",
    "validation_type", "in_intended_use", "intended_use_coverage", "intended_use_level", "warning_set_id",
)


def _row_counts(added: int = 0, changed: int = 0, removed: int = 0, unchanged: int = 0) -> dict:
    return {"added": added, "changed": changed, "removed": removed, "unchanged": unchanged}


_METRIC_JOIN = (
    "FROM metric_rows s LEFT JOIN metric_rows l ON l.set_id = ? AND l.combo_idx = s.combo_idx AND l.concept_id = s.concept_id "
    "LEFT JOIN metric_row_provenance sp ON sp.set_id = s.set_id AND sp.combo_idx = s.combo_idx AND sp.concept_id = s.concept_id "
    "LEFT JOIN metric_row_provenance lp ON lp.set_id = l.set_id AND lp.combo_idx = s.combo_idx AND lp.concept_id = s.concept_id "
    "WHERE s.set_id = ?"
)


def _differs(staged_default: int, live_default: int) -> tuple[str, tuple]:
    """SQL that is true when a matched row's values or source differ, and its parameters."""
    values = " OR ".join(f"s.{column} IS NOT l.{column}" for column in _COMPARED)
    return f"({values} OR COALESCE(sp.provenance_id, ?) IS NOT COALESCE(lp.provenance_id, ?))", (staged_default, live_default)


def metric_row_counts(conn: sqlite3.Connection, staged_set: int, live_set: int | None) -> dict:
    if live_set is None:
        total = conn.execute("SELECT COUNT(*) FROM metric_rows WHERE set_id = ?", (staged_set,)).fetchone()[0]
        return _row_counts(added=total)
    differs, params = _differs(repository.default_provenance_id(conn, staged_set), repository.default_provenance_id(conn, live_set))
    added, changed, matched = conn.execute(
        f"SELECT COALESCE(SUM(l.concept_id IS NULL), 0), "
        f"COALESCE(SUM(l.concept_id IS NOT NULL AND {differs}), 0), "
        f"COALESCE(SUM(l.concept_id IS NOT NULL), 0) {_METRIC_JOIN}",
        (*params, live_set, staged_set),
    ).fetchone()
    live_total = conn.execute("SELECT COUNT(*) FROM metric_rows WHERE set_id = ?", (live_set,)).fetchone()[0]
    return _row_counts(added, changed, live_total - matched, matched - changed)


def metric_row_samples(conn: sqlite3.Connection, staged_set: int, live_set: int | None) -> dict[str, list[tuple[str, int]]]:
    """Up to ``MAX_SAMPLES`` (concept id, combo index) keys per kind, in lens then concept order."""
    def keys(sql: str, params: tuple) -> list[tuple[str, int]]:
        return [(row[0], row[1]) for row in conn.execute(sql + " ORDER BY 2, 1 LIMIT ?", (*params, MAX_SAMPLES))]

    if live_set is None:
        added = keys("SELECT concept_id, combo_idx FROM metric_rows WHERE set_id = ?", (staged_set,))
        return {"added": added, "changed": [], "removed": []}
    differs, params = _differs(repository.default_provenance_id(conn, staged_set), repository.default_provenance_id(conn, live_set))
    return {
        "added": keys(f"SELECT s.concept_id, s.combo_idx {_METRIC_JOIN} AND l.concept_id IS NULL", (live_set, staged_set)),
        "changed": keys(
            f"SELECT s.concept_id, s.combo_idx {_METRIC_JOIN} AND l.concept_id IS NOT NULL AND {differs}",
            (live_set, staged_set, *params),
        ),
        "removed": keys(
            "SELECT l.concept_id, l.combo_idx FROM metric_rows l LEFT JOIN metric_rows s "
            "ON s.set_id = ? AND s.combo_idx = l.combo_idx AND s.concept_id = l.concept_id "
            "WHERE l.set_id = ? AND s.concept_id IS NULL",
            (staged_set, live_set),
        ),
    }


def _prevalence_rows(conn: sqlite3.Connection, set_id: int | None) -> dict[str, tuple]:
    """Code → (tier, source) of a prevalence set."""
    if set_id is None:
        return {}
    content = contents.load_prevalence(conn, set_id)
    default, explicit = contents.load_sources(conn, "prevalence", set_id)
    return {code: (tier, explicit.get(code, default)) for code, tier in content.tiers.items()}


def _merge_touched(conn: sqlite3.Connection, set_id: int) -> int | None:
    """The rows a merge upload touched (from its set's meta), None for other uploads."""
    meta = json.loads(conn.execute("SELECT meta_json FROM content_sets WHERE set_id = ?", (set_id,)).fetchone()[0])
    return meta.get("touched") if meta.get("mode") == "merge" else None


def _multimorbidity_rows(content: contents.MultimorbidityContent | None) -> dict[tuple[str, int], tuple]:
    if content is None:
        return {}
    return {
        (combination.key, combo_idx): (combination.label, values)
        for combination in content.combinations
        for combo_idx, values in combination.rows.items()
    }


def _compare(staged: dict, live: dict) -> tuple[dict, dict[str, list]]:
    """Row counts, and the first ``MAX_SAMPLES`` keys per kind in file order."""
    added = changed = unchanged = 0
    keys: dict[str, list] = {"added": [], "changed": [], "removed": []}
    for key, value in staged.items():
        if key not in live:
            added += 1
            keys["added"].append(key)
        elif live[key] != value:
            changed += 1
            keys["changed"].append(key)
        else:
            unchanged += 1
    removed = [key for key in live if key not in staged]
    keys["removed"] = removed
    return _row_counts(added, changed, len(removed), unchanged), {kind: found[:MAX_SAMPLES] for kind, found in keys.items()}


def _registry_changes(staged: contents.RegistryContent, live: contents.RegistryContent) -> tuple[dict, dict, dict]:
    def variant_rows(registry: contents.RegistryContent) -> dict:
        rows = {}
        for model in registry.models:
            for use_case in model.use_cases:
                # A configuration changes when its model's fields or its own
                # fields (contract v1.5) change.
                rows[(model.model_version, use_case)] = (
                    model.display_name,
                    model.model_name,
                    model.model_release,
                    model.status,
                    model.default_use_case == use_case,
                    registry.default_model_version == model.model_version,
                    model.entry_values(),
                    model.configuration(use_case).values(),
                )
        return rows

    staged_rows, live_rows = variant_rows(staged), variant_rows(live)
    staged_models = {model.model_version: model for model in staged.models}
    live_models = {model.model_version: model for model in live.models}

    def model_signature(registry: contents.RegistryContent, model: contents.ModelEntry) -> tuple:
        return (
            model.display_name, model.model_name, model.model_release, model.status, model.default_use_case,
            tuple(sorted(model.use_cases)), registry.default_model_version == model.model_version,
            model.entry_values(),
            tuple(sorted((use_case, model.configuration(use_case).values()) for use_case in model.use_cases)),
        )

    models = {
        "added": [version for version in staged_models if version not in live_models],
        "changed": [
            version
            for version, model in staged_models.items()
            if version in live_models and model_signature(staged, model) != model_signature(live, live_models[version])
        ],
        "removed": [version for version in live_models if version not in staged_models],
    }
    use_cases = {
        "added": [f"{model} / {use_case}" for model, use_case in staged_rows if (model, use_case) not in live_rows],
        "removed": [f"{model} / {use_case}" for model, use_case in live_rows if (model, use_case) not in staged_rows],
    }
    rows, keys = _compare(staged_rows, live_rows)
    return rows, keys, models, use_cases


# ----------------------------------------------------------- status shifts

def _condition_statuses(row: MetricValues | None) -> dict[str, str]:
    shown = statuses(row)
    # No row, or no intended-use value (v1.11): no_data.
    shown["intended_use"] = (row.intended_use_level if row is not None else None) or "no_data"
    return shown


def _display_statuses(rows: dict[str, MetricValues | None]) -> dict[str, str]:
    return {
        "overall": grading.overall_status(grading.overall_for(rows["overall"])),
        "performance": grading.performance_status(rows["performance"]),
        "evidence": grading.evidence_status(rows["evidence"]),
        "intended_use": (rows["intended_use"].intended_use_level if rows["intended_use"] is not None else None) or "no_data",
    }


class _Shifts:
    def __init__(self) -> None:
        # (view, from, to) → concepts, and the same per (model_version, use_case).
        self.groups: OrderedDict[tuple[str, str, str], dict[str, None]] = OrderedDict()
        self.by_target: dict[tuple[str, str, str], OrderedDict[tuple[str, str], dict[str, None]]] = {}

    def compare(self, concept_id: str, before: dict[str, str], after: dict[str, str], target: tuple[str, str]) -> None:
        for view in VIEWS:
            if before[view] != after[view]:
                group = (view, before[view], after[view])
                self.groups.setdefault(group, {})[concept_id] = None
                self.by_target.setdefault(group, OrderedDict()).setdefault(target, {})[concept_id] = None

    def result(self) -> list[dict]:
        ordered = sorted(self.groups.items(), key=lambda item: (VIEWS.index(item[0][0]), -len(item[1])))
        return [
            {
                "view": view,
                "from": before,
                "to": after,
                "count": len(concepts),
                "sample_concept_ids": list(concepts)[:MAX_SAMPLES],
                "targets": [
                    {
                        "model_version": target[0],
                        "use_case": target[1],
                        "count": len(target_concepts),
                        "sample_concept_ids": list(target_concepts)[:MAX_SAMPLES],
                    }
                    for target, target_concepts in sorted(
                        self.by_target[(view, before, after)].items(), key=lambda item: -len(item[1])
                    )
                ],
            }
            for (view, before, after), concepts in ordered
        ]


# ------------------------------------------------------------------ samples

def _lens(atlas: Atlas, combo_idx: int) -> dict:
    return atlas.axes.lens_for_index(combo_idx).as_dict()


def _condition_sample(atlas: Atlas, concept_id: str, combo_idx: int | None = None) -> dict:
    concept = atlas.by_id.get(concept_id)
    sample = {
        "key": concept_id if combo_idx is None else f"{concept_id}|{combo_idx}",
        "name": concept.pt if concept else concept_id,
        "concept_id": concept_id,
        "code": (concept.icd11_code if concept else None) or concept_id,
        "lens": None if combo_idx is None else _lens(atlas, combo_idx),
    }
    if combo_idx is not None and combo_idx >= atlas.axes.per_setting:
        # Contract v1.14 (§29): a row of a specific care setting names it; Any-setting samples are unchanged.
        sample["setting"] = atlas.axes.setting_of_index(combo_idx)
    return sample


def metric_setting_counts(conn: sqlite3.Connection, atlas: Atlas, staged_set: int, live_set: int | None) -> list[dict]:
    """Added, changed, and removed rows per specific care setting (contract v1.14, §29), in axis
    order, for the settings an upload touches; empty when it touches Any setting only."""
    per_setting = atlas.axes.per_setting
    counts: dict[int, dict] = {}

    def add(position: int, name: str, count: int) -> None:
        if count:
            counts.setdefault(position, {"added": 0, "changed": 0, "removed": 0})[name] += count

    if live_set is None:
        for position, total in conn.execute(
            "SELECT combo_idx / ?, COUNT(*) FROM metric_rows WHERE set_id = ? AND combo_idx >= ? GROUP BY 1",
            (per_setting, staged_set, per_setting),
        ):
            add(position, "added", total)
    else:
        differs, params = _differs(repository.default_provenance_id(conn, staged_set), repository.default_provenance_id(conn, live_set))
        for position, added, changed in conn.execute(
            f"SELECT s.combo_idx / ?, COALESCE(SUM(l.concept_id IS NULL), 0), "
            f"COALESCE(SUM(l.concept_id IS NOT NULL AND {differs}), 0) {_METRIC_JOIN} AND s.combo_idx >= ? GROUP BY 1",
            (per_setting, *params, live_set, staged_set, per_setting),
        ):
            add(position, "added", added)
            add(position, "changed", changed)
        for position, removed in conn.execute(
            "SELECT l.combo_idx / ?, COUNT(*) FROM metric_rows l LEFT JOIN metric_rows s "
            "ON s.set_id = ? AND s.combo_idx = l.combo_idx AND s.concept_id = l.concept_id "
            "WHERE l.set_id = ? AND l.combo_idx >= ? AND s.concept_id IS NULL GROUP BY 1",
            (per_setting, staged_set, live_set, per_setting),
        ):
            add(position, "removed", removed)
    return [{"setting": atlas.axes.context[position], **counts[position]} for position in sorted(counts)]


def _combination_sample(atlas: Atlas, key: tuple[str, int], labels: dict[str, str | None]) -> dict:
    combination_key, combo_idx = key
    label = labels.get(combination_key)
    if not label:
        names = []
        for concept_id in combination_key.split("+"):
            concept = atlas.by_id.get(concept_id)
            names.append(concept.pt if concept else concept_id)
        label = " + ".join(names)
    return {"key": f"{combination_key}|{combo_idx}", "name": label, "concept_id": None, "code": None, "lens": _lens(atlas, combo_idx)}


def _incident_sample(incident: repository.IncidentRecord) -> dict:
    summary = incident.summary if len(incident.summary) <= 80 else incident.summary[:79] + "…"
    first = incident.condition_ids[0] if incident.condition_ids else None
    return {
        "key": incident.incident_id,
        "name": f"{incident.incident_id}: {summary}",
        "concept_id": first or incident.chapter_id,
        "code": incident.codes[0] if incident.codes else None,
        "lens": {"age": incident.age, "sex": incident.sex, "ethnicity": incident.ethnicity},
    }


def _study_sample(study: repository.StudyRecord) -> dict:
    title = study.title if len(study.title) <= 80 else study.title[:79] + "…"
    return {"key": study.study_id, "name": f"{study.study_id}: {title}", "concept_id": None, "code": None, "lens": None}


def _model_card_sample(card: repository.ModelCardRecord) -> dict:
    name = card.card.get("name") or card.model_version
    return {"key": card.model_version, "name": f"{card.model_version}: {name}"[:120], "concept_id": None, "code": None, "lens": None}


def _effect_sample(effect: repository.EffectRecord) -> dict:
    outcome = effect.outcome if len(effect.outcome) <= 80 else effect.outcome[:79] + "…"
    first = effect.condition_ids[0] if effect.condition_ids else None
    return {
        "key": effect.effect_id,
        "name": f"{effect.effect_id}: {outcome}",
        "concept_id": first or effect.chapter_id,
        "code": effect.codes[0] if effect.codes else None,
        "lens": None,
    }


def _variant_sample(key: tuple[str, str]) -> dict:
    name = f"{key[0]} / {key[1]}"
    return {"key": name, "name": name, "concept_id": None, "code": None, "lens": None}


def _conditions(dataset: Dataset):
    return [concept for concept in dataset.atlas.concepts if is_top_level_condition(concept)]


def _metrics(dataset: Dataset, target: tuple[str, str]) -> MetricsService | None:
    """The target's metrics, even for a model the registry does not list yet."""
    set_id = dataset.state.metric_sets.get(target)
    if set_id is None:
        return None
    return dataset.metrics_of_set(target, set_id, lens_cache_size=1, reader_cache_size=1)


def _multimorbidity(dataset: Dataset, target: tuple[str, str]) -> MultimorbidityService:
    set_id = dataset.state.multimorbidity_sets.get(target)
    reader = (
        repository.MultimorbiditySetReader(dataset.connection, set_id, repository.WarningSets(dataset.connection))
        if set_id is not None
        else None
    )
    return MultimorbidityService(
        dataset.atlas, reader, model_version=target[0], use_case=target[1], intended_use_defined=dataset.intended_use_defined(*target)
    )


def _metric_shifts(shifts: _Shifts, live: Dataset, staged: Dataset, target: tuple[str, str]) -> None:
    live_metrics, staged_metrics = _metrics(live, target), _metrics(staged, target)
    for concept in _conditions(staged):
        before = live_metrics.row(concept.concept_id, ALL_POPULATIONS) if live_metrics else None
        after = staged_metrics.row(concept.concept_id, ALL_POPULATIONS) if staged_metrics else None
        shifts.compare(concept.concept_id, _condition_statuses(before), _condition_statuses(after), target)


def _multimorbidity_shifts(shifts: _Shifts, live: Dataset, staged: Dataset, target: tuple[str, str]) -> None:
    conditions = _conditions(staged)
    before = _multimorbidity(live, target).display_rows(conditions, ())
    after = _multimorbidity(staged, target).display_rows(conditions, ())
    for concept in conditions:
        shifts.compare(
            concept.concept_id,
            _display_statuses(before[concept.concept_id]),
            _display_statuses(after[concept.concept_id]),
            target,
        )


def _prevalence_shifts(shifts: _Shifts, live: Dataset, staged: Dataset, *, linked_only: bool = False) -> None:
    """Every card's shifts. ``linked_only`` (a studies upload, contract v1.13)
    skips the cards whose rows link to no study before or after: their
    statuses cannot change."""
    for model in live.registry.models:
        for variant in model.use_cases:
            target = (model.model_version, variant.use_case)
            set_id = live.state.metric_sets.get(target)
            if set_id is None:
                continue
            if linked_only and live.studies.for_set(set_id) is None and staged.studies.for_set(set_id) is None:
                continue
            _metric_shifts(shifts, live, staged, target)


# ------------------------------------------------------------------- main

def change_summary(
    conn: sqlite3.Connection,
    *,
    upload_id: str,
    kind: str,
    target: tuple[str, str] | None,
    staged_set: int,
    live_state: DatasetState,
    staged_state: DatasetState,
) -> dict:
    """The ``ChangeSummary`` of publishing ``staged_set`` over ``live_state``."""
    live_set = contents.set_id_of(live_state, kind, target)
    models = {"added": [], "changed": [], "removed": []}
    use_cases = {"added": [], "removed": []}
    # The registry holds no conditions, so a registry upload needs no atlas.
    # Effects (contract v1.13, §27) never change a grade, so they need no atlas either.
    staged_dataset = Dataset(conn, state=staged_state) if kind not in ("models", "safety", "model_cards", "effects") else None
    if kind == "population":
        staged_dataset = staged_dataset.with_population(target)
    elif kind == "local_metrics" and target[2] in staged_state.population_sets:
        # Local results (contract v1.13, §26) are read for their population.
        staged_dataset = staged_dataset.with_population(target[2])
    atlas = staged_dataset.atlas if staged_dataset else None
    if kind in ("metrics", "local_metrics"):
        rows = metric_row_counts(conn, staged_set, live_set)
        settings = metric_setting_counts(conn, atlas, staged_set, live_set)
        if settings:
            rows["settings"] = settings  # contract v1.14 (§29), only when a specific setting is touched
        samples = {
            name: [_condition_sample(atlas, concept_id, combo_idx) for concept_id, combo_idx in keys]
            for name, keys in metric_row_samples(conn, staged_set, live_set).items()
        }
    elif kind == "multimorbidity":
        staged = contents.load_content(conn, kind, staged_set, target)
        live = contents.load_content(conn, kind, live_set, target) if live_set is not None else None
        rows, keys = _compare(_multimorbidity_rows(staged), _multimorbidity_rows(live))
        labels = {combination.key: combination.label for content in (live, staged) if content for combination in content.combinations}
        samples = {name: [_combination_sample(atlas, key, labels) for key in found] for name, found in keys.items()}
    elif kind in ("prevalence", "population"):
        rows, keys = _compare(_prevalence_rows(conn, staged_set), _prevalence_rows(conn, live_set))
        samples = {name: [_condition_sample(atlas, code) for code in found] for name, found in keys.items()}
    elif kind == "safety":
        staged = {incident.incident_id: incident for incident in repository.load_incidents(conn, staged_set)}
        live = {incident.incident_id: incident for incident in repository.load_incidents(conn, live_set)}
        rows, keys = _compare(staged, live)
        samples = {name: [_incident_sample(staged.get(key) or live[key]) for key in found] for name, found in keys.items()}
    elif kind == "model_cards":
        staged = {card.model_version: card for card in repository.load_model_cards(conn, staged_set)}
        live = {card.model_version: card for card in repository.load_model_cards(conn, live_set)}
        rows, keys = _compare(staged, live)
        samples = {name: [_model_card_sample(staged.get(key) or live[key]) for key in found] for name, found in keys.items()}
    elif kind == "studies":
        staged = {study.study_id: study for study in repository.load_studies(conn, staged_set)}
        live = {study.study_id: study for study in repository.load_studies(conn, live_set)}
        rows, keys = _compare(staged, live)
        samples = {name: [_study_sample(staged.get(key) or live[key]) for key in found] for name, found in keys.items()}
    elif kind == "effects":
        staged = {effect.effect_id: effect for effect in repository.load_effects(conn, staged_set)}
        live = {effect.effect_id: effect for effect in repository.load_effects(conn, live_set)}
        rows, keys = _compare(staged, live)
        samples = {name: [_effect_sample(staged.get(key) or live[key]) for key in found] for name, found in keys.items()}
    else:
        staged = contents.load_content(conn, kind, staged_set)
        live = contents.load_content(conn, kind, live_set)
        rows, keys, models, use_cases = _registry_changes(staged, live)
        samples = {name: [_variant_sample(key) for key in found] for name, found in keys.items()}

    touched = _merge_touched(conn, staged_set)
    if touched is not None:
        rows["unchanged"] = max(0, touched - rows["added"] - rows["changed"] - rows["removed"])
    shifts = _Shifts()
    # A population's shifts compare it with the default, so they show even when
    # its rows equal the live population's.
    if kind not in ("models", "safety", "model_cards", "effects") and (kind == "population" or rows["added"] or rows["changed"] or rows["removed"]):
        live_dataset = Dataset(conn, state=live_state)
        if kind == "local_metrics":
            if target[2] in live_state.population_sets and target[2] in staged_state.population_sets:
                _metric_shifts(shifts, live_dataset.with_population(target[2]), staged_dataset, target[:2])
        elif kind == "metrics":
            _metric_shifts(shifts, live_dataset, staged_dataset, target)
        elif kind == "multimorbidity":
            _multimorbidity_shifts(shifts, live_dataset, staged_dataset, target)
        else:
            _prevalence_shifts(shifts, live_dataset, staged_dataset, linked_only=kind == "studies")
    return {
        "upload_id": upload_id,
        "kind": kind,
        "base_version": live_state.version_id,
        "rows": {**rows, "samples": samples},
        "models": models,
        "use_cases": use_cases,
        "status_shifts": shifts.result(),
    }


def describe(summary: dict, title: str) -> str:
    """One plain sentence for the version history."""
    rows = summary["rows"]
    noun, nouns = {
        "safety": ("incident", "incidents"), "studies": ("study", "studies"), "model_cards": ("narrow model card", "narrow model cards"),
        "effects": ("effect", "effects"),
    }.get(summary["kind"], ("row", "rows"))
    parts = [f"{rows[name]:,} {noun if rows[name] == 1 else nouns} {name}" for name in ("added", "changed", "removed") if rows[name]]
    models = summary["models"]
    parts += [
        f"{len(models[name])} {'AI system' if len(models[name]) == 1 else 'AI systems'} {name}"
        for name in ("added", "removed")
        if models.get(name)
    ]
    shifted = sum(shift["count"] for shift in summary["status_shifts"] if shift["view"] == "overall")
    if shifted:
        against = {"population": " against the default population", "local_metrics": " for readers of the local population"}.get(summary["kind"], "")
        parts.append(f"{shifted:,} overall status changes{against}")
    return f"{title}: " + (", ".join(parts) if parts else "no changes") + "."
