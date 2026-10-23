"""JavaScript-compatible numeric and string helpers.

The derivations must reproduce the reference client (tag v0.2.0-alpha.1)
exactly, so rounding, truthiness, and ordering follow JavaScript semantics
rather than Python's defaults:

* ``js_round`` is ``Math.round`` (halves round toward +infinity), not banker's
  rounding.
* ``to_fixed`` is ``Number(x.toFixed(digits))``: decimal rounding of the exact
  binary value, halves away from zero.
* ``is_finite`` is ``Number.isFinite``: numbers only, never strings or booleans.
* ``locale_sort_key`` approximates ``String.prototype.localeCompare`` under the
  ICU root collation used by browsers and Node for English locales.
"""

from __future__ import annotations

import math
import unicodedata
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Iterable, Sequence


def is_finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def js_truthy(value: Any) -> bool:
    if value is None or value is False:
        return False
    if isinstance(value, (int, float)):
        return value != 0 and not math.isnan(value)
    if isinstance(value, str):
        return value != ""
    return True


def js_round(value: float) -> int:
    floor = math.floor(value)
    return floor + 1 if value - floor >= 0.5 else floor


def to_fixed(value: float, digits: int = 3) -> float:
    quantum = Decimal(1).scaleb(-digits)
    return float(Decimal(value).quantize(quantum, rounding=ROUND_HALF_UP))


def clamp(value: float, low: float = 0, high: float = 1) -> float:
    return min(high, max(low, value))


def weighted_mean(values: Sequence[float], weights: Sequence[float]) -> float:
    if not values:
        return 0
    weighted_total = 0.0
    weight_total = 0.0
    for index, value in enumerate(values):
        weight = weights[index] if index < len(weights) and weights[index] is not None else 0
        weighted_total += value * weight
        weight_total += weight
    return weighted_total / weight_total if weight_total > 0 else 0


def mean(values: Sequence[float]) -> float:
    """``weightedMean(values, values.map(() => 1))``."""
    return weighted_mean(values, [1] * len(values))


def percentile(values: Iterable[float], p: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0
    position = (len(ordered) - 1) * clamp(p, 0, 1)
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    blend = position - lower
    return ordered[lower] * (1 - blend) + ordered[upper] * blend


# ICU root collation (CLDR, alternate = non-ignorable): whitespace, then
# punctuation and symbols in this order, then digits, then letters. Letters
# compare case- and accent-insensitively first; accents break ties next, and
# lowercase sorts before uppercase last.
_VARIABLE_ORDER = "\t\n\v\f\r _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$"
_PRIMARY_RANK = {char: rank for rank, char in enumerate(_VARIABLE_ORDER)}
_DIGIT_BASE = len(_VARIABLE_ORDER)
_LETTER_BASE = _DIGIT_BASE + 10
_EXPANSIONS = {"ß": "ss", "æ": "ae", "Æ": "AE", "œ": "oe", "Œ": "OE", "ø": "o", "Ø": "O"}


def _primary_weight(char: str) -> int:
    if char in _PRIMARY_RANK:
        return _PRIMARY_RANK[char]
    if "0" <= char <= "9":
        return _DIGIT_BASE + ord(char) - ord("0")
    lower = char.lower()
    if "a" <= lower <= "z":
        return _LETTER_BASE + ord(lower) - ord("a")
    # Other characters sort after Latin letters, by code point.
    return _LETTER_BASE + 26 + ord(lower)


def locale_sort_key(text: str) -> tuple:
    primary: list[int] = []
    secondary: list[str] = []
    tertiary: list[int] = []
    for char in unicodedata.normalize("NFD", "".join(_EXPANSIONS.get(c, c) for c in text)):
        if unicodedata.combining(char):
            if secondary:
                secondary[-1] += char
            continue
        primary.append(_primary_weight(char))
        secondary.append("")
        tertiary.append(1 if char.isupper() else 0)
    return (tuple(primary), tuple(secondary), tuple(tertiary))
