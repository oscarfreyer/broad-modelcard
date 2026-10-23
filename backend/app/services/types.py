"""Value types shared by the derivation services."""

from __future__ import annotations

from dataclasses import dataclass

from ..schema.contract import AGE_ALL, ANY_SETTING, ETHNICITY_ALL, SEX_ALL
from .errors import InvalidLens


@dataclass(frozen=True, slots=True)
class Lens:
    age: str = AGE_ALL
    sex: str = SEX_ALL
    ethnicity: str = ETHNICITY_ALL
    # Contract v1.14 (CONTRACT.md §29): the care setting, a value of the
    # Context axis. ``Clinical`` (Any setting) holds every row stored before; a
    # specific setting reads only the rows stored for it. Part of every
    # per-lens cache key, but not of ``as_dict`` or ``label``, which keep their
    # shapes (responses name the setting as ``context``).
    setting: str = ANY_SETTING

    @property
    def label(self) -> str:
        """The reference client's lens label, ``"age | sex | ethnicity"``."""
        return f"{self.age} | {self.sex} | {self.ethnicity}"

    def as_dict(self) -> dict:
        return {"age": self.age, "sex": self.sex, "ethnicity": self.ethnicity}

    @property
    def is_any_setting(self) -> bool:
        return self.setting == ANY_SETTING

    def all_patients(self) -> "Lens":
        """The all-population lens at this lens's setting (§29: nothing crosses settings)."""
        return Lens(setting=self.setting)

    def group(self, axis: str, value: str) -> "Lens":
        """The one-group lens ``axis`` = ``value`` at this lens's setting, the other axes at All."""
        values = {"age": AGE_ALL, "sex": SEX_ALL, "ethnicity": ETHNICITY_ALL, axis: value}
        return Lens(values["age"], values["sex"], values["ethnicity"], self.setting)


ALL_POPULATIONS = Lens()

# How many lenses the per-card caches keep (rows, safety marks). More than the
# 12 lenses one Across groups read visits (all patients and the 11 one-group
# lenses, CONTRACT.md §24), plus the reader's own lens: with 8, a sequential
# pass over 12 lenses evicted every lens before it was needed again.
LENS_CACHE_SIZE = 16


@dataclass(frozen=True, slots=True)
class Axes:
    """Metric axes in source order (context, age, sex, ethnicity).

    Since contract v1.14 (§29) the context axis lists Any setting (``Clinical``)
    and then the specific care settings. A lens combination's index is
    ``setting_idx × per_setting + age_idx×18 + sex_idx×6 + eth_idx``, so every
    Any-setting combination keeps the index it had (0–89)."""

    context: tuple[str, ...]
    age: tuple[str, ...]
    sex: tuple[str, ...]
    ethnicity: tuple[str, ...]

    @property
    def per_setting(self) -> int:
        """Lens combinations per setting (90)."""
        return len(self.age) * len(self.sex) * len(self.ethnicity)

    def combo_index(self, lens: Lens) -> int:
        """``setting_idx×90 + age_idx×18 + sex_idx×6 + eth_idx`` (CONTRACT.md §4.1, §29)."""
        self.validate(lens)
        return (
            self.context.index(lens.setting) * self.per_setting
            + self.age.index(lens.age) * len(self.sex) * len(self.ethnicity)
            + self.sex.index(lens.sex) * len(self.ethnicity)
            + self.ethnicity.index(lens.ethnicity)
        )

    def lens_for_index(self, combo_idx: int) -> Lens:
        setting_idx, combo_idx = divmod(combo_idx, self.per_setting)
        per_age = len(self.sex) * len(self.ethnicity)
        age_idx, rest = divmod(combo_idx, per_age)
        sex_idx, eth_idx = divmod(rest, len(self.ethnicity))
        return Lens(self.age[age_idx], self.sex[sex_idx], self.ethnicity[eth_idx], self.context[setting_idx])

    def setting_of_index(self, combo_idx: int) -> str:
        """The setting (a Context axis value) of a lens combination."""
        return self.context[combo_idx // self.per_setting]

    def settings_of(self, combos) -> list[str]:
        """The settings that the lens combinations ``combos`` belong to, in axis order (Any setting first)."""
        found = {combo_idx // self.per_setting for combo_idx in combos}
        return [value for position, value in enumerate(self.context) if position in found]

    def setting_combos(self, combos, setting: str = ANY_SETTING) -> frozenset[int]:
        """The lens combinations among ``combos`` that belong to ``setting``."""
        position = self.context.index(setting)
        return frozenset(combo_idx for combo_idx in combos if combo_idx // self.per_setting == position)

    def all_lenses(self, setting: str = ANY_SETTING) -> list[Lens]:
        """Every lens combination of one setting (Any setting by default), in index order."""
        return [Lens(age, sex, eth, setting) for age in self.age for sex in self.sex for eth in self.ethnicity]

    def validate(self, lens: Lens) -> None:
        for axis, value, allowed in (
            ("age", lens.age, self.age),
            ("sex", lens.sex, self.sex),
            ("ethnicity", lens.ethnicity, self.ethnicity),
        ):
            if value not in allowed:
                raise InvalidLens(f"Unknown {axis} lens {value!r}; expected one of {', '.join(allowed)}.")
        if lens.setting not in self.context:
            raise InvalidLens(f"Unknown setting {lens.setting!r}; expected one of {', '.join(self.context)}.")


@dataclass(frozen=True, slots=True)
class Concept:
    concept_id: str
    parent_id: str | None
    level: int
    chapter_id: str
    chapter_no: str | None
    block_id: str | None
    pt: str
    fsn: str | None
    icd11_code: str | None
    sort_order: int | None
    depth_in_kind: int | None
    metric_anchor_id: str | None
    is_top_level_condition: bool
    prevalence_tier: str | None
    # Score used by the derivations: the tier score for level-2 concepts, else
    # the source value (null for blocks and chapters).
    prevalence_score: float | None

    @property
    def depth(self) -> int:
        """``conceptDepthInKind``: missing or non-positive depths count as 1."""
        return self.depth_in_kind if self.depth_in_kind and self.depth_in_kind > 0 else 1


@dataclass(frozen=True, slots=True)
class Rollup:
    child_count: int
    aggregation: str  # 'p20' | 'weighted_mean'


@dataclass(frozen=True, slots=True)
class Provenance:
    source: str  # 'condition' | 'anchor' | 'rollup' | 'multimorbidity'
    lens_fallback: bool = False
    anchor_concept_id: str | None = None
    rollup: Rollup | None = None
    # Contract v1.13 (CONTRACT.md §26): "local" for a row served from a
    # hospital's local evaluation results (a read that names the population);
    # None for every public row, which keeps its exact shape.
    layer: str | None = None


@dataclass(frozen=True, slots=True)
class MetricValues:
    """A normalized metric row (CONTRACT.md §4.1), before presentation.

    Field names and values match the reference client's metric rows.
    """

    concept_id: str
    lens: Lens
    perf: float | None
    ci_low: float | None
    ci_high: float | None
    evidence_grade: str | None
    n_samples: int | None
    n_sites: int | None
    n_studies: int | None
    peer_reviewed_studies: int | None
    validation_type: str | None
    # None when the row has no intended-use value (contract v1.11): the card
    # has no intended-use statement, or the row gives none.
    in_intended_use: bool | None
    intended_use_coverage: float | None
    intended_use_level: str | None
    warnings: tuple[str, ...]
    provenance: Provenance
    # Derived evidence signal (penalties applied) when the grade was derived.
    evidence_signal: float | None = None
    # Multimorbidity rows only.
    condition_ids: tuple[str, ...] | None = None
    combination_label: str | None = None
    # Aggregated rows only (rollups §6, several-row lens fallback §7): how many
    # of the ``warning_total`` aggregated rows carry each warning code. Codes
    # that describe the aggregate itself (``conservative_rollup_p20``) have no
    # entry. None on stored rows (contract v1.4, ``Warning.share``).
    warning_counts: tuple[tuple[str, int], ...] | None = None
    warning_total: int | None = None
    # Contract v1.13 (CONTRACT.md §22). A stored row linked to a study record:
    # the study's id and its change to the evidence signal. An aggregated row
    # (rollup, several-row lens fallback) carries no id and the mean
    # adjustment of its rows when that is not 0. None on every other row.
    study_id: str | None = None
    study_adjustment: float | None = None
