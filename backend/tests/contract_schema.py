"""Checks against backend/openapi.json without a JSON Schema library.

* ``Validator`` validates a JSON value against a contract schema. It supports
  exactly the keywords the contract uses and fails on any other, so a new
  keyword cannot be ignored silently. It is stricter than JSON Schema in two
  ways that catch drift: an object with ``properties`` and no
  ``additionalProperties`` is closed (unknown keys are errors), and an
  ``integer`` must be a JSON integer, not ``1.0``.
* ``shape`` reduces a schema to a canonical structure (references resolved,
  unions flattened and sorted, annotations dropped), so the schemas FastAPI
  generates from the Pydantic models can be compared with the committed ones.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any

from app import db

CONTRACT_PATH = db.BACKEND_DIR / "openapi.json"

ANNOTATIONS = frozenset({"description", "summary", "title", "default", "examples", "contentMediaType", "deprecated"})
VALIDATION_KEYWORDS = frozenset(
    {
        "$ref", "type", "enum", "const", "properties", "required", "additionalProperties", "items", "prefixItems",
        "minItems", "maxItems", "minLength", "maxLength", "pattern", "minimum", "maximum", "oneOf", "anyOf", "format",
    }
)


def load_contract() -> dict:
    return json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))


def resolve(document: dict, schema: dict) -> dict:
    while isinstance(schema, dict) and "$ref" in schema:
        reference = schema["$ref"]
        if not reference.startswith("#/"):
            raise ValueError(f"Only local references are supported: {reference}")
        target: Any = document
        for part in reference[2:].split("/"):
            target = target[part]
        schema = target
    return schema


# --------------------------------------------------------------- validation

def _type_matches(value: Any, expected: str) -> bool:
    if expected == "null":
        return value is None
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "string":
        return isinstance(value, str)
    if expected == "array":
        return isinstance(value, list)
    if expected == "object":
        return isinstance(value, dict)
    raise ValueError(f"Unknown type {expected!r}")


def _date_time(value: str) -> bool:
    if "T" not in value:
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None


class Validator:
    def __init__(self, document: dict):
        self.document = document

    def errors(self, value: Any, schema: dict | bool, path: str = "$") -> list[str]:
        if schema is True:
            return []
        if schema is False:
            return [f"{path}: no value is allowed here"]
        unknown = set(schema) - VALIDATION_KEYWORDS - ANNOTATIONS
        if unknown:
            raise ValueError(f"{path}: unsupported schema keywords {sorted(unknown)}")
        if "$ref" in schema:
            return self.errors(value, resolve(self.document, schema), path)

        if "oneOf" in schema or "anyOf" in schema:
            options = schema.get("oneOf", schema.get("anyOf"))
            results = [self.errors(value, option, path) for option in options]
            matching = sum(1 for errors in results if not errors)
            if matching == 0:
                # Prefer an option of the right type, then the one with the fewest errors.
                closest = min(results, key=lambda errors: (errors[0].startswith(f"{path}: expected "), len(errors)))
                return [f"{path}: matches no {'oneOf' if 'oneOf' in schema else 'anyOf'} option; closest: {closest[0]}", *closest[1:]]
            if "oneOf" in schema and matching > 1:
                return [f"{path}: {value!r:.60} matches {matching} oneOf options, expected exactly 1"]
            return []

        problems: list[str] = []
        if "type" in schema:
            types = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
            if not any(_type_matches(value, expected) for expected in types):
                return [f"{path}: expected {'/'.join(types)}, got {type(value).__name__} {value!r:.60}"]
        if "enum" in schema and value not in schema["enum"]:
            problems.append(f"{path}: {value!r} is not one of {schema['enum']}")
        if "const" in schema and value != schema["const"]:
            problems.append(f"{path}: {value!r:.80} is not {schema['const']!r:.80}")

        if isinstance(value, str):
            if "minLength" in schema and len(value) < schema["minLength"]:
                problems.append(f"{path}: shorter than {schema['minLength']}")
            if "maxLength" in schema and len(value) > schema["maxLength"]:
                problems.append(f"{path}: longer than {schema['maxLength']}")
            if "pattern" in schema and not re.search(schema["pattern"], value):
                problems.append(f"{path}: {value!r} does not match {schema['pattern']}")
            if schema.get("format") == "date-time" and not _date_time(value):
                problems.append(f"{path}: {value!r} is not an RFC 3339 date-time")
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if "minimum" in schema and value < schema["minimum"]:
                problems.append(f"{path}: {value} < {schema['minimum']}")
            if "maximum" in schema and value > schema["maximum"]:
                problems.append(f"{path}: {value} > {schema['maximum']}")

        if isinstance(value, dict):
            for name in schema.get("required", ()):
                if name not in value:
                    problems.append(f"{path}: missing required property {name!r}")
            properties = schema.get("properties", {})
            extra = schema.get("additionalProperties", False if "properties" in schema else True)
            for name, item in value.items():
                if name in properties:
                    problems += self.errors(item, properties[name], f"{path}.{name}")
                elif extra is False:
                    problems.append(f"{path}: unexpected property {name!r}")
                else:
                    problems += self.errors(item, extra, f"{path}.{name}")

        if isinstance(value, list):
            if "minItems" in schema and len(value) < schema["minItems"]:
                problems.append(f"{path}: fewer than {schema['minItems']} items")
            if "maxItems" in schema and len(value) > schema["maxItems"]:
                problems.append(f"{path}: more than {schema['maxItems']} items")
            prefix = schema.get("prefixItems", [])
            for index, item in enumerate(value):
                if index < len(prefix):
                    problems += self.errors(item, prefix[index], f"{path}[{index}]")
                elif "items" in schema:
                    problems += self.errors(item, schema["items"], f"{path}[{index}]")
        return problems


# ------------------------------------------------------------------- shapes

_KEYWORDS_BY_TYPE = {
    "object": {"properties", "required", "additionalProperties"},
    "array": {"items", "prefixItems", "minItems", "maxItems"},
    "string": {"minLength", "maxLength", "pattern", "format", "enum", "const"},
    "integer": {"minimum", "maximum", "enum", "const"},
    "number": {"minimum", "maximum", "enum", "const"},
    "boolean": {"enum", "const"},
    "null": set(),
}


def _sorted_union(members: list) -> Any:
    unique = {json.dumps(member, sort_keys=True): member for member in members}
    ordered = [unique[key] for key in sorted(unique)]
    return ordered[0] if len(ordered) == 1 else {"anyOf": ordered}


def shape(document: dict, schema: dict | bool) -> Any:
    """A canonical, comparable form of ``schema``."""
    if isinstance(schema, bool):
        return schema
    schema = resolve(document, schema)
    unknown = set(schema) - VALIDATION_KEYWORDS - ANNOTATIONS - {"discriminator"}
    if unknown:
        raise ValueError(f"unsupported schema keywords {sorted(unknown)}")

    if "oneOf" in schema or "anyOf" in schema:
        members = []
        for option in schema.get("oneOf", schema.get("anyOf")):
            member = shape(document, option)
            members += member["anyOf"] if isinstance(member, dict) and "anyOf" in member else [member]
        return _sorted_union(members)

    types = schema.get("type")
    if isinstance(types, list):
        return _sorted_union([shape(document, {**schema, "type": single}) for single in types])

    result: dict[str, Any] = {}
    if types is not None:
        result["type"] = types
        allowed = _KEYWORDS_BY_TYPE[types]
    else:
        allowed = set().union(*_KEYWORDS_BY_TYPE.values())
    for key in sorted(allowed & set(schema)):
        value = schema[key]
        if key == "properties":
            result[key] = {name: shape(document, item) for name, item in value.items()}
        elif key == "required":
            result[key] = sorted(value)
        elif key == "enum":
            result[key] = sorted(value, key=repr)
        elif key in ("items", "additionalProperties"):
            if value is False or (key == "additionalProperties" and value is True):
                continue  # closed objects and tuples are handled below; open dicts are the default
            result[key] = shape(document, value)
        elif key == "prefixItems":
            result[key] = [shape(document, item) for item in value]
        else:
            result[key] = value
    if types == "object":
        result.setdefault("required", [])
    if "prefixItems" in result:
        # A closed tuple: `items: false` (contract) or `maxItems == len` (Pydantic).
        if result.get("maxItems") == len(result["prefixItems"]):
            del result["maxItems"]
        result["closed_tuple"] = schema.get("items") is False or "maxItems" in schema
    return result


def shape_differences(expected: Any, actual: Any, path: str = "$") -> list[str]:
    """Readable differences between two shapes."""
    if isinstance(expected, dict) and isinstance(actual, dict):
        differences = []
        for key in sorted(set(expected) | set(actual)):
            if key not in actual:
                differences.append(f"{path}: missing {key!r} (contract: {json.dumps(expected[key])[:120]})")
            elif key not in expected:
                differences.append(f"{path}: extra {key!r} (app: {json.dumps(actual[key])[:120]})")
            else:
                differences += shape_differences(expected[key], actual[key], f"{path}.{key}")
        return differences
    if isinstance(expected, list) and isinstance(actual, list) and len(expected) == len(actual):
        differences = []
        for index, (left, right) in enumerate(zip(expected, actual)):
            differences += shape_differences(left, right, f"{path}[{index}]")
        return differences
    if expected != actual:
        return [f"{path}: contract {json.dumps(expected)[:160]} != app {json.dumps(actual)[:160]}"]
    return []
