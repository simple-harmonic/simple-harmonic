"""Tests for simple_harmonic.apollo.

Ported from packages/backend/tests/unit/apollo.test.ts. The decrypt-interop is
proven two ways:
  1. A round-trip through Python's own set()/load().
  2. A GOLDEN vector produced by Node (createCipheriv aes-256-gcm, scryptSync
     key, on-disk layout [iv][tag][ciphertext]) that Python must decrypt — this
     is the Node<->Python interop proof called for in the task.

apollo holds module-level state (_project_root, _cache), so each test pins a
fresh temp dir via init() and the env fixture saves/clears the secrets it
touches, exactly like the TS beforeEach/afterEach.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from pathlib import Path

import pytest

from simple_harmonic import apollo

_ENV_KEYS = ["APOLLO_MASTER_KEY", "TEST_SECRET_1", "TEST_SECRET_2", "LEGACY_KEY", "SECOND"]


@pytest.fixture(autouse=True)
def clean_apollo_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[Path]:
    """Fresh temp project root + cleared env + cleared in-memory cache."""
    apollo.init(tmp_path)
    apollo._cache.clear()
    for key in _ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    yield tmp_path
    apollo._cache.clear()


def test_auto_generates_master_key_on_first_set(clean_apollo_state: Path) -> None:
    apollo.set("TEST_SECRET_1", "value1")
    key_path = clean_apollo_state / ".apollo" / "master.key"
    assert key_path.exists()
    key = key_path.read_text(encoding="utf-8").strip()
    assert len(key) == 64  # 32 bytes hex


def test_encrypts_vault_file_on_disk(clean_apollo_state: Path) -> None:
    apollo.set("TEST_SECRET_1", "my-secret-token")
    vault_path = clean_apollo_state / ".apollo" / "vault.enc"
    assert vault_path.exists()
    raw = vault_path.read_bytes()
    assert b"my-secret-token" not in raw
    assert b"TEST_SECRET_1" not in raw


def test_set_makes_value_available_in_env(monkeypatch: pytest.MonkeyPatch) -> None:
    apollo.set("TEST_SECRET_1", "val123")
    import os

    assert os.environ.get("TEST_SECRET_1") == "val123"


def test_load_decrypts_secrets_into_env(
    clean_apollo_state: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import os

    apollo.set("TEST_SECRET_1", "alpha")
    apollo.set("TEST_SECRET_2", "beta")

    # Clear env to simulate a restart.
    monkeypatch.delenv("TEST_SECRET_1", raising=False)
    monkeypatch.delenv("TEST_SECRET_2", raising=False)

    apollo.init(clean_apollo_state)
    result = apollo.load()

    assert result["count"] == 2
    assert os.environ.get("TEST_SECRET_1") == "alpha"
    assert os.environ.get("TEST_SECRET_2") == "beta"


def test_load_does_not_overwrite_explicitly_set_env_vars(
    clean_apollo_state: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import os

    apollo.set("TEST_SECRET_1", "from-vault")
    # Simulate operator setting the var explicitly.
    monkeypatch.setenv("TEST_SECRET_1", "from-operator")

    apollo.init(clean_apollo_state)
    result = apollo.load()

    # Operator wins, and the already-set key is NOT counted as newly set.
    assert os.environ.get("TEST_SECRET_1") == "from-operator"
    assert result["count"] == 0


def test_remove_deletes_from_vault_and_env(
    clean_apollo_state: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import os

    apollo.set("TEST_SECRET_1", "to-remove")
    assert os.environ.get("TEST_SECRET_1") == "to-remove"

    apollo.remove("TEST_SECRET_1")
    assert os.environ.get("TEST_SECRET_1") is None

    # Verify it's gone from the vault too.
    monkeypatch.delenv("TEST_SECRET_1", raising=False)
    apollo.init(clean_apollo_state)
    apollo.load()
    assert os.environ.get("TEST_SECRET_1") is None


def test_get_returns_cached_value() -> None:
    apollo.set("TEST_SECRET_1", "cached-val")
    assert apollo.get("TEST_SECRET_1") == "cached-val"
    assert apollo.get("NONEXISTENT") is None


def test_has_checks_availability() -> None:
    apollo.set("TEST_SECRET_1", "exists")
    assert apollo.has("TEST_SECRET_1") is True
    assert apollo.has("NONEXISTENT") is False


def test_list_keys_returns_all_secret_keys() -> None:
    apollo.set("TEST_SECRET_1", "a")
    apollo.set("TEST_SECRET_2", "b")
    keys = apollo.list_keys()
    assert "TEST_SECRET_1" in keys
    assert "TEST_SECRET_2" in keys


def test_mask_hides_the_middle_of_a_secret() -> None:
    assert apollo.mask("ghp_abc123xyz789") == "ghp_••••z789"
    assert apollo.mask("short") == "••••••••"
    assert apollo.mask("") == ""


def test_uses_apollo_master_key_env_var_when_set(
    clean_apollo_state: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import os

    monkeypatch.setenv("APOLLO_MASTER_KEY", "custom-master-key-for-test")
    apollo.set("TEST_SECRET_1", "with-custom-key")

    # Master key file should NOT be created when env var is set.
    key_path = clean_apollo_state / ".apollo" / "master.key"
    assert not key_path.exists()
    assert os.environ.get("TEST_SECRET_1") == "with-custom-key"


def test_load_returns_count_0_when_no_vault_exists() -> None:
    result = apollo.load()
    assert result["count"] == 0


def test_creates_per_install_salt_file_on_set(clean_apollo_state: Path) -> None:
    apollo.set("TEST_SECRET_1", "value1")
    assert (clean_apollo_state / ".apollo" / "salt").exists()


def test_on_disk_layout_is_iv_tag_ciphertext_not_naive(
    clean_apollo_state: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Adversarial framing check: the vault MUST be [iv(12)][tag(16)][ct], the
    Node getAuthTag() layout — NOT the naive AESGCM layout [iv][ct||tag] that a
    direct cryptography port produces. Decrypting with the documented slicing
    must succeed AND the tag must sit in bytes 12..28 (decrypting under the
    naive [iv][ct||tag] interpretation must FAIL to authenticate)."""
    import json

    monkeypatch.setenv("APOLLO_MASTER_KEY", "framing-master")
    payload = {"TEST_SECRET_1": "alpha", "TEST_SECRET_2": "beta"}
    apollo._cache.clear()
    apollo._cache.update(payload)
    blob = apollo._encrypt(payload, "framing-master")

    salt = (clean_apollo_state / ".apollo" / "salt").read_bytes()
    key = apollo._derive_key("framing-master", salt)

    iv = blob[: apollo.IV_LEN]
    tag = blob[apollo.IV_LEN : apollo.IV_LEN + apollo.TAG_LEN]
    ct = blob[apollo.IV_LEN + apollo.TAG_LEN :]

    # Correct framing decrypts to the original payload.
    assert json.loads(apollo.decrypt_gcm(key, iv, ct, tag).decode()) == payload

    # The NAIVE framing [iv][ct||tag] must NOT authenticate: prove the bytes
    # were genuinely re-laid (a silent-corruption port would pass the naive read).
    naive_ct = blob[apollo.IV_LEN : len(blob) - apollo.TAG_LEN]
    naive_tag = blob[len(blob) - apollo.TAG_LEN :]
    with pytest.raises((ValueError, Exception)):
        apollo.decrypt_gcm(key, iv, naive_ct, naive_tag)


def test_python_encrypt_round_trips_through_decrypt(
    clean_apollo_state: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A Python-written vault decrypts back to the same payload via the module's
    own _decrypt (closing the loop the Node golden vector opens from the other
    side)."""
    monkeypatch.setenv("APOLLO_MASTER_KEY", "roundtrip-master")
    payload = {"TEST_SECRET_1": "x", "TEST_SECRET_2": "y"}
    blob = apollo._encrypt(payload, "roundtrip-master")
    assert apollo._decrypt(blob, "roundtrip-master") == payload


def test_two_installs_same_master_key_generate_different_salts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("APOLLO_MASTER_KEY", "shared-master-key")
    dir_a = tmp_path / "a"
    dir_b = tmp_path / "b"
    apollo.init(dir_a)
    apollo._cache.clear()
    apollo.set("TEST_SECRET_1", "same-value")
    apollo.init(dir_b)
    apollo._cache.clear()
    apollo.set("TEST_SECRET_1", "same-value")
    salt_a = (dir_a / ".apollo" / "salt").read_bytes()
    salt_b = (dir_b / ".apollo" / "salt").read_bytes()
    assert salt_a != salt_b


def test_decrypts_legacy_vault_via_legacy_fallback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Hand-rolled pre-migration vault (no .apollo/salt) decrypts via the legacy
    fixed salt fallback — mirrors the TS test that round-trips its own legacy
    blob built with createCipheriv + scryptSync(LEGACY_SALT)."""
    import os

    monkeypatch.setenv("APOLLO_MASTER_KEY", "legacy-master-key")
    apollo._cache.clear()
    work = tmp_path / "legacy"
    (work / ".apollo").mkdir(parents=True)

    key = hashlib.scrypt(
        b"legacy-master-key",
        salt=apollo.LEGACY_SALT,
        n=apollo._SCRYPT_N,
        r=apollo._SCRYPT_R,
        p=apollo._SCRYPT_P,
        dklen=apollo.KEY_LEN,
        maxmem=apollo._SCRYPT_MAXMEM,
    )
    import secrets as _secrets

    iv = _secrets.token_bytes(12)
    import json

    ct, tag = apollo.encrypt_gcm(key, iv, json.dumps({"LEGACY_KEY": "legacy-val"}).encode())
    # Layout [iv(12)][tag(16)][ciphertext], crucially NO salt file.
    (work / ".apollo" / "vault.enc").write_bytes(iv + tag + ct)
    assert not (work / ".apollo" / "salt").exists()

    apollo.init(work)
    result = apollo.load()
    assert result["count"] == 1
    assert os.environ.get("LEGACY_KEY") == "legacy-val"


# ---------------------------------------------------------------------------
# Node<->Python interop: GOLDEN vector produced by the Node runtime.
#
# Generated with node:crypto:
#   key = scryptSync("legacy-master-key", "simple-harmonic-apollo-v1", 32)
#   iv  = 000102030405060708090a0b
#   pt  = {"LEGACY_KEY":"legacy-val","SECOND":"another"}
#   blob = [iv(12)][getAuthTag()(16)][ciphertext]
# Python must decrypt this byte-for-byte, proving the re-laid GCM layout and the
# scrypt parameters match Node exactly. A naive port (tag appended to ct) fails.
# ---------------------------------------------------------------------------

_NODE_GOLDEN_MASTER = "legacy-master-key"
_NODE_GOLDEN_BLOB_HEX = (
    "000102030405060708090a0b"  # iv
    "4f6b6daf7ef08dbbb0f565c95181f3de"  # tag (16)
    "8bcdf02ce963ec673be3529948b95af01504d35c2178ca88c7b7503ff469a2d7"
    "d818556fa542eb858ee7e2b0a212"  # ciphertext
)


def test_decrypts_node_generated_golden_vault(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import os

    monkeypatch.setenv("APOLLO_MASTER_KEY", _NODE_GOLDEN_MASTER)
    apollo._cache.clear()
    work = tmp_path / "golden"
    (work / ".apollo").mkdir(parents=True)
    # No salt file -> legacy fixed salt, matching how the Node blob was keyed.
    (work / ".apollo" / "vault.enc").write_bytes(bytes.fromhex(_NODE_GOLDEN_BLOB_HEX))

    apollo.init(work)
    result = apollo.load()

    assert result["count"] == 2
    assert os.environ.get("LEGACY_KEY") == "legacy-val"
    assert os.environ.get("SECOND") == "another"
    assert apollo.get("LEGACY_KEY") == "legacy-val"
