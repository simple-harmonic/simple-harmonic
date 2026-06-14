"""Output-contract validator tests.

Ports packages/backend/tests/unit/contract.test.ts.
"""

from __future__ import annotations

from typing import Any

from simple_harmonic.meta_agent.contract import validate_contract

BUG_CONTRACT: dict[str, Any] = {
    "type": "object",
    "required": ["bugs"],
    "properties": {
        "bugs": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["file", "description", "severity"],
                "properties": {
                    "file": {"type": "string"},
                    "description": {"type": "string"},
                    "severity": {"type": "string"},
                    "line": {"type": "number"},
                },
            },
        }
    },
}


def test_passes_valid_payload() -> None:
    payload = {
        "bugs": [{"file": "src/app.ts", "description": "null ref", "severity": "high", "line": 42}]
    }
    result = validate_contract(payload, BUG_CONTRACT)
    assert result.valid is True
    assert len(result.issues) == 0


def test_fails_when_required_field_missing_at_root() -> None:
    result = validate_contract({}, BUG_CONTRACT)
    assert result.valid is False
    assert len(result.issues) == 1
    assert result.issues[0].path == "bugs"
    assert "required" in result.issues[0].message


def test_fails_when_required_field_missing_in_array_item() -> None:
    payload = {"bugs": [{"file": "src/app.ts", "description": "null ref"}]}
    result = validate_contract(payload, BUG_CONTRACT)
    assert result.valid is False
    severity_issue = next((i for i in result.issues if "severity" in i.path), None)
    assert severity_issue is not None
    assert "required" in severity_issue.message


def test_fails_on_wrong_type() -> None:
    result = validate_contract({"bugs": "not an array"}, BUG_CONTRACT)
    assert result.valid is False
    assert "expected array" in result.issues[0].message


def test_fails_on_wrong_nested_type() -> None:
    payload = {"bugs": [{"file": 123, "description": "ok", "severity": "high"}]}
    result = validate_contract(payload, BUG_CONTRACT)
    assert result.valid is False
    assert result.issues[0].path == "bugs[0].file"
    assert "expected string" in result.issues[0].message


def test_passes_with_empty_array() -> None:
    result = validate_contract({"bugs": []}, BUG_CONTRACT)
    assert result.valid is True


def test_passes_with_no_contract() -> None:
    result = validate_contract({"anything": True}, {})
    assert result.valid is True


def test_validates_root_type_mismatch() -> None:
    result = validate_contract("a string", BUG_CONTRACT)
    assert result.valid is False
    assert "expected object" in result.issues[0].message


def test_validates_multiple_items_in_array() -> None:
    payload = {
        "bugs": [
            {"file": "a.ts", "description": "ok", "severity": "low"},
            {"file": "b.ts", "description": "broken"},
        ]
    }
    result = validate_contract(payload, BUG_CONTRACT)
    assert result.valid is False
    assert len(result.issues) == 1
    assert result.issues[0].path == "bugs[1].severity"


TEST_REPORT_CONTRACT: dict[str, Any] = {
    "type": "object",
    "required": ["passed", "failed"],
    "properties": {
        "passed": {"type": "number"},
        "failed": {"type": "number"},
        "failures": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["test", "error"],
                "properties": {"test": {"type": "string"}, "error": {"type": "string"}},
            },
        },
    },
}


def test_validates_test_report_contract() -> None:
    payload = {"passed": 10, "failed": 1, "failures": [{"test": "login", "error": "timeout"}]}
    assert validate_contract(payload, TEST_REPORT_CONTRACT).valid is True


def test_catches_missing_test_report_fields() -> None:
    result = validate_contract({"passed": 10}, TEST_REPORT_CONTRACT)
    assert result.valid is False
    assert any(i.path == "failed" for i in result.issues)


def test_handles_null_values() -> None:
    schema = {"type": "object", "properties": {"name": {"type": "string"}}}
    result = validate_contract({"name": None}, schema)
    assert result.valid is False
    assert "expected string, got null" in result.issues[0].message


def test_handles_union_types() -> None:
    schema = {"type": "object", "properties": {"value": {"type": ["string", "null"]}}}
    assert validate_contract({"value": "hello"}, schema).valid is True
    assert validate_contract({"value": None}, schema).valid is True
    assert validate_contract({"value": 42}, schema).valid is False


def test_number_type_accepts_int_and_float_but_not_bool() -> None:
    # Python edge: bool is an int subclass; the validator must classify True as
    # "boolean" (matching JS typeof), so a bool fails a number contract.
    schema = {"type": "object", "properties": {"n": {"type": "number"}}}
    assert validate_contract({"n": 42}, schema).valid is True
    assert validate_contract({"n": 4.2}, schema).valid is True
    assert validate_contract({"n": True}, schema).valid is False
