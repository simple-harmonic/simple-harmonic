"""Apollo — encrypted secrets manager for Simple Harmonic.

TS source: packages/backend/src/server/apollo.ts

Secrets are AES-256-GCM encrypted at rest in .apollo/vault.enc (gitignored). A
master key (APOLLO_MASTER_KEY env var) encrypts/decrypts. If no master key is
set, Apollo auto-generates one and stores it in .apollo/master.key (also
gitignored, local-only). On server start, call ``load()`` to decrypt all
secrets into os.environ.

Crypto interop note (load-bearing):
  Node stores the vault as [iv(12)][tag(16)][ciphertext] and obtains the auth
  tag SEPARATELY via getAuthTag(). OpenSSL's EVP GCM API (used here via ctypes)
  matches that split layout exactly: the tag is read/set out-of-band with
  EVP_CTRL_GCM_GET_TAG / SET_TAG. The key is derived with hashlib.scrypt using
  the same parameters as Node's scryptSync defaults (N=16384, r=8, p=1) so a
  vault written by either runtime decrypts under the other. A golden vector
  produced by Node is checked in tests/test_apollo.py.

The TS module is stateful module-level functions; this port keeps that shape
(module-level state + functions) so callers read the same.
"""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

APOLLO_DIR = ".apollo"
VAULT_FILE = "vault.enc"
MASTER_KEY_FILE = "master.key"
SALT_FILE = "salt"
# Legacy fixed salt used before per-install salts. Retained so vaults encrypted
# before this change still decrypt: resolve_salt() falls back to it when no
# .apollo/salt file is present.
LEGACY_SALT = b"simple-harmonic-apollo-v1"
SALT_LEN = 16
KEY_LEN = 32
IV_LEN = 12
TAG_LEN = 16

# Node scryptSync defaults (N/r/p). keylen is KEY_LEN. maxmem is raised above
# the OpenSSL default so N=16384 fits (Node bumps maxmem implicitly).
_SCRYPT_N = 16384
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_MAXMEM = 64 * 1024 * 1024

# ---------------------------------------------------------------------------
# Internal state
# ---------------------------------------------------------------------------

# Resolved project root. Defaults to cwd; override for tests.
_project_root: Path = Path.cwd()

# In-memory cache of decrypted secrets. Written to os.environ on load().
_cache: dict[str, str] = {}


# ---------------------------------------------------------------------------
# AES-256-GCM (via the `cryptography` library)
#
# Mirrors Node's createCipheriv/createDecipheriv("aes-256-gcm") + getAuthTag /
# setAuthTag. `cryptography`'s AESGCM appends the 16-byte tag to the ciphertext;
# encrypt_gcm splits it back out and decrypt_gcm re-appends it, so the caller
# controls the on-disk byte layout ([iv][tag][ciphertext]) exactly as Node does.
# ---------------------------------------------------------------------------


def _derive_key(master_key: str, salt: bytes) -> bytes:
    import hashlib

    return hashlib.scrypt(
        master_key.encode("utf-8"),
        salt=salt,
        n=_SCRYPT_N,
        r=_SCRYPT_R,
        p=_SCRYPT_P,
        dklen=KEY_LEN,
        maxmem=_SCRYPT_MAXMEM,
    )


def encrypt_gcm(key: bytes, iv: bytes, plaintext: bytes) -> tuple[bytes, bytes]:
    """AES-256-GCM encrypt. Returns (ciphertext, tag) split apart, exactly as
    Node's getAuthTag() exposes the tag separately from the ciphertext."""
    sealed = AESGCM(key).encrypt(iv, plaintext, None)
    return sealed[:-TAG_LEN], sealed[-TAG_LEN:]


def decrypt_gcm(key: bytes, iv: bytes, ciphertext: bytes, tag: bytes) -> bytes:
    """AES-256-GCM decrypt. Takes ciphertext and tag separately (Node's
    setAuthTag layout). Raises ValueError on authentication failure."""
    try:
        return AESGCM(key).decrypt(iv, ciphertext + tag, None)
    except InvalidTag as exc:
        raise ValueError("GCM authentication failed") from exc


# ---------------------------------------------------------------------------
# Crypto (vault payload <-> bytes)
# ---------------------------------------------------------------------------


def _encrypt(data: dict[str, str], master_key: str) -> bytes:
    key = _derive_key(master_key, _ensure_salt())
    iv = secrets.token_bytes(IV_LEN)
    plaintext = json.dumps(data).encode("utf-8")
    ciphertext, tag = encrypt_gcm(key, iv, plaintext)
    # Layout: [iv (12)] [tag (16)] [ciphertext (...)]
    return iv + tag + ciphertext


def _decrypt(raw: bytes, master_key: str) -> dict[str, str]:
    if len(raw) < IV_LEN + TAG_LEN:
        raise ValueError("Vault file too short to be valid")
    key = _derive_key(master_key, _resolve_salt())
    iv = raw[:IV_LEN]
    tag = raw[IV_LEN : IV_LEN + TAG_LEN]
    ciphertext = raw[IV_LEN + TAG_LEN :]
    plaintext = decrypt_gcm(key, iv, ciphertext, tag)
    result: dict[str, str] = json.loads(plaintext.decode("utf-8"))
    return result


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def init(root: str | os.PathLike[str]) -> None:
    """Initialize Apollo with a custom root (for tests or non-standard layouts)."""
    global _project_root
    _project_root = Path(root)


def load() -> dict[str, int]:
    """Load all secrets from the encrypted vault into os.environ. Call once on
    server startup. Safe to call multiple times; idempotent.

    Does NOT overwrite already-set env vars (operator always wins) and counts
    only NEWLY-set keys.
    """
    master_key = _resolve_master_key()
    if not master_key:
        return {"count": 0}

    vault_path = _apollo_dir() / VAULT_FILE
    if not vault_path.exists():
        return {"count": 0}

    try:
        encrypted = vault_path.read_bytes()
        secrets_map = _decrypt(encrypted, master_key)
        global _cache
        _cache = secrets_map

        count = 0
        for key, value in secrets_map.items():
            # Don't overwrite explicitly set env vars (operator always wins).
            if not os.environ.get(key):
                os.environ[key] = value
                count += 1
        return {"count": count}
    except Exception as err:
        print(f"[apollo] Failed to decrypt vault: {err}")
        return {"count": 0}


def set(key: str, value: str) -> None:
    """Store a secret. Encrypts and persists to disk immediately, and sets
    os.environ so the value is available for the rest of this process."""
    master_key = _ensure_master_key()

    # Update in-memory cache + os.environ
    _cache[key] = value
    os.environ[key] = value

    # Read existing vault, merge, re-encrypt, write
    vault_path = _apollo_dir() / VAULT_FILE
    existing: dict[str, str] = {}
    if vault_path.exists():
        try:
            existing = _decrypt(vault_path.read_bytes(), master_key)
        except Exception:
            # Corrupted vault; start fresh with current cache
            existing = {}

    merged = {**existing, **_cache}
    encrypted = _encrypt(merged, master_key)

    _apollo_dir().mkdir(parents=True, exist_ok=True)
    vault_path.write_bytes(encrypted)


def remove(key: str) -> None:
    """Remove a secret from the vault and os.environ."""
    _cache.pop(key, None)
    os.environ.pop(key, None)

    master_key = _resolve_master_key()
    if not master_key:
        return

    vault_path = _apollo_dir() / VAULT_FILE
    if not vault_path.exists():
        return

    try:
        existing = _decrypt(vault_path.read_bytes(), master_key)
        existing.pop(key, None)
        vault_path.write_bytes(_encrypt(existing, master_key))
    except Exception:
        # If vault is corrupted, removing is best-effort
        pass


def get(key: str) -> str | None:
    """Get a secret value from the in-memory cache. Does NOT read from disk;
    call load() first. Returns None if not found."""
    return _cache.get(key)


def list_keys() -> list[str]:
    """List all secret keys (not values) currently in the cache."""
    return list(_cache.keys())


def has(key: str) -> bool:
    """Check if a specific secret is configured (has a value)."""
    return key in _cache or bool(os.environ.get(key))


def mask(value: str) -> str:
    """Mask a secret value for safe display (first 4 + last 4 chars)."""
    if not value:
        return ""
    if len(value) <= 8:
        return "••••••••"
    return f"{value[:4]}••••{value[-4:]}"


# ---------------------------------------------------------------------------
# Master key + salt management
# ---------------------------------------------------------------------------


def _apollo_dir() -> Path:
    return _project_root / APOLLO_DIR


def _resolve_master_key() -> str | None:
    """Resolve the master key. Priority:
    1. APOLLO_MASTER_KEY env var (for production / CI)
    2. .apollo/master.key file (for local dev, auto-generated)
    Returns None if neither exists (first-time setup not triggered yet)."""
    env = os.environ.get("APOLLO_MASTER_KEY")
    if env:
        return env

    key_path = _apollo_dir() / MASTER_KEY_FILE
    if key_path.exists():
        return key_path.read_text(encoding="utf-8").strip()

    return None


def _ensure_master_key() -> str:
    """Ensure a master key exists. If none is set, auto-generate one and write
    it to .apollo/master.key. This only happens once per machine."""
    existing = _resolve_master_key()
    if existing:
        return existing

    generated = secrets.token_hex(32)
    apollo_dir = _apollo_dir()
    apollo_dir.mkdir(parents=True, exist_ok=True)
    key_path = apollo_dir / MASTER_KEY_FILE
    key_path.write_text(generated + "\n", encoding="utf-8")
    key_path.chmod(0o600)  # owner-only read/write

    print("[apollo] Generated master key at .apollo/master.key (local-only, gitignored)")
    return generated


def _resolve_salt() -> bytes:
    """Resolve the key-derivation salt. Returns the per-install random salt from
    .apollo/salt if present, else the legacy fixed salt so vaults encrypted
    before per-install salts still decrypt. Read-only (no side effects)."""
    salt_path = _apollo_dir() / SALT_FILE
    if salt_path.exists():
        return salt_path.read_bytes()
    return LEGACY_SALT


def _ensure_salt() -> bytes:
    """Ensure a per-install salt exists, generating and persisting a random one
    on first use (mode 0600). Used by the encrypt (write) path."""
    salt_path = _apollo_dir() / SALT_FILE
    if salt_path.exists():
        return salt_path.read_bytes()
    salt = secrets.token_bytes(SALT_LEN)
    _apollo_dir().mkdir(parents=True, exist_ok=True)
    salt_path.write_bytes(salt)
    salt_path.chmod(0o600)
    return salt
