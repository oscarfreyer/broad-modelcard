"""The plain-language interpreter (contract v1.14, CONTRACT.md §31).

``interpret`` turns a query such as "heart failure in older women in the
emergency department" into **chips** the reader sees and can remove before
anything is applied: an AI system, a function, up to three conditions, an
age group, a sex, an ethnicity, and a care setting. It is deterministic: the
same query, registry, axes, and search index give the same answer.

Rules, in order (each step only reads the words no earlier step took):

1. **Numbers and symbols** in the raw text: an ICD-11 code the atlas has
   ("5A11", "BA00.0") is a condition; ages ("70-year-old", "aged 30",
   "over 65", "65+", "under 18", "aged 18 to 39") give the age group whose
   range holds them; "A&E" is the emergency department.
2. **AI systems**: a run of words whose letters and digits, without spaces,
   hyphens, or dots, spell a model version or display name ("syngpt 2.0",
   "SynGPT-2.0", "Vantrel Triage 2.1"), or a family name without its
   version ("SynGPT", "Vantrel"), which means the family's newest system
   (one nothing in the registry replaces).
3. **Condition names that hold a vocabulary word**: two or more words that
   are exactly a preferred term or a synonym ("male infertility"), so "male"
   is not read as a sex there.
4. **Vocabularies**, longest phrase first (then function, setting, age, sex,
   ethnicity on a tie): function names and simple words for them
   (``FUNCTION_WORDS``), care settings (``SETTING_WORDS``), age, sex, and
   ethnicity words (``AGE_WORDS``, ``SEX_WORDS``, ``ETHNICITY_WORDS``).
5. **Conditions**: what is left is split at "and", "with", "or", "plus",
   commas, and semicolons, and at every word an earlier step took. In each
   part the longest run of words (not starting or ending with a stopword)
   that the search finds as a code or as whole words of a preferred term or
   synonym (``SearchIndex.conditions``, which compares words, so
   "heart-failure" is Heart failure) becomes a condition, its best match
   first; the rest of the part is searched again. At most three conditions.
   A single word must have three letters, not be a generic word ("disease",
   "syndrome"), and be a code, a whole preferred term or synonym, or the
   first word of a chapter or block named "<word> or …" ("epilepsy" is
   "Epilepsy or seizures"; "pain" or "chest" alone is no condition). A phrase
   inside a longer synonym does not count.
6. Words no step took and that are not stopwords are **unrecognized**.

Values: a system chip's value is the ``model_version``; a function's the
``use_case`` (with a system, one of its functions; otherwise the default
system's, else the first in registry order); an age, sex, or ethnicity
chip's the lens value (only values on the axes); a setting's the care
setting's Context axis value (CONTRACT.md §29; only the settings the axis lists);
a condition's the concept id. Two different values for one kind (two sexes,
two systems) cancel: neither becomes a chip, and their words are listed as
unrecognized. Chips are ordered by kind (system, function, condition, sex,
age, ethnicity, setting), then by position in the query.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .search import SearchIndex, words_of

KIND_ORDER = ("system", "function", "condition", "sex", "age", "ethnicity", "setting")
SINGLE_VALUED = ("system", "function", "sex", "age", "ethnicity", "setting")
MAX_CONDITIONS = 3
MAX_QUERY = 200
MAX_WINDOW = 6

AGE_GROUPS = (("Age 0-17", 0, 17), ("Age 18-39", 18, 39), ("Age 40-64", 40, 64), ("Age 65+", 65, 200))

AGE_WORDS = {
    "Age 0-17": (
        "children", "child", "paediatric", "pediatric", "paediatrics", "pediatrics", "kids", "kid", "teenager",
        "teenagers", "teens", "adolescent", "adolescents", "infant", "infants", "baby", "babies", "newborn",
        "newborns", "toddler", "toddlers", "minors", "young children",
    ),
    "Age 18-39": ("young adult", "young adults"),
    "Age 40-64": ("middle aged", "middle age", "midlife"),
    "Age 65+": (
        "older", "elderly", "the elderly", "senior", "seniors", "older adult", "older adults", "older people",
        "older patients", "geriatric", "pensioners", "retirees",
    ),
}
SEX_WORDS = {
    "Sex Female": ("women", "woman", "female", "females", "girl", "girls", "ladies"),
    "Sex Male": ("men", "man", "male", "males", "boy", "boys", "gentlemen"),
}
SEX_LABELS = {"Sex Female": "Women", "Sex Male": "Men"}
ETHNICITY_WORDS = {
    "Ethnicity White": ("white", "caucasian", "caucasians"),
    "Ethnicity Black": ("black", "african american", "african americans"),
    "Ethnicity Hispanic": ("hispanic", "hispanics", "latino", "latinos", "latina", "latinas", "latinx"),
    "Ethnicity Asian": ("asian", "asians", "south asian", "east asian"),
    "Ethnicity Other": ("other ethnicity", "other ethnicities", "mixed ethnicity"),
}
SETTING_WORDS = {
    "Emergency department": (
        "emergency", "emergency department", "emergency departments", "emergency room", "ed",
        "accident and emergency", "casualty",
    ),
    "Intensive care": ("icu", "itu", "intensive care", "intensive care unit", "critical care"),
    "Inpatient ward": ("ward", "wards", "inpatient", "inpatients", "hospital ward", "hospitalised", "hospitalized"),
    "Outpatient clinic": ("outpatient", "outpatients", "clinic", "clinics", "outpatient clinic", "ambulatory"),
    "Primary care": (
        "primary care", "gp", "gps", "general practice", "general practitioner", "family practice",
        "family doctor", "family medicine",
    ),
}
# Simple words for functions: each names the cards whose function (use case)
# contains one of the texts, or whose function category is one of the categories.
FUNCTION_WORDS = (
    (("triage",), ("triage",), ("triage",)),
    (("discharge", "discharge letter", "discharge letters", "discharge summary", "discharge summaries"), ("discharge",), ()),
    (("documentation", "scribe", "clinical notes", "note writing"), (), ("documentation",)),
    (("radiology", "imaging", "x ray", "x rays", "radiograph", "radiographs"), ("radiolog",), ()),
    (("image analysis",), (), ("image_analysis",)),
    (("skin", "skin lesion", "skin lesions", "dermatology", "moles"), ("skin",), ()),
    (("decision support", "clinical decision support", "cdss", "diagnosis support"), (), ("decision_support",)),
    (("patient communication", "patient messages"), (), ("patient_communication",)),
    (("administrative", "administration"), (), ("administrative",)),
)

STOPWORDS = frozenset(
    """a an the in on at of for to from by about among into during within who whom that which whose are is was were be
    been being have has had do does did how what when where why show shows me my our we i you please results result
    performance perform performs performing accuracy model models system systems ai tool tools patient patients people
    person persons population populations case cases care using use used setting settings data evidence evaluated
    evaluation there any all it its this these those than as treated treating diagnosed suffering presenting present
    admitted visit visits seen like such s age aged year years old does how well works work""".split()
)
SPLITTERS = frozenset(("and", "with", "or", "plus", "vs", "versus"))
GENERIC = frozenset(
    ("disease", "diseases", "disorder", "disorders", "syndrome", "syndromes", "condition", "conditions", "problem",
     "problems", "illness", "illnesses", "other", "specified", "unspecified", "chronic", "acute")
)
_SEPARATOR = re.compile(r"[,;/?!]")
_TOKEN = re.compile(r"[0-9a-z]+")
_VERSION_SUFFIX = re.compile(r"[\s_-]*v?\d+(?:\.\d+)*$", re.IGNORECASE)
_CODE = re.compile(r"(?<![0-9A-Za-z.])([0-9A-Za-z]{4}(?:\.[0-9A-Za-z]{1,4})?)(?![0-9A-Za-z])", re.ASCII)
_AGE_PATTERNS = (
    # 70-year-old, 70 year olds, 70 years of age, 70 yo, 70 y/o
    ("exact", re.compile(r"\b(\d{1,3})(?:\s*-\s*|\s+)?(?:years?|yrs?)(?:\s*-\s*|\s+)olds?\b", re.ASCII)),
    ("exact", re.compile(r"\b(\d{1,3})(?:\s*-\s*|\s+)(?:years?|yrs?)\s+of\s+age\b", re.ASCII)),
    ("exact", re.compile(r"\b(\d{1,3})\s*(?:yo|y/o)\b", re.ASCII)),
    # aged 18 to 39, ages 40-64
    ("range", re.compile(r"\b(?:aged?|ages)\s+(\d{1,3})\s*(?:-|to)\s*(\d{1,3})\b", re.ASCII)),
    # aged 65+, 65+, over 65, older than 70, at least 65
    ("from", re.compile(r"\b(?:aged?\s+)?(\d{1,3})\s*\+", re.ASCII)),
    ("above", re.compile(r"\b(?:over|above|older than)\s+(\d{1,3})\b", re.ASCII)),
    ("from", re.compile(r"\bat least\s+(\d{1,3})\b", re.ASCII)),
    # under 18, younger than 18, below 18
    ("below", re.compile(r"\b(?:under|below|younger than)\s+(\d{1,3})\b", re.ASCII)),
    # aged 30
    ("exact", re.compile(r"\baged?\s+(\d{1,3})\b", re.ASCII)),
)
_AE = re.compile(r"\ba\s*&\s*e\b", re.ASCII)


def compact(text: str) -> str:
    """Letters and digits only, lower case: "SynGPT-2.0" and "syngpt 2.0" are both "syngpt20"."""
    return "".join(_TOKEN.findall(text.lower()))


def age_group(low: int, high: int) -> str | None:
    """The age group whose range holds ``low``–``high`` (both included), or None."""
    for value, start, end in AGE_GROUPS:
        if start <= low and high <= end:
            return value
    return None


@dataclass(frozen=True)
class SystemEntry:
    model_version: str
    label: str
    use_cases: tuple[str, ...]
    categories: tuple[str | None, ...]


def _name_keys(name: str) -> tuple[str, list[str]]:
    """A name's exact key and its family keys: without the version, and its first word (four letters or more)."""
    keys = []
    stem = compact(_VERSION_SUFFIX.sub("", name))
    if len(stem) >= 4:
        keys.append(stem)
    words = name.replace("_", " ").replace("-", " ").split()
    first = compact(words[0]) if words else ""
    if len(first) >= 4 and not first.isdigit():
        keys.append(first)
    return compact(name), keys


@dataclass
class Vocabulary:
    """What the interpreter can recognize for one dataset version: the registry and the lens axes."""

    systems: tuple[SystemEntry, ...]
    default_model_version: str | None
    ages: tuple[str, ...]
    sexes: tuple[str, ...]
    ethnicities: tuple[str, ...]
    settings: tuple[str, ...]  # the care settings of the Context axis (§29)
    # Model versions another system of the registry replaces (contract v1.14, §28.2).
    replaced: frozenset[str] = frozenset()
    _names: dict[str, SystemEntry | None] = field(default_factory=dict, init=False, repr=False)

    def __post_init__(self) -> None:
        exact: dict[str, list[SystemEntry]] = {}
        families: dict[str, list[SystemEntry]] = {}
        # A family's newest system comes last: replaced systems first, registry order within.
        ordered = [system for system in self.systems if system.model_version in self.replaced]
        ordered += [system for system in self.systems if system.model_version not in self.replaced]
        for system in ordered:
            for name in (system.model_version, system.label):
                key, family_keys = _name_keys(name)
                if system not in exact.setdefault(key, []):
                    exact[key].append(system)
                for family_key in family_keys:
                    if system not in families.setdefault(family_key, []):
                        families[family_key].append(system)
        # An exact name names one system (two systems with one name name none).
        self._names = {key: entries[0] if len(entries) == 1 else None for key, entries in exact.items()}
        for key, entries in families.items():
            self._names.setdefault(key, entries[-1])

    def system_named(self, text: str) -> SystemEntry | None:
        return self._names.get(compact(text))

    def by_version(self, model_version: str) -> SystemEntry | None:
        return next((system for system in self.systems if system.model_version == model_version), None)

    def function_cards(self, texts: tuple[str, ...], categories: tuple[str, ...]) -> list[tuple[SystemEntry, str]]:
        """The cards whose function contains one of ``texts`` or whose category is one of ``categories``, in registry order."""
        cards = []
        for system in self.systems:
            for use_case, category in zip(system.use_cases, system.categories):
                name = use_case.lower()
                if any(text in name for text in texts) or (category is not None and category in categories):
                    cards.append((system, use_case))
        return cards

    def use_case_names(self) -> list[str]:
        seen: list[str] = []
        for system in self.systems:
            for use_case in system.use_cases:
                if use_case not in seen:
                    seen.append(use_case)
        return seen

    def prompt_lists(self) -> dict:
        """The vocabularies the optional helper may choose from (§20, §31): names only, no data."""
        return {
            "system": [{"value": system.model_version, "name": system.label} for system in self.systems],
            "function": self.use_case_names(),
            "age": list(self.ages),
            "sex": list(self.sexes),
            "ethnicity": list(self.ethnicities),
            "setting": list(self.settings),
        }


def vocabulary_of(registry, axes) -> Vocabulary:
    """The vocabulary of a registry (``RegistryRecord``) and lens axes (``Axes``)."""
    models = list(registry.models)
    return Vocabulary(
        systems=tuple(
            SystemEntry(
                model.model_version,
                model.display_name or model.model_version,
                tuple(use_case.use_case for use_case in model.use_cases),
                tuple(use_case.function_category for use_case in model.use_cases),
            )
            for model in models
        ),
        default_model_version=registry.default_model_version or (models[0].model_version if models else None),
        ages=tuple(value for value in axes.age if not value.startswith("All")),
        sexes=tuple(value for value in axes.sex if not value.startswith("All")),
        ethnicities=tuple(value for value in axes.ethnicity if not value.startswith("All")),
        # The specific care settings: the Context axis after its first value, Clinical (Any setting, §29).
        settings=tuple(axes.context[1:]),
        replaced=frozenset(model.model_version for model in models if model.replaced_by),
    )


# ------------------------------------------------------------------ tokens

@dataclass
class _Token:
    text: str
    start: int
    end: int
    taken: bool = False


@dataclass
class _Chip:
    kind: str
    value: str
    label: str
    start: int
    end: int
    extra: dict = field(default_factory=dict)


def _tokens(text: str) -> list[_Token]:
    return [_Token(match.group(0), match.start(), match.end()) for match in _TOKEN.finditer(text)]


def _covered(tokens: list[_Token], start: int, end: int) -> list[int]:
    return [index for index, token in enumerate(tokens) if token.start >= start and token.end <= end]


def _phrase(tokens: list[_Token], first: int, last: int) -> str:
    return " ".join(token.text for token in tokens[first : last + 1])


def _free(tokens: list[_Token], first: int, last: int) -> bool:
    return all(not tokens[index].taken for index in range(first, last + 1))


def _take(tokens: list[_Token], first: int, last: int) -> None:
    for index in range(first, last + 1):
        tokens[index].taken = True


def _windows(count: int, longest: int):
    """(first, last) token windows, longest first, then left to right."""
    for size in range(min(longest, count), 0, -1):
        for first in range(0, count - size + 1):
            yield first, first + size - 1


def _phrase_table(groups: dict[str, tuple[str, ...]]) -> dict[str, str]:
    table = {}
    for value, phrases in groups.items():
        for phrase in phrases:
            table.setdefault(" ".join(words_of(phrase.lower())), value)
    return table


_AGE_TABLE = _phrase_table(AGE_WORDS)
_SEX_TABLE = _phrase_table(SEX_WORDS)
_ETHNICITY_TABLE = _phrase_table(ETHNICITY_WORDS)
_SETTING_TABLE = _phrase_table(SETTING_WORDS)
_FUNCTION_TABLE = {" ".join(words_of(phrase)): (texts, categories) for phrases, texts, categories in FUNCTION_WORDS for phrase in phrases}


# -------------------------------------------------------------- interpreter

def condition_concept(match, catalog) -> str:
    """The concept a condition chip names. A synonym names its ICD-11 concept as a whole, so a
    subcategory found by one opens as its condition (the depth-1 concept whose result it
    shares, CONTRACT.md §5): "heart attack" (BA41.Z) is BA41 "Acute myocardial infarction"."""
    if match.match != "synonym" or catalog is None:
        return match.concept_id
    record = catalog.record(match.concept_id)
    if (record.get("depth_in_kind") or 1) > 1 and record.get("metric_anchor_id"):
        return record["metric_anchor_id"]
    return match.concept_id


def interpret(query: str, vocabulary: Vocabulary, index: SearchIndex, catalog=None) -> dict:
    """The interpretation of a trimmed query: ``{query, chips, unrecognized}`` (CONTRACT.md §31)."""
    text = " ".join(query.split())[:MAX_QUERY]
    # Lower case character by character, so positions in ``lower`` are positions in ``text``.
    lower = "".join(char.lower() if len(char.lower()) == 1 else char for char in text)
    tokens = _tokens(lower)
    chips: list[_Chip] = []
    leftovers: list[tuple[int, int]] = []

    def add(kind: str, value: str, label: str, first: int, last: int, span: tuple[int, int] | None = None, **extra) -> None:
        start, end = span or (tokens[first].start, tokens[last].end)
        chips.append(_Chip(kind, value, label, start, end, extra))
        _take(tokens, first, last)

    def lift(match) -> str:
        return condition_concept(match, catalog)

    # At most three distinct conditions (§31.2): a repeat takes its words without a chip,
    # and a further condition is unrecognized.
    condition_values: set[str] = set()

    def add_condition(value: str, first: int, last: int, **extra) -> None:
        if value in condition_values:
            _take(tokens, first, last)
        elif len(condition_values) >= MAX_CONDITIONS:
            leftovers.append((first, last))
            _take(tokens, first, last)
        else:
            condition_values.add(value)
            add("condition", value, "", first, last, **extra)

    # 1. Codes, ages, and A&E in the raw text.
    for match in _CODE.finditer(text):
        code = match.group(1)
        # ICD-11 codes have a digit third ("5A11", "BA00"); words of four letters never match.
        if not code[2].isdigit():
            continue
        concept_id = index.code_match(code)
        covered = _covered(tokens, match.start(1), match.end(1))
        if concept_id is None or not covered or not _free(tokens, covered[0], covered[-1]):
            continue
        add_condition(concept_id, covered[0], covered[-1], match="code")
    for kind, pattern in _AGE_PATTERNS:
        for match in pattern.finditer(lower):
            covered = _covered(tokens, match.start(), match.end())
            if not covered or not _free(tokens, covered[0], covered[-1]):
                continue
            numbers = [int(group) for group in match.groups() if group is not None]
            low, high = {
                "exact": lambda: (numbers[0], numbers[0]),
                "range": lambda: (min(numbers), max(numbers)),
                "from": lambda: (numbers[0], 200),
                "above": lambda: (numbers[0] + 1, 200),
                "below": lambda: (0, max(0, numbers[0] - 1)),
            }[kind]()
            value = age_group(low, high)
            if value is not None and value in vocabulary.ages:
                add("age", value, value, covered[0], covered[-1], span=(match.start(), match.end()))
            else:
                leftovers.append((covered[0], covered[-1]))
                _take(tokens, covered[0], covered[-1])
    for match in _AE.finditer(lower):
        covered = _covered(tokens, match.start(), match.end())
        if covered and _free(tokens, covered[0], covered[-1]) and "Emergency department" in vocabulary.settings:
            add("setting", "Emergency department", "Emergency department", covered[0], covered[-1], span=(match.start(), match.end()))

    # 2. AI systems.
    for first, last in _windows(len(tokens), MAX_WINDOW):
        if not _free(tokens, first, last):
            continue
        system = vocabulary.system_named("".join(token.text for token in tokens[first : last + 1]))
        if system is not None:
            add("system", system.model_version, system.label, first, last)

    # 3. Condition names (two or more words) that are exactly a preferred term or a synonym.
    for first, last in _windows(len(tokens), MAX_WINDOW):
        if last == first or not _free(tokens, first, last):
            continue
        if tokens[first].text in STOPWORDS or tokens[last].text in STOPWORDS:
            continue
        if not any(tokens[i].text in _VOCABULARY_WORDS for i in range(first, last + 1)):
            continue
        best = index.conditions(lower[tokens[first].start : tokens[last].end], limit=1)
        # Only an exact name counts here: the first match is exact when its words are the phrase's.
        if best and best[0].matched_term is not None and words_of(best[0].matched_term.lower()) == words_of(_phrase(tokens, first, last)):
            add_condition(lift(best[0]), first, last, match=best[0].match, matched_term=best[0].matched_term)

    # 4. Functions, settings, and the lens words, longest first.
    tables = (
        ("function", _FUNCTION_TABLE),
        ("setting", _SETTING_TABLE),
        ("age", _AGE_TABLE),
        ("sex", _SEX_TABLE),
        ("ethnicity", _ETHNICITY_TABLE),
    )
    use_case_names = {" ".join(words_of(name.lower())): name for name in vocabulary.use_case_names()}
    for first, last in _windows(len(tokens), MAX_WINDOW):
        if not _free(tokens, first, last):
            continue
        phrase = _phrase(tokens, first, last)
        if phrase in use_case_names:
            add("function", use_case_names[phrase], use_case_names[phrase], first, last, exact=True)
            continue
        for kind, table in tables:
            if phrase not in table:
                continue
            if kind == "function":
                add("function", "", "", first, last, words=table[phrase])
            elif kind == "setting":
                if table[phrase] in vocabulary.settings:
                    add("setting", table[phrase], table[phrase], first, last)
            else:
                allowed = {"age": vocabulary.ages, "sex": vocabulary.sexes, "ethnicity": vocabulary.ethnicities}[kind]
                if table[phrase] in allowed:
                    label = SEX_LABELS.get(table[phrase]) or table[phrase].removeprefix("Ethnicity ")
                    add(kind, table[phrase], label, first, last)
            break

    # 5. Conditions in what is left.
    for segment in _segments(text, tokens):
        _segment_conditions(segment, lower, tokens, index, lambda match, first, last: add_condition(
            lift(match), first, last, match=match.match, matched_term=match.matched_term))

    # Functions: resolve simple words to a use case (with the system's, when one system is named).
    systems = {chip.value for chip in chips if chip.kind == "system"}
    system = vocabulary.by_version(next(iter(systems))) if len(systems) == 1 else None
    resolved = []
    for chip in chips:
        if chip.kind != "function":
            resolved.append(chip)
            continue
        use_case = _function_value(chip, system, vocabulary)
        if use_case is None:
            leftovers.append(_span_tokens(tokens, chip))
            continue
        chip.value, chip.label = use_case, use_case
        resolved.append(chip)
    chips = resolved

    # Two different values for one kind cancel.
    final: list[_Chip] = []
    for kind in SINGLE_VALUED:
        of_kind = [chip for chip in chips if chip.kind == kind]
        values = {chip.value for chip in of_kind}
        if len(values) > 1:
            leftovers.extend(_span_tokens(tokens, chip) for chip in of_kind)
        elif of_kind:
            final.append(of_kind[0])
    final.extend(chip for chip in chips if chip.kind == "condition")
    final.sort(key=lambda chip: (KIND_ORDER.index(chip.kind), chip.start))

    return {
        "query": text,
        "chips": [_chip_body(chip, text, catalog) for chip in final],
        "unrecognized": _unrecognized(text, tokens, leftovers),
    }


_VOCABULARY_WORDS = frozenset(
    word
    for table in (_AGE_TABLE, _SEX_TABLE, _ETHNICITY_TABLE, _SETTING_TABLE, _FUNCTION_TABLE)
    for phrase in table
    for word in phrase.split()
)


def _span_tokens(tokens: list[_Token], chip: _Chip) -> tuple[int, int]:
    covered = _covered(tokens, chip.start, chip.end)
    return (covered[0], covered[-1])


def _function_value(chip: _Chip, system: SystemEntry | None, vocabulary: Vocabulary) -> str | None:
    if chip.extra.get("exact"):
        if system is None or chip.value in system.use_cases:
            return chip.value
        return None
    texts, categories = chip.extra["words"]
    cards = vocabulary.function_cards(texts, categories)
    if system is not None:
        cards = [card for card in cards if card[0].model_version == system.model_version]
    elif vocabulary.default_model_version:
        cards.sort(key=lambda card: 0 if card[0].model_version == vocabulary.default_model_version else 1)
    return cards[0][1] if cards else None


def _segments(text: str, tokens: list[_Token]) -> list[list[int]]:
    """Runs of free tokens, split at taken tokens, splitter words, and separators in the text."""
    segments: list[list[int]] = []
    current: list[int] = []
    for index, token in enumerate(tokens):
        if index and _SEPARATOR.search(text[tokens[index - 1].end : token.start]):
            if current:
                segments.append(current)
            current = []
        if token.taken or token.text in SPLITTERS:
            if current:
                segments.append(current)
            current = []
            continue
        current.append(index)
    if current:
        segments.append(current)
    return segments


def named_conditions(index: SearchIndex, words: list[str], phrase: str) -> list:
    """Step 5's rules for a phrase as a condition (§31.2, also the helper's check, §31.3): no
    stopword at either end; a single word has three letters or more, is not a generic word
    ("disease", "other"), and must name a concept exactly."""
    if not words or words[0] in STOPWORDS or words[-1] in STOPWORDS:
        return []
    if len(words) == 1 and (len(words[0]) < 3 or words[0] in GENERIC):
        return []
    return index.conditions(phrase, limit=1, exact_only=len(words) == 1)


def _segment_conditions(segment: list[int], lower: str, tokens, index: SearchIndex, take) -> None:
    """Find conditions in one run of free tokens, longest run of words first; ``take(match, first, last)`` keeps each."""
    if not segment:
        return
    for size in range(min(len(segment), MAX_WINDOW), 0, -1):
        for offset in range(0, len(segment) - size + 1):
            window = segment[offset : offset + size]
            first, last = window[0], window[-1]
            words = [tokens[i].text for i in window]
            matches = named_conditions(index, words, lower[tokens[first].start : tokens[last].end])
            if not matches:
                continue
            take(matches[0], first, last)
            _segment_conditions(segment[:offset], lower, tokens, index, take)
            _segment_conditions(segment[offset + size :], lower, tokens, index, take)
            return


def _unrecognized(text: str, tokens: list[_Token], leftovers: list[tuple[int, int]]) -> list[str]:
    """Words no step took (not stopwords or splitters), and the words of cancelled chips, as runs in query order."""
    marked = set()
    for first, last in leftovers:
        marked.update(range(first, last + 1))
    runs: list[tuple[int, int]] = []
    for position, token in enumerate(tokens):
        unknown = position in marked or (not token.taken and token.text not in STOPWORDS and token.text not in SPLITTERS)
        if not unknown:
            continue
        if runs and runs[-1][1] == position - 1 and not _SEPARATOR.search(text[tokens[position - 1].end : token.start]):
            runs[-1] = (runs[-1][0], position)
        else:
            runs.append((position, position))
    return [text[tokens[first].start : tokens[last].end] for first, last in runs]


def _chip_body(chip: _Chip, text: str, catalog) -> dict:
    body = {"kind": chip.kind, "value": chip.value, "label": chip.label, "matched_text": text[chip.start : chip.end]}
    if chip.kind == "condition" and catalog is not None:
        record = catalog.record(chip.value)
        # Residual categories carry a leading "- " in their preferred term; the label leaves it out.
        body["label"] = record["pt"].lstrip("- ").strip()
        body["code"] = record.get("icd11_code") or record["concept_id"]
        body["pt"] = record["pt"]
        body["match"] = chip.extra.get("match", "term")
        if body["match"] == "synonym" and chip.extra.get("matched_term"):
            body["matched_term"] = chip.extra["matched_term"]
        body["concept"] = record
    return body
