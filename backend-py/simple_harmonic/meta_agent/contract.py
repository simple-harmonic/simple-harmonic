"""Output contract validation (Tier 1: structural).

TS source: packages/backend/src/lib/meta-agent/contract.ts

A contract is a simplified JSON Schema that describes what an agent's tick should
produce. The validator checks type, required fields, array item shapes, and
nested objects. It does NOT support ``$ref``, ``allOf``/``anyOf``/``oneOf``,
``pattern``, or other advanced JSON Schema features.

Supported schema keywords: ``type``, ``properties``, ``required``, ``items``,
``description``. Supported types: ``object``, ``array``, ``string``, ``number``,
``boolean``, ``null``.

Returns a :class:`ValidationResult` (empty ``issues`` = pass). Never raises.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ContractIssue(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    path: str
    message: str


class ValidationResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    valid: bool
    issues: list[ContractIssue] = Field(default_factory=list)


def validate_contract(payload: Any, contract: dict[str, Any]) -> ValidationResult:
    """Validate ``payload`` against a simplified JSON-Schema ``contract``."""
    issues: list[ContractIssue] = []
    _validate(payload, contract, "", issues)
    return ValidationResult(valid=len(issues) == 0, issues=issues)


def _type_of(value: Any) -> str:
    """JS-``typeof``-flavored type name used in issue messages.

    Mirrors the TS ``typeOf``: ``null`` before ``array`` before the JS scalar
    names (``number`` covers int and float; ``boolean`` is checked before
    ``number`` because ``bool`` is an ``int`` subclass in Python).
    """
    if value is None:
        return "null"
    if isinstance(value, list):
        return "array"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, dict):
        return "object"
    return "object"


def _validate(value: Any, schema: Any, path: str, issues: list[ContractIssue]) -> None:
    if not schema or not isinstance(schema, dict):
        return

    schema_type = schema.get("type")

    if schema_type:
        types = schema_type if isinstance(schema_type, list) else [schema_type]
        actual = _type_of(value)
        if actual not in types:
            issues.append(
                ContractIssue(
                    path=path or "(root)",
                    message=f"expected {'|'.join(types)}, got {actual}",
                )
            )
            return

    if schema_type == "object" or (not schema_type and schema.get("properties")):
        if not isinstance(value, dict):
            if not schema_type:
                issues.append(
                    ContractIssue(
                        path=path or "(root)",
                        message=f"expected object, got {_type_of(value)}",
                    )
                )
            return

        required = schema.get("required")
        if required:
            for key in required:
                # TS: `!(key in obj) || obj[key] === undefined`. JSON never
                # yields `undefined`, so over wire data the absence test is just
                # `key not in obj`. A present-but-null required field is NOT
                # "missing" here — it falls to the property type check below,
                # which is what flags `null` against a non-null type.
                if key not in value:
                    issues.append(
                        ContractIssue(
                            path=f"{path}.{key}" if path else key,
                            message="required field missing",
                        )
                    )

        properties = schema.get("properties")
        if properties:
            for key, prop_schema in properties.items():
                if key in value:
                    _validate(
                        value[key],
                        prop_schema,
                        f"{path}.{key}" if path else key,
                        issues,
                    )

    if schema_type == "array" or (not schema_type and schema.get("items")):
        if not isinstance(value, list):
            if not schema_type:
                issues.append(
                    ContractIssue(
                        path=path or "(root)",
                        message=f"expected array, got {_type_of(value)}",
                    )
                )
            return

        items = schema.get("items")
        if items:
            for i, item in enumerate(value):
                _validate(item, items, f"{path}[{i}]", issues)
