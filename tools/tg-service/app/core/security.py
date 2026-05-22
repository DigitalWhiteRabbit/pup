from __future__ import annotations

import base64
import hmac
import os
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.config import settings

_NONCE_LEN = 12


def _master_key() -> bytes:
    raw = settings.pup_secret
    if not raw:
        raise RuntimeError("PUP_SECRET is not set — cannot perform encryption")
    key = base64.b64decode(raw)
    if len(key) != 32:
        raise RuntimeError(f"PUP_SECRET must decode to exactly 32 bytes, got {len(key)}")
    return key


def encrypt_bytes(data: bytes) -> bytes:
    key = _master_key()
    nonce = os.urandom(_NONCE_LEN)
    ciphertext = AESGCM(key).encrypt(nonce, data, None)
    return nonce + ciphertext  # nonce(12) + ciphertext + tag(16 appended by AESGCM)


def decrypt_bytes(encrypted: bytes) -> bytes:
    if len(encrypted) < _NONCE_LEN + 16:
        raise ValueError("Encrypted payload too short")
    key = _master_key()
    nonce = encrypted[:_NONCE_LEN]
    ciphertext = encrypted[_NONCE_LEN:]
    return AESGCM(key).decrypt(nonce, ciphertext, None)


def encrypt_session_file(path: Path) -> Path:
    data = path.read_bytes()
    encrypted = encrypt_bytes(data)
    enc_path = path.with_suffix(path.suffix + ".enc")
    enc_path.write_bytes(encrypted)
    path.unlink()
    return enc_path


def decrypt_session_file(encrypted_path: Path) -> bytes:
    return decrypt_bytes(encrypted_path.read_bytes())


def verify_admin_token(token: str) -> bool:
    return hmac.compare_digest(token, settings.admin_token)
