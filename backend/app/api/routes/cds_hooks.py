"""A local CDS Hooks–shaped service (contract v1.14, CONTRACT.md §33).

* ``GET /cds-services`` (discovery): one service, ``bmc-condition-status``, on
  the ``patient-view`` hook, with prefetch templates for the patient and their
  conditions.
* ``POST /cds-services/bmc-condition-status``: a CDS Hooks 2.0 request whose
  prefetch holds a FHIR ``Patient`` (``birthDate``, ``gender``) and a FHIR
  ``Bundle`` of ``Condition`` resources coded in ICD-11 MMS or ICD-10-CM. Each
  condition becomes one CDS card with what the atlas shows for it on one card
  (the §19 lookup at a coarse lens from age and sex): its status in words, top
  warnings, safeguards, open incidents, and an absolute atlas link.

The JSON is parsed by hand (no FHIR library): only the fields named above are
read, everything else is ignored, and a malformed request is 400 with a plain
message that never repeats what was sent. ICD-10-CM codes reach ICD-11 through
the §23 crosswalk of the imported ICD-10-CM classification. Like ``lookup``,
nothing of a request is stored, cached, or logged, and responses carry
``Cache-Control: no-store``. The local-only guard (§16) applies and no CORS
headers are sent, so only this machine's own pages and tools can call it.
**Demonstration on synthetic data, not for clinical use**; every card says so.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import date

from fastapi import APIRouter, Request
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool

from ...repository import MissingData
from ...schema.contract import CARE_SETTINGS, CDS_SYNTHETIC_LINE, POPULATION_ID_PATTERN, SYNTHETIC_DATA_NOTICE
from ...services.errors import ServiceError, UnknownModel, UnknownUseCase
from ..params import Version
from ..problems import ApiError
from ..responses import DATASET_VERSION_HEADER, api_of, encode, population_headers
from ..schemas import CDS_REQUEST_SCHEMA, CdsResponse, CdsServices, LookupPopulation
from ..store import VersionContext
from .lookup import _Card, lens_from_population
from .meta import default_model_version
from . import problems

router = APIRouter(tags=["cds-hooks"])
log = logging.getLogger("broad_modelcard.api")

SERVICE_ID = "bmc-condition-status"
HOOK = "patient-view"
ICD11_SYSTEM = "http://id.who.int/icd/release/11/mms"
ICD10CM_SYSTEM = "http://hl7.org/fhir/sid/icd-10-cm"
SOURCE_LABEL = "Broad Modelcard (synthetic demonstration)"
MAX_CONDITIONS = 12
MAX_BODY_BYTES = 64 * 1024
EXTENSION = "broad-modelcard"
_CODE = re.compile(r"^[A-Za-z0-9.]{1,16}$")
_BIRTH_DATE = re.compile(r"^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$")
_POPULATION_ID = re.compile(POPULATION_ID_PATTERN)
_GENDERS = {"female": "female", "male": "male", "other": None, "unknown": None}

STATUS_WORDS = {"strong": "Strong", "moderate": "Moderate", "weak": "Weak", "no_data": "No data", "out_of_scope": "Out of scope"}
INTENDED_USE_WORDS = {"in_scope": "In scope", "partially_in_scope": "Partly in scope", "out_of_scope": "Out of scope"}
# Short titles of the warning codes and safeguards (the frontend's copy, warningCopy.js and safeguardCopy.js).
WARNING_WORDS = {
    "out_of_scope_group": "Outside intended use",
    "clinician_review_required": "Clinician review required",
    "performance_below_target": "Performance below target",
    "no_performance_data": "Performance data unavailable",
    "no_validation_data": "Validation evidence unavailable",
    "wide_confidence_interval": "High uncertainty",
    "limited_validation_depth": "Limited validation depth",
    "rare_condition_low_support": "Limited support for rare conditions",
    "mental_disorders_high_variance": "Higher variance in this chapter",
    "conservative_rollup_p20": "Conservative aggregate estimate",
}
SAFEGUARD_WORDS = {
    "scope-stop": "Block unsupported use",
    "scope-partial": "Use with eligibility checks",
    "perf-missing": "Collect local performance evidence",
    "perf-low": "Require human confirmation before action",
    "ci-wide": "Tighten uncertainty monitoring",
    "evidence-weak": "Strengthen validation depth",
    "evidence-missing": "Validate before relying on it",
    "overall-weak": "Review before relying on it",
    "cdss-governance": "Maintain clinician-in-the-loop governance",
    "standard-monitoring": "Continue standard monitoring",
}
NO_STORE = {"Cache-Control": "no-store"}


class CdsError(Exception):
    """A malformed request (400); the message names the field, never the value sent."""


@dataclass(frozen=True)
class Coding:
    system: str | None  # ICD11_SYSTEM, ICD10CM_SYSTEM, or None (no coding this service reads)
    code: str | None
    display: str | None


@dataclass(frozen=True)
class CdsRequest:
    patient_age_group: str | None
    patient_sex: str | None
    conditions: tuple[Coding, ...]
    card_id: str | None
    setting: str | None
    population: str | None


# ---------------------------------------------------------------- parsing

def _object(value, field: str, *, required: bool = True) -> dict | None:
    if value is None and not required:
        return None
    if not isinstance(value, dict):
        raise CdsError(f"{field} must be a JSON object.")
    return value


def _age_group(birth_date: str, today: date) -> str | None:
    match = _BIRTH_DATE.match(birth_date)
    if match is None:
        raise CdsError("prefetch.patient.birthDate must be a FHIR date (YYYY, YYYY-MM, or YYYY-MM-DD).")
    year, month, day = int(match.group(1)), int(match.group(2) or 1), int(match.group(3) or 1)
    try:
        born = date(year, month, day)
    except ValueError:
        raise CdsError("prefetch.patient.birthDate is not a calendar date.") from None
    if born > today:
        raise CdsError("prefetch.patient.birthDate lies in the future.")
    age = today.year - born.year - ((today.month, today.day) < (born.month, born.day))
    # The lookup's coarse groups (CONTRACT.md §19).
    return "0-17" if age < 18 else "18-39" if age < 40 else "40-64" if age < 65 else "65+"


def _coding(condition: dict, index: int) -> Coding:
    code = _object(condition.get("code"), f"Condition {index + 1}: code")
    codings = code.get("coding")
    if not isinstance(codings, list) or not codings:
        raise CdsError(f"Condition {index + 1}: code.coding must be a non-empty list.")
    for item in codings:
        if not isinstance(item, dict):
            raise CdsError(f"Condition {index + 1}: every code.coding entry must be an object.")
        system = item.get("system")
        if system in (ICD11_SYSTEM, ICD10CM_SYSTEM):
            value = item.get("code")
            if not isinstance(value, str) or not _CODE.match(value.strip()):
                raise CdsError(f"Condition {index + 1}: code.coding.code must be a code of letters, digits, and dots.")
            display = item.get("display") if isinstance(item.get("display"), str) else None
            return Coding(system, value.strip().upper(), display[:120] if display else None)
    return Coding(None, None, None)


def parse_request(body: bytes, *, today: date | None = None) -> CdsRequest:
    """A CDS Hooks 2.0 request, read by hand (CONTRACT.md §33). Raises ``CdsError``."""
    today = today or date.today()
    try:
        data = json.loads(body)
    except (ValueError, RecursionError):
        raise CdsError("The body is not valid JSON.") from None
    data = _object(data, "The body")
    if data.get("hook") != HOOK:
        raise CdsError(f"hook must be {HOOK!r}.")
    instance = data.get("hookInstance")
    if not isinstance(instance, str) or not 1 <= len(instance) <= 128:
        raise CdsError("hookInstance must be a string of 1 to 128 characters.")
    context = _object(data.get("context"), "context")
    if not isinstance(context.get("patientId"), str) or not context["patientId"]:
        raise CdsError("context.patientId must be a string.")
    prefetch = _object(data.get("prefetch"), "prefetch")
    patient = _object(prefetch.get("patient"), "prefetch.patient", required=False)
    age_group = sex = None
    if patient is not None:
        if patient.get("resourceType") != "Patient":
            raise CdsError("prefetch.patient must be a FHIR Patient resource.")
        if patient.get("birthDate") is not None:
            if not isinstance(patient["birthDate"], str):
                raise CdsError("prefetch.patient.birthDate must be a FHIR date.")
            age_group = _age_group(patient["birthDate"], today)
        if patient.get("gender") is not None:
            if not isinstance(patient["gender"], str) or patient["gender"] not in _GENDERS:
                raise CdsError("prefetch.patient.gender must be male, female, other, or unknown.")
            sex = _GENDERS[patient["gender"]]
    bundle = _object(prefetch.get("conditions"), "prefetch.conditions")
    if bundle.get("resourceType") != "Bundle":
        raise CdsError("prefetch.conditions must be a FHIR Bundle of Condition resources.")
    entries = bundle.get("entry", [])
    if not isinstance(entries, list):
        raise CdsError("prefetch.conditions.entry must be a list.")
    if not 1 <= len(entries) <= MAX_CONDITIONS:
        raise CdsError(f"prefetch.conditions must hold 1 to {MAX_CONDITIONS} conditions.")
    conditions = []
    for index, entry in enumerate(entries):
        resource = _object(_object(entry, f"Condition {index + 1}").get("resource"), f"Condition {index + 1}: resource")
        if resource.get("resourceType") != "Condition":
            raise CdsError(f"Condition {index + 1}: resource must be a FHIR Condition.")
        conditions.append(_coding(resource, index))
    card_id = setting = population = None
    extension = _object(data.get("extension"), "extension", required=False)
    if extension is not None:
        ours = _object(extension.get(EXTENSION), f"extension.{EXTENSION}", required=False) or {}
        card_id, setting, population = ours.get("card_id"), ours.get("setting"), ours.get("population")
        if card_id is not None and (not isinstance(card_id, str) or card_id.count("|") != 1):
            raise CdsError(f"extension.{EXTENSION}.card_id must be <model_version>|<function>.")
        if setting is not None and (not isinstance(setting, str) or setting not in CARE_SETTINGS):
            raise CdsError(f"extension.{EXTENSION}.setting must be one of {', '.join(CARE_SETTINGS)}, or left out.")
        if population is not None and (not isinstance(population, str) or not _POPULATION_ID.match(population)):
            raise CdsError(f"extension.{EXTENSION}.population must be a local population id from /meta.")
    return CdsRequest(age_group, sex, tuple(conditions), card_id, setting, population)


# ---------------------------------------------------------------- answers

def _origin(request: Request) -> str:
    """The request's own origin, for absolute links (§33): ``Origin`` when the browser sent one
    (the guard requires it to equal ``scheme://Host``), else ``scheme://Host``."""
    origin = request.headers.get("origin")
    if origin:
        return origin.rstrip("/")
    host = request.headers.get("host") or "127.0.0.1"
    return f"{request.url.scheme}://{host}"


def _icd10cm_concept(store, code: str):
    """The ICD-10-CM concept a code reads under (itself, else its four- then three-character
    category), its name, and whether the store has ICD-10-CM: (None, None, False) without it,
    (None, None, True) when no category of the code is mapped."""
    infos = store.ontology_infos()
    if not any(info.ontology_id == "icd10cm" for info in infos):
        return None, None, False
    tables = store.ontology_tables("icd10cm")
    if "." not in code and len(code) > 3:
        code = f"{code[:3]}.{code[3:]}"
    for candidate in (code, code[:5], code[:3]):
        if candidate in tables.mappings:
            return candidate, tables.names.get(candidate), True
    return None, None, True


def _icd11_concept(atlas, code: str):
    """An ICD-11 MMS code on the atlas: exact, else its stem (§23.2: drop the last character after the dot)."""
    while code:
        concept = atlas.by_code.get(code)
        if concept is not None:
            return concept
        if "." not in code:
            return None
        code = code[:-1].rstrip(".")
    return None


def _words(statuses: dict, intended_use_defined: bool) -> str:
    parts = [
        f"**Overall: {STATUS_WORDS[statuses['overall']]}**",
        f"Performance: {STATUS_WORDS[statuses['performance']]}",
        f"Evidence: {STATUS_WORDS[statuses['evidence']]}",
    ]
    if intended_use_defined:
        parts.append(f"Intended use: {INTENDED_USE_WORDS.get(statuses['intended_use'] or '', 'No data')}")
    # No dot separators in anything a reader sees.
    return "; ".join(parts)


def _summary(name: str, statuses: dict, safety: str | None) -> str:
    status = STATUS_WORDS[statuses["overall"]]
    tail = f"{status} on this card" + ("; serious safety incident open" if safety == "serious" else "; safety incident open" if safety == "caution" else "")
    room = 140 - len(tail) - 2
    shown = name if len(name) <= room else name[: max(room - 1, 1)].rstrip() + "…"
    return f"{shown}: {tail}"


def _indicator(statuses: dict, safety: str | None) -> str:
    if safety == "serious":
        return "critical"
    if safety == "caution" or statuses["overall"] in ("weak", "no_data", "out_of_scope"):
        return "warning"
    return "info"


def _lens_words(card: _Card) -> str:
    lens = card.lens
    groups = [value for value in (lens.age, lens.sex, lens.ethnicity) if not value.startswith("All ")]
    setting = "Any setting" if lens.is_any_setting else lens.setting
    return ", ".join([*groups, setting]) if groups else f"All patients, {setting}"


def _condition_card(card: _Card, coding: Coding, condition: dict, name: str, mapped: dict, origin: str, intended_use_defined: bool) -> dict:
    statuses = condition["statuses"]
    if condition.get("provenance") and (condition["provenance"].get("rollup") or {}).get("child_count") == 0:
        # A rollup without children reads No data (CONTRACT.md §6, V1).
        statuses = {"overall": "no_data", "performance": "no_data", "evidence": "no_data", "intended_use": None}
        condition = {**condition, "warnings": [], "safeguards": []}
    safety = condition["safety"]
    lines = [_words(statuses, intended_use_defined), f"For: {_lens_words(card)}."]
    if mapped.get("note"):
        lines.append(mapped["note"])
    warnings = [WARNING_WORDS.get(item["code"], item["code"].replace("_", " ").capitalize()) for item in condition["warnings"][:3]]
    if warnings:
        lines.append("**Top warnings:** " + "; ".join(warnings) + ".")
    safeguards = [SAFEGUARD_WORDS.get(item["id"], item["id"]) for item in condition["safeguards"][:2]]
    if safeguards:
        lines.append("**Safeguards:** " + "; ".join(safeguards) + ".")
    open_incidents = [incident for incident in condition["incidents"] if incident["status"] != "closed"]
    if open_incidents:
        shown = "; ".join(
            f"{'Serious' if incident['severity'] == 'serious' else 'Caution'}: {incident['summary']}" for incident in open_incidents[:2]
        )
        more = f" (+{len(open_incidents) - 2} more)" if len(open_incidents) > 2 else ""
        lines.append(f"**Open incidents ({len(open_incidents)}):** {shown}{more}")
    lines.append(f"*{CDS_SYNTHETIC_LINE}*")
    return {
        "uuid": str(uuid.uuid4()),
        "summary": _summary(name, statuses, safety),
        "indicator": _indicator(statuses, safety),
        "detail": "\n\n".join(lines),
        "source": {"label": SOURCE_LABEL},
        "links": [{"label": "Open on the atlas (synthetic data)", "url": f"{origin}/{condition['card_url']}", "type": "absolute"}],
        "extension": {EXTENSION: {
            "system": coding.system, "code": coding.code, "matched": True, **mapped.get("fields", {}),
            "concept_id": condition["concept_id"], "statuses": statuses, "safety": safety,
            "dataset_version": card.context.label,
        }},
    }


def _unmapped_card(card: _Card, coding: Coding, reason: str, origin: str) -> dict:
    code_words = f"{coding.code} ({'ICD-10-CM' if coding.system == ICD10CM_SYSTEM else 'ICD-11'})" if coding.code else "A condition"
    summary = f"{code_words}: no mapping to the atlas" if coding.code else "A condition without an ICD-11 or ICD-10-CM code"
    return {
        "uuid": str(uuid.uuid4()),
        "summary": summary[:140],
        "indicator": "info",
        "detail": f"{reason}\n\n*{CDS_SYNTHETIC_LINE}*",
        "source": {"label": SOURCE_LABEL},
        "links": [{"label": "Open the card on the atlas (synthetic data)", "url": f"{origin}/{card.url()}", "type": "absolute"}],
        "extension": {EXTENSION: {"system": coding.system, "code": coding.code, "matched": False, "dataset_version": card.context.label}},
    }


def build_cards(store, context: VersionContext, parsed: CdsRequest, origin: str) -> list[dict]:
    """One CDS card per condition (call under ``Store.lock`` except for the ontology tables)."""
    dataset = context.dataset
    if parsed.card_id is not None:
        model, use_case = parsed.card_id.split("|")
    else:
        model = default_model_version(dataset)
        entry = dataset.model(model)
        use_case = entry.default_use_case or entry.use_cases[0].use_case
    dataset.model(model)  # 404 unknown_model
    lens = lens_from_population(LookupPopulation(age_group=parsed.patient_age_group, sex=parsed.patient_sex), parsed.setting)
    card = _Card(context, model, use_case, lens)  # 404 unknown_use_case
    intended_use_defined = dataset.intended_use_defined(model, use_case)
    atlas = dataset.atlas
    cards = []
    for coding in parsed.conditions:
        if coding.system is None:
            cards.append(_unmapped_card(card, coding, "This condition has no ICD-11 MMS or ICD-10-CM coding, so it cannot be placed on the atlas.", origin))
            continue
        if coding.system == ICD11_SYSTEM:
            concept = _icd11_concept(atlas, coding.code)
            if concept is None:
                cards.append(_unmapped_card(card, coding, f"{coding.code} is not an ICD-11 condition of the atlas.", origin))
                continue
            name = coding.display or concept.pt.lstrip("- ")
            cards.append(_condition_card(card, coding, card.condition(coding.code, concept), name, {}, origin, intended_use_defined))
            continue
        cm_id, cm_name, imported = _icd10cm_concept(store, coding.code)
        if not imported:
            cards.append(_unmapped_card(card, coding, "This copy of Broad Modelcard has not imported ICD-10-CM, so ICD-10-CM codes cannot be mapped.", origin))
            continue
        mapping = store.ontology_tables("icd10cm").mappings.get(cm_id) if cm_id else None
        target = atlas.by_id.get(mapping.target_concept_id) if mapping is not None and mapping.target_concept_id else None
        if target is None:
            cards.append(_unmapped_card(card, coding, f"{coding.code} has no ICD-11 mapping in the ICD-10-CM crosswalk (§23).", origin))
            continue
        name = coding.display or cm_name or coding.code
        note = f"Mapped from ICD-10-CM {cm_id} to ICD-11 {target.icd11_code or target.concept_id} ({target.pt.lstrip('- ')}; {mapping.kind})."
        condition = card.condition(coding.code, target)
        fields = {"mapping": {"kind": mapping.kind, "icd10cm": cm_id, "icd11_concept_id": target.concept_id}}
        cards.append(_condition_card(card, coding, condition, name, {"note": note, "fields": fields}, origin, intended_use_defined))
    return cards


# ----------------------------------------------------------------- routes

DISCOVERY_DESCRIPTION = (
    "Where each of a patient's conditions sits on one Broad Modelcard card: its status, top warnings, safeguards, "
    "and open safety incidents, with a link to the atlas. Demonstration on synthetic data, not for clinical use."
)


@router.get(
    "/cds-services",
    operation_id="getCdsServices",
    summary="CDS Hooks discovery: the local service bmc-condition-status on patient-view (synthetic demonstration).",
    description="Added in v1.14 (CONTRACT.md §33). Local only; no CORS. The extension names the default card and the dataset version.",
    response_model=CdsServices,
    responses=problems(404),
)
def get_cds_services(request: Request, version: Version = "live") -> Response:
    api = api_of(request)
    context = api.store.resolve(version)

    def build() -> dict:
        dataset = context.dataset
        model = default_model_version(dataset)
        entry = dataset.model(model)
        return {
            "services": [{
                "id": SERVICE_ID,
                "hook": HOOK,
                "title": "Broad Modelcard condition status (synthetic demonstration)",
                "description": DISCOVERY_DESCRIPTION,
                "prefetch": {
                    "patient": "Patient/{{context.patientId}}",
                    "conditions": "Condition?patient={{context.patientId}}",
                },
                "usageRequirements": (
                    "Send prefetch.patient and prefetch.conditions (codings in ICD-11 MMS or ICD-10-CM); the service fetches "
                    "nothing itself. Choose the card with extension.broad-modelcard.card_id. Synthetic data only; never real patients."
                ),
                "extension": {EXTENSION: {
                    "dataset_version": context.label,
                    "default_card": {"model_version": model, "use_case": entry.default_use_case or entry.use_cases[0].use_case},
                    "notice": SYNTHETIC_DATA_NOTICE,
                }},
            }]
        }

    return api.json(request, context, CdsServices, build, cache_key=("cds-services",))


@router.post(
    f"/cds-services/{SERVICE_ID}",
    operation_id="callCdsService",
    summary="CDS Hooks service bmc-condition-status: one CDS card per condition of a synthetic patient (demonstration, not for clinical use).",
    description=(
        "Added in v1.14 (CONTRACT.md §33). A CDS Hooks 2.0 patient-view request, parsed by hand; codings in ICD-11 MMS or "
        "ICD-10-CM (mapped through the §23 crosswalk). Malformed: 400. Nothing is stored or logged (Cache-Control: no-store)."
    ),
    response_model=CdsResponse,
    responses=problems(400, 404, 413),
    openapi_extra={"requestBody": {"required": True, "content": {"application/json": {"schema": CDS_REQUEST_SCHEMA}}}},
)
async def call_cds_service(request: Request, version: Version = "live") -> Response:
    body = await request.body()
    # The answer reads the store under its lock: off the event loop, as every other read runs.
    return await run_in_threadpool(_answer, request, body, version)


def _answer(request: Request, body: bytes, version: str) -> Response:
    api = api_of(request)
    try:
        if len(body) > MAX_BODY_BYTES:
            raise ApiError(413, "upload_too_large", "The request is larger than 64 KB, the most this service accepts.")
        try:
            parsed = parse_request(body)
        except CdsError as error:
            raise ApiError(400, "invalid_cds_request", str(error)) from None
        try:
            context = api.store.resolve(version, parsed.population)
        except ApiError as error:
            if error.code != "unknown_population":
                raise
            raise ApiError(404, error.code, "Unknown population.") from None
        origin = _origin(request)
        with api.store.lock:
            payload = {"cards": build_cards(api.store, context, parsed, origin)}
        encoded = encode(payload)
        if api.validate_responses:
            CdsResponse.model_validate_json(encoded)
    except (UnknownModel, UnknownUseCase) as error:
        raise ApiError(404, error.code, "Unknown card." if error.code == "unknown_model" else "Unknown function for this AI system.") from None
    except (ApiError, ServiceError, MissingData):
        raise
    except Exception as error:  # noqa: BLE001
        # Never log a traceback: its messages could carry request content (as for lookup, §19).
        log.error("Unhandled %s in the CDS Hooks service; details withheld.", type(error).__name__)
        raise ApiError(500, "internal_error", "The server failed to answer this request.") from None
    return Response(encoded, media_type="application/json", headers={DATASET_VERSION_HEADER: context.label, **population_headers(context), **NO_STORE})
