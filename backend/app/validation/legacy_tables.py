"""Contract validation of the seed: the synthetic JSON tables in ``backend/seed``.

Ported from the reference client's runtime-table checks (tag v0.2.0-alpha.1), plus the
checks the store relies on: metric axes and lens combinations must match the
atlas axes so every tuple maps to one lens combination, and prevalence values
must be commonness tiers. The importer (``app.importers.legacy_json``) runs
these checks, and the row-level checks it applies while writing, on every
import and on ``--check`` (``npm run validate-seed``).

The registry names its metrics files by the web path of the retired static app
(``data/tables/models/<file>``). The seed files keep that text unchanged; the
path is resolved against the seed root by dropping the ``data/tables/`` prefix
(``seed_relative``).
"""

from __future__ import annotations

import math
from typing import Any, Iterable

from ..schema.contract import AGE_ALL, ETHNICITY_ALL, GRADES, METRIC_ROW_FORMAT, SEX_ALL
from ..services.atlas import normalize_prevalence_tier

LENS_AXES = ("age_lens", "sex_lens", "ethnicity_lens")
REGISTRY_PATH_PREFIX = "data/tables/"
REQUIRED_COMBO_KEYS = ("task_mode", "context", "age_lens", "sex_lens", "ethnicity_lens")
_GRADE_SET = frozenset(GRADES)


class ContractViolation(ValueError):
    """The source data breaks the data contract; nothing is imported."""


def require(condition: Any, message: str) -> None:
    if not condition:
        raise ContractViolation(message)


def _non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and value.strip() != ""


def _finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _no_duplicates(values: Iterable, label: str) -> None:
    seen = set()
    for value in values:
        require(value not in seen, f'{label} contains duplicate "{value}".')
        seen.add(value)


def normalize_runtime_metrics_path(metrics_file: Any) -> str:
    normalized = str(metrics_file if metrics_file is not None else "").strip().replace("\\", "/")
    require(normalized, "Runtime metrics_file must not be empty.")
    require(not normalized.startswith("/"), f'Runtime metrics_file "{normalized}" must be relative.')
    require(".." not in normalized, f'Runtime metrics_file "{normalized}" must not contain path traversal.')
    require(
        normalized.startswith(f"{REGISTRY_PATH_PREFIX}models/"),
        f'Runtime metrics_file "{normalized}" must live under {REGISTRY_PATH_PREFIX}models/.',
    )
    require(normalized.endswith(".metrics.json"), f'Runtime metrics_file "{normalized}" must end with .metrics.json.')
    return normalized


def seed_relative(registry_path: str) -> str:
    """A normalized registry path, relative to the seed root.

    'data/tables/models/x.metrics.json' -> 'models/x.metrics.json'.
    """
    return registry_path.removeprefix(REGISTRY_PATH_PREFIX)


def validate_combo_definition(combo: Any, label: str) -> None:
    require(isinstance(combo, dict), f"{label} must be an object.")
    for key in REQUIRED_COMBO_KEYS:
        require(_non_empty_string(combo.get(key)), f"{label} is missing {key}.")


def validate_atlas_base(atlas: Any) -> None:
    require(isinstance(atlas, dict), "Runtime atlas-base.json must be an object.")
    concepts = atlas.get("concepts")
    require(isinstance(concepts, list), "Runtime atlas-base.json concepts must be an array.")
    require(concepts, "Runtime atlas-base.json concepts must not be empty.")
    require(
        isinstance(atlas.get("top_level_condition_ids"), list),
        "Runtime atlas-base.json top_level_condition_ids must be an array.",
    )
    require(isinstance(atlas.get("combo_definitions"), list), "Runtime atlas-base.json combo_definitions must be an array.")
    require(isinstance(atlas.get("metric_axes"), dict), "Runtime atlas-base.json metric_axes must be an object.")

    concept_ids = []
    for index, concept in enumerate(concepts):
        require(isinstance(concept, dict), f"Runtime atlas concept {index} must be an object.")
        require(_non_empty_string(concept.get("concept_id")), f"Runtime atlas concept {index} is missing concept_id.")
        require(
            concept.get("level") in (0, 1, 2) and not isinstance(concept.get("level"), bool),
            f'Runtime atlas concept "{concept["concept_id"]}" has invalid level.',
        )
        require(_non_empty_string(concept.get("pt")), f'Runtime atlas concept "{concept["concept_id"]}" is missing pt.')
        concept_ids.append(concept["concept_id"])
    _no_duplicates(concept_ids, "Runtime atlas concept_id")

    known = set(concept_ids)
    for concept in concepts:
        parent_id = concept.get("parent_id")
        if parent_id is not None:
            require(
                parent_id in known,
                f'Runtime atlas concept "{concept["concept_id"]}" references missing parent "{parent_id}".',
            )

    _no_duplicates(atlas["top_level_condition_ids"], "Runtime atlas top_level_condition_ids")
    for condition_id in atlas["top_level_condition_ids"]:
        require(
            condition_id in known,
            f'Runtime atlas top_level_condition_id "{condition_id}" is not present in concepts.',
        )

    for index, combo in enumerate(atlas["combo_definitions"]):
        validate_combo_definition(combo, f"Runtime atlas combo_definitions[{index}]")

    axes = atlas["metric_axes"]
    require(
        isinstance(axes.get("context"), list) and len(axes["context"]) == 1,
        "Runtime atlas metric_axes.context must have exactly one value (CONTRACT.md §3).",
    )
    for axis, all_value in zip(LENS_AXES, (AGE_ALL, SEX_ALL, ETHNICITY_ALL)):
        values = axes.get(axis)
        require(
            isinstance(values, list) and values and all(_non_empty_string(value) for value in values),
            f"Runtime atlas metric_axes.{axis} must be a non-empty list of labels.",
        )
        _no_duplicates(values, f"Runtime atlas metric_axes.{axis}")
        require(all_value in values, f'Runtime atlas metric_axes.{axis} must include "{all_value}".')


def validate_prevalence(payload: Any) -> list[tuple[str, str]]:
    """The (code, tier) pairs of prevalence_by_code.json, in file order."""
    require(isinstance(payload, dict), "prevalence_by_code.json must be an object.")
    require(_non_empty_string(payload.get("dataset_id")), "prevalence_by_code.json dataset_id is required.")
    if payload.get("min_score") is not None or payload.get("max_score") is not None:
        low, high = payload.get("min_score"), payload.get("max_score")
        require(
            _finite_number(low) and _finite_number(high),
            "prevalence_by_code.json min_score and max_score must be finite numbers when present.",
        )
        require(low < high, "prevalence_by_code.json min_score must be less than max_score.")
    scores = payload.get("scores_by_code")
    require(isinstance(scores, dict) and scores, "prevalence_by_code.json scores_by_code must be a non-empty object.")
    if payload.get("code_count") is not None:
        require(
            payload["code_count"] == len(scores),
            "prevalence_by_code.json code_count does not match scores_by_code size.",
        )
    tiers = []
    for code, value in scores.items():
        require(code.strip(), "prevalence_by_code.json contains an empty code key.")
        tier = normalize_prevalence_tier(value) if isinstance(value, str) else None
        require(
            tier is not None,
            f'prevalence_by_code.json code "{code}" has value {value!r}; expected a commonness tier '
            "(very_rare, rare, uncommon, common, very_common).",
        )
        tiers.append((code, tier))
    return tiers


def require_referenced_metrics_files(seed_files: Iterable[str], referenced: Iterable[str]) -> None:
    """Every models/*.metrics.json file in the seed must be named by the registry."""
    known = set(referenced)
    for relative in sorted(seed_files):
        require(relative in known, f'Seed metrics file "{relative}" is not referenced by model-registry.json.')


def validate_registry(registry: Any) -> list[dict]:
    """Returns the variants with normalized file paths, in registry order."""
    require(isinstance(registry, dict), "Runtime model-registry.json must be an object.")
    models = registry.get("models")
    require(isinstance(models, list), "Runtime model-registry.json models must be an array.")
    require(models, "Runtime model-registry.json models must not be empty.")

    model_versions, variant_keys, variants = [], [], []
    for model_index, model in enumerate(models):
        require(isinstance(model, dict), f"Runtime model registry model {model_index} must be an object.")
        version = model.get("model_version")
        require(_non_empty_string(version), f"Runtime model registry model {model_index} is missing model_version.")
        require(_non_empty_string(model.get("display_name")), f'Runtime model registry model "{version}" is missing display_name.')
        require(_non_empty_string(model.get("status")), f'Runtime model registry model "{version}" is missing status.')
        model_variants = model.get("use_case_variants")
        require(
            isinstance(model_variants, list) and model_variants,
            f'Runtime model registry model "{version}" must define use_case_variants.',
        )
        model_versions.append(version)

        use_cases = []
        for variant_index, variant in enumerate(model_variants):
            require(
                isinstance(variant, dict),
                f"Runtime model registry variant {version}[{variant_index}] must be an object.",
            )
            require(
                _non_empty_string(variant.get("use_case")),
                f"Runtime model registry variant {version}[{variant_index}] is missing use_case.",
            )
            metrics_file = normalize_runtime_metrics_path(variant.get("metrics_file"))
            mm_raw = variant.get("multimorbidity_metrics_file")
            mm_file = None if mm_raw is None or str(mm_raw).strip() == "" else normalize_runtime_metrics_path(mm_raw)
            variant_keys.append(f"{version}::{variant['use_case']}")
            use_cases.append(variant["use_case"])
            variants.append(
                {
                    "model_version": version,
                    "use_case": variant["use_case"],
                    "metrics_file": metrics_file,
                    "multimorbidity_metrics_file": mm_file,
                }
            )

        _no_duplicates(use_cases, f'Runtime model registry use cases for "{version}"')
        default_use_case = model.get("default_use_case")
        if default_use_case is not None and str(default_use_case).strip():
            require(
                default_use_case in use_cases,
                f'Runtime model registry default_use_case "{default_use_case}" is not a variant for "{version}".',
            )

    _no_duplicates(model_versions, "Runtime model registry model_version")
    _no_duplicates(variant_keys, "Runtime model registry model/use_case variants")
    default_model = registry.get("default_model_version")
    if default_model is not None and str(default_model).strip():
        require(
            default_model in model_versions,
            f'Runtime model registry default_model_version "{default_model}" is not present in models.',
        )
    return variants


def validate_payload_header(
    payload: Any, *, kind: str, label: str, expected_model: str, expected_use_case: str, atlas_axes: dict
) -> None:
    """Shared header checks of single-disease and multimorbidity payloads."""
    noun = "metrics" if kind == "metrics" else "multimorbidity"
    require(isinstance(payload, dict), f"Runtime {noun} payload {label} must be an object.")
    require(payload.get("schema_version") == 1, f"Runtime {noun} payload {label} must have schema_version 1.")
    require(_non_empty_string(payload.get("model_version")), f"Runtime {noun} payload {label} is missing model_version.")
    require(_non_empty_string(payload.get("use_case")), f"Runtime {noun} payload {label} is missing use_case.")
    require(
        payload["model_version"] == expected_model,
        f'Runtime {noun} payload {label} model_version "{payload["model_version"]}" does not match registry "{expected_model}".',
    )
    require(
        payload["use_case"] == expected_use_case,
        f'Runtime {noun} payload {label} use_case "{payload["use_case"]}" does not match registry "{expected_use_case}".',
    )
    require(
        isinstance(payload.get("row_format"), list) and tuple(payload["row_format"]) == METRIC_ROW_FORMAT,
        f"Runtime {noun} payload {label} row_format does not match the expected metric tuple contract.",
    )
    combos = payload.get("combo_definitions")
    require(isinstance(combos, list), f"Runtime {noun} payload {label} combo_definitions must be an array.")
    require(combos, f"Runtime {noun} payload {label} combo_definitions must not be empty.")
    if payload.get("combo_count") is not None:
        require(
            payload["combo_count"] == len(combos),
            f"Runtime {noun} payload {label} combo_count does not match combo_definitions length.",
        )
    for index, combo in enumerate(combos):
        combo_label = f"Runtime {noun} payload {label} combo_definitions[{index}]"
        validate_combo_definition(combo, combo_label)
        require(
            combo["task_mode"] == payload["use_case"],
            f'{combo_label} task_mode "{combo["task_mode"]}" does not match use_case "{payload["use_case"]}".',
        )
        require(
            combo["context"] == atlas_axes["context"][0],
            f'{combo_label} context "{combo["context"]}" is not "{atlas_axes["context"][0]}".',
        )
        for axis in LENS_AXES:
            require(combo[axis] in atlas_axes[axis], f'{combo_label} {axis} "{combo[axis]}" is not an atlas axis value.')

    file_axes = payload.get("metric_axes")
    if isinstance(file_axes, dict):
        for axis in LENS_AXES:
            if file_axes.get(axis):
                require(
                    list(file_axes[axis]) == list(atlas_axes[axis]),
                    f"Runtime {noun} payload {label} metric_axes.{axis} differs from the atlas axes.",
                )


def tuple_problem(values: Any) -> str | None:
    """Why a metric tuple breaks the contract, or None when it is valid."""
    if not isinstance(values, list):
        return "must be an array"
    if len(values) != 13:
        return "tuple length does not match row_format length"
    for index in (0, 1, 2, 4, 5, 6, 7, 10):
        value = values[index]
        if value is not None and not _finite_number(value):
            return f"{METRIC_ROW_FORMAT[index]} must be a finite number or null"
    grade = values[3]
    if grade is not None and grade not in _GRADE_SET:
        return "evidence_grade is invalid"
    validation_type = values[8]
    if validation_type is not None and not _non_empty_string(validation_type):
        return "validation_type must be a string or null"
    flag = values[9]
    if not (isinstance(flag, bool) or (_finite_number(flag) and flag in (0, 1))):
        return "in_intended_use must be 0, 1, or boolean"
    if not _non_empty_string(values[11]):
        return "intended_use_level must be a non-empty string"
    warnings = values[12]
    if not isinstance(warnings, list):
        return "warnings must be an array"
    for warning_index, warning in enumerate(warnings):
        if not _non_empty_string(warning):
            return f"warnings[{warning_index}] must be a non-empty string"
    return None
