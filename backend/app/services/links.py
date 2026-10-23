"""Links into the atlas, as the frontend writes them (frontend/src/app/startupParams.js).

``atlas_url`` builds ``atlas.html?…`` relative to the frontend root with the
atlas URL parameters (``version``, ``model``, ``use_case``, ``view``, ``age``,
``sex``, ``ethnicity``, ``setting`` (v1.14, the care setting's code), ``population``, ``mode``, ``depth``, ``chapter``,
``concept``, ``selected``), in the order ``atlasSearch`` writes them, encoded
like ``URLSearchParams`` and then made readable like ``readableSearch`` (commas
and colons unescaped). Lens values "All …" and empty values are left out, and
``version`` only appears for a staged read. Since contract v1.10 a link for a
local population ends with ``population=<id>`` (CONTRACT.md §21), after the
other parameters. ``depth`` is never written: the atlas opens the link at its
mode's default explanation depth.

A link that reports figures names their ``view`` (e.g. ``view=overall``):
the atlas then treats it as its own state and opens it under the prevalence
it names (the default when none) for every reader, never under a reader's
default population (frontend/src/app/profileDefaults.js, CONTRACT.md §19).
"""

from __future__ import annotations

from urllib.parse import quote_plus

from ..schema.contract import AGE_ALL, CARE_SETTING_CODES, ETHNICITY_ALL, SEX_ALL
from .types import Lens

ATLAS_PAGE = "atlas.html"
_ALL = {"age": AGE_ALL, "sex": SEX_ALL, "ethnicity": ETHNICITY_ALL}


def _form_encode(value: str) -> str:
    """``URLSearchParams`` serialization: ``*-._`` and alphanumerics stay, space is ``+``."""
    return quote_plus(value, safe="*").replace("~", "%7E")


def _readable(query: str) -> str:
    return query.replace("%2C", ",").replace("%3A", ":")


def atlas_url(
    *,
    version: str | None = None,
    model: str | None = None,
    use_case: str | None = None,
    view: str | None = None,
    lens: Lens | None = None,
    mode: str | None = None,
    chapter_id: str | None = None,
    concept_id: str | None = None,
    selected: list[str] | tuple[str, ...] = (),
    population: str | None = None,
) -> str:
    params: list[tuple[str, str]] = []
    if version and version != "live":
        params.append(("version", version))
    params += [("model", model or ""), ("use_case", use_case or ""), ("view", view or "")]
    if lens is not None:
        for axis, value in lens.as_dict().items():
            if value != _ALL[axis]:
                params.append((axis, value))
        if not lens.is_any_setting:
            # Contract v1.14 (§29): a specific care setting by its code; Any setting is left out.
            params.append(("setting", CARE_SETTING_CODES[lens.setting]))
    params += [("mode", mode or ""), ("chapter", chapter_id or ""), ("concept", concept_id or "")]
    if selected:
        params.append(("selected", ",".join(selected)))
    if population:
        params.append(("population", population))
    query = "&".join(f"{name}={_form_encode(value)}" for name, value in params if value)
    return f"{ATLAS_PAGE}?{_readable(query)}" if query else ATLAS_PAGE
